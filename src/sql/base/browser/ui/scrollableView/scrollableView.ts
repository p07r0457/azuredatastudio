/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./scrollableView';

import { RangeMap } from 'vs/base/browser/ui/list/rangeMap';
import { SmoothScrollableElement } from 'vs/base/browser/ui/scrollbar/scrollableElement';
import { Scrollable, ScrollbarVisibility, INewScrollDimensions, ScrollEvent } from 'vs/base/common/scrollable';
import { getOrDefault } from 'vs/base/common/objects';
import * as DOM from 'vs/base/browser/dom';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { domEvent } from 'vs/base/browser/event';
import { Event } from 'vs/base/common/event';
import { Range, IRange } from 'vs/base/common/range';
import { clamp } from 'vs/base/common/numbers';

export interface IScrollableViewOptions {
	useShadows?: boolean;
	smoothScrolling?: boolean;
	verticalScrollMode?: ScrollbarVisibility;
	additionalScrollHeight?: number;
}

const DefaultOptions: IScrollableViewOptions = {
	useShadows: true,
	verticalScrollMode: ScrollbarVisibility.Auto
};

export interface IView {
	layout(height: number, width: number): void;
	readonly onDidMinOrMaxHeightChange: Event<number>;
	readonly element: HTMLElement;
	readonly minHeight: number;
	readonly maxHeight: number;
	onDidInsert?(): void;
	onDidRemove?(): void;
}

interface IItem {
	readonly view: IView;
	size: number;
	domNode?: HTMLElement;
	onDidInsertDisposable?: IDisposable; // I don't trust the children
	onDidRemoveDisposable?: IDisposable; // I don't trust the children
}

export class ScrollableView extends Disposable {
	private readonly rangeMap = new RangeMap();
	private readonly scrollableElement: SmoothScrollableElement;
	private readonly scrollable: Scrollable;
	private readonly viewContainer = DOM.$('div.scrollable-view-container');
	private readonly domNode = DOM.$('div.scrollable-view');

	private scrollableElementUpdateDisposable?: IDisposable;
	private additionalScrollHeight: number;
	private _scrollHeight = 0;
	private renderHeight = 0;
	private lastRenderTop = 0;
	private lastRenderHeight = 0;
	private readonly items: IItem[] = [];

	private width: number = 0;

	get contentHeight(): number { return this.rangeMap.size; }
	get onDidScroll(): Event<ScrollEvent> { return this.scrollableElement.onScroll; }
	get length(): number { return this.items.length; }

	constructor(container: HTMLElement, options: IScrollableViewOptions = DefaultOptions) {
		super();

		this.additionalScrollHeight = typeof options.additionalScrollHeight === 'undefined' ? 0 : options.additionalScrollHeight;

		this.scrollable = new Scrollable(getOrDefault(options, o => o.smoothScrolling, false) ? 125 : 0, cb => DOM.scheduleAtNextAnimationFrame(cb));
		this.scrollableElement = this._register(new SmoothScrollableElement(this.viewContainer, {
			alwaysConsumeMouseWheel: true,
			horizontal: ScrollbarVisibility.Hidden,
			vertical: getOrDefault(options, o => o.verticalScrollMode, DefaultOptions.verticalScrollMode),
			useShadows: getOrDefault(options, o => o.useShadows, DefaultOptions.useShadows),
		}, this.scrollable));
		this.domNode.appendChild(this.scrollableElement.getDomNode());
		container.appendChild(this.domNode);

		this._register(Event.debounce(this.scrollableElement.onScroll, (l, e) => e, 25)(this.onScroll, this));

		// Prevent the monaco-scrollable-element from scrolling
		// https://github.com/Microsoft/vscode/issues/44181
		this._register(domEvent(this.scrollableElement.getDomNode(), 'scroll')
			(e => (e.target as HTMLElement).scrollTop = 0));
	}

	elementTop(index: number): number {
		return this.rangeMap.positionAt(index);
	}

	layout(height?: number, width?: number): void {
		let scrollDimensions: INewScrollDimensions = {
			height: typeof height === 'number' ? height : DOM.getContentHeight(this.domNode)
		};

		this.renderHeight = scrollDimensions.height;

		this.width = width ?? DOM.getContentWidth(this.domNode);

		this.calculateItemHeights();

		if (this.scrollableElementUpdateDisposable) {
			this.scrollableElementUpdateDisposable.dispose();
			this.scrollableElementUpdateDisposable = null;
			scrollDimensions.scrollHeight = this.scrollHeight;
		}

		this.scrollableElement.setScrollDimensions(scrollDimensions);
	}

	setScrollTop(scrollTop: number): void {
		if (this.scrollableElementUpdateDisposable) {
			this.scrollableElementUpdateDisposable.dispose();
			this.scrollableElementUpdateDisposable = null;
			this.scrollableElement.setScrollDimensions({ scrollHeight: this.scrollHeight });
		}

		this.scrollableElement.setScrollPosition({ scrollTop });
	}

	public addViews(views: IView[], index = 0): void {
		const items = views.map(view => ({ size: 0, view }));

		// calculate heights
		this.items.splice(index, 0, ...items);
		this.calculateItemHeights();
		this.lastRenderTop = 0;
		this.lastRenderHeight = 0; // this could be optimized
		const previousRenderRange = this.getRenderRange(this.lastRenderTop, this.lastRenderHeight);
		this.render(previousRenderRange, this.lastRenderTop, this.lastRenderHeight, true);

		this.eventuallyUpdateScrollDimensions();
	}

	public addView(view: IView, index = 0): void {
		this.addViews([view]);
	}

	public removeView(index: number): void {
		const item = this.items.splice(index, 1)[0];
		if (item.domNode) {
			DOM.clearNode(item.domNode);
			DOM.removeNode(item.domNode);
			item.domNode = undefined;
		}
		this.calculateItemHeights();
		this.lastRenderTop = 0;
		this.lastRenderHeight = 0; // this could be optimized
		const previousRenderRange = this.getRenderRange(this.lastRenderTop, this.lastRenderHeight);
		this.render(previousRenderRange, this.lastRenderTop, this.lastRenderHeight, true);

		this.eventuallyUpdateScrollDimensions();
	}

	private calculateItemHeights() {
		const totalMin = this.items.reduce((p, c) => p + c.view.minHeight, 0);
		if (totalMin > this.renderHeight) { // the items will fill the render height, so just use min heights
			this.items.map(i => i.size = i.view.minHeight);
		} else {
			// try to even distribute
			let renderHeightRemaining = this.renderHeight;
			this.items.forEach((item, index) => {
				const desiredheight = renderHeightRemaining / (this.items.length - index);
				item.size = clamp(desiredheight, item.view.minHeight, item.view.maxHeight);
				renderHeightRemaining -= item.size;
			});
		}
		this.rangeMap.splice(0, this.rangeMap.count, this.items); // this could be optimized
	}

	get scrollHeight(): number {
		return this._scrollHeight + this.additionalScrollHeight;
	}

	private onScroll(e: ScrollEvent): void {
		try {
			const previousRenderRange = this.getRenderRange(this.lastRenderTop, this.lastRenderHeight);
			this.render(previousRenderRange, e.scrollTop, e.height);
		} catch (err) {
			throw err;
		}
	}

	private getRenderRange(renderTop: number, renderHeight: number): IRange {
		return {
			start: this.rangeMap.indexAt(renderTop),
			end: this.rangeMap.indexAfter(renderTop + renderHeight - 1)
		};
	}


	// Render

	private render(previousRenderRange: IRange, renderTop: number, renderHeight: number, updateItemsInDOM: boolean = false): void {
		const renderRange = this.getRenderRange(renderTop, renderHeight);

		const rangesToInsert = Range.relativeComplement(renderRange, previousRenderRange);
		const rangesToRemove = Range.relativeComplement(previousRenderRange, renderRange);
		const beforeElement = this.getNextToLastElement(rangesToInsert);

		if (updateItemsInDOM) {
			const rangesToUpdate = Range.intersect(previousRenderRange, renderRange);

			for (let i = rangesToUpdate.start; i < rangesToUpdate.end; i++) {
				this.updateItemInDOM(this.items[i], i);
			}
		}

		for (const range of rangesToInsert) {
			for (let i = range.start; i < range.end; i++) {
				this.insertItemInDOM(i, beforeElement);
			}
		}

		for (const range of rangesToRemove) {
			for (let i = range.start; i < range.end; i++) {
				this.removeItemFromDOM(i);
			}
		}

		this.viewContainer.style.top = `-${renderTop}px`;

		this.lastRenderTop = renderTop;
		this.lastRenderHeight = renderHeight;
	}

	// DOM operations

	private insertItemInDOM(index: number, beforeElement: HTMLElement | null): void {
		const item = this.items[index];

		if (!item.domNode) {
			item.domNode = DOM.$('div.scrollable-view-child');
			item.domNode.appendChild(item.view.element);
		}

		if (!item.domNode!.parentElement) {
			if (beforeElement) {
				this.viewContainer.insertBefore(item.domNode!, beforeElement);
			} else {
				this.viewContainer.appendChild(item.domNode!);
			}
		}

		this.updateItemInDOM(item, index);

		item.onDidRemoveDisposable?.dispose();
		item.onDidInsertDisposable = DOM.scheduleAtNextAnimationFrame(() => {
			// we don't trust the items to be performant so don't interrupt our operations
			if (item.view.onDidInsert) {
				item.view.onDidInsert();
			}
			item.view.layout(item.size, this.width);
		});
	}

	private updateItemInDOM(item: IItem, index: number): void {
		item.domNode!.style.top = `${this.elementTop(index)}px`;
		item.domNode!.style.width = `${this.width}px`;
		item.domNode!.style.height = `${item.size}px`;
	}

	private removeItemFromDOM(index: number): void {
		const item = this.items[index];

		item.domNode.remove();
		item.onDidInsertDisposable?.dispose();
		if (item.view.onDidRemove) {
			item.onDidRemoveDisposable = DOM.scheduleAtNextAnimationFrame(() => {
				// we don't trust the items to be performant so don't interrupt our
				item.view.onDidRemove();
			});
		}
	}

	private getNextToLastElement(ranges: IRange[]): HTMLElement | null {
		const lastRange = ranges[ranges.length - 1];

		if (!lastRange) {
			return null;
		}

		const nextToLastItem = this.items[lastRange.end];

		if (!nextToLastItem) {
			return null;
		}

		return nextToLastItem.domNode;
	}

	private eventuallyUpdateScrollDimensions(): void {
		this._scrollHeight = this.contentHeight;
		this.viewContainer.style.height = `${this._scrollHeight}px`;

		if (!this.scrollableElementUpdateDisposable) {
			this.scrollableElementUpdateDisposable = DOM.scheduleAtNextAnimationFrame(() => {
				this.scrollableElement.setScrollDimensions({ scrollHeight: this.scrollHeight });
				this.scrollableElementUpdateDisposable = null;
			});
		}
	}
}

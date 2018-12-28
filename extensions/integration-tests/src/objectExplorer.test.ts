/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'mocha';
import * as sqlops from 'sqlops';
import { context } from './testContext';
import { waitForCompletion, connectToServer } from './utils';
import assert = require('assert');

if (context.RunTest) {
	suite('Object Explorer test suite', () => {
		test('context menu test', async function () {
			await connectToServer();
			let nodes = <sqlops.objectexplorer.ObjectExplorerNode[]>await waitForCompletion(sqlops.objectexplorer.getActiveConnectionNodes());
			assert(nodes.length === 1, `expecting 1 active connection, actual: ${nodes.length}`);
			let actions = await waitForCompletion(sqlops.objectexplorer.getNodeActions(nodes[0].connectionId, nodes[0].nodePath))
			const expectedActions = ['Manage', 'New Query', 'Disconnect', 'Delete Connection', 'Refresh', 'Launch Profiler'];

			const expectedString = expectedActions.join(',');
			const actualString = actions.join(',');
			assert(expectedActions.length === actions.length && expectedString === actualString, `Expected actions: "${expectedString}", Actual actions: "${actualString}"`);
		});
	});
}

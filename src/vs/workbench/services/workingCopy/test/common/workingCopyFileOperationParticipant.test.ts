/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileOperation } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { WorkingCopyFileOperationParticipant } from '../../common/workingCopyFileOperationParticipant.js';

suite('WorkingCopyFileOperationParticipant', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('explicit isolation skips all registered participants', async () => {
		const configuration = new TestConfigurationService({ 'files.participants.timeout': 1000 });
		store.add(configuration.onDidChangeConfigurationEmitter);
		const dispatcher = store.add(new WorkingCopyFileOperationParticipant(store.add(new NullLogService()), configuration));
		const calls: number[] = [];
		for (const index of [1, 2]) {
			store.add(dispatcher.addFileOperationParticipant({ participate: async () => { calls.push(index); } }));
		}
		await dispatcher.participate([{ source: URI.file('/project/before.txt'), target: URI.file('/project/after.txt') }], FileOperation.MOVE, { skipParticipants: true }, CancellationToken.None);
		assert.deepStrictEqual(calls, []);
	});

	test('ordinary operations and an explicit false still invoke participants', async () => {
		const configuration = new TestConfigurationService({ 'files.participants.timeout': 1000 });
		store.add(configuration.onDidChangeConfigurationEmitter);
		const dispatcher = store.add(new WorkingCopyFileOperationParticipant(store.add(new NullLogService()), configuration));
		const calls: { operation: FileOperation; skipParticipants: boolean | undefined; timeout: number }[] = [];
		store.add(dispatcher.addFileOperationParticipant({ participate: async (_files, operation, info, timeout) => { calls.push({ operation, skipParticipants: info?.skipParticipants, timeout }); } }));
		const files = [{ target: URI.file('/project/new.txt') }];
		await dispatcher.participate(files, FileOperation.CREATE, undefined, CancellationToken.None);
		await dispatcher.participate(files, FileOperation.DELETE, { skipParticipants: false }, CancellationToken.None);
		assert.deepStrictEqual(calls, [
			{ operation: FileOperation.CREATE, skipParticipants: undefined, timeout: 1000 },
			{ operation: FileOperation.DELETE, skipParticipants: false, timeout: 1000 }
		]);
	});
});

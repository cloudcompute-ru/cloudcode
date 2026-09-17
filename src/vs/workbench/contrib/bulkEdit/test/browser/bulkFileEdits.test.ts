/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ResourceFileEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileContent, IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IUndoRedoService, IWorkspaceUndoRedoElement, UndoRedoElementType, UndoRedoGroup } from '../../../../../platform/undoRedo/common/undoRedo.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IFileOperationUndoRedoInfo, IWorkingCopyFileService } from '../../../../services/workingCopy/common/workingCopyFileService.js';
import { BulkFileEdits } from '../../browser/bulkFileEdits.js';

suite('BulkFileEdits participant isolation', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const oldResource = URI.file('/project/old.txt');
	const newResource = URI.file('/project/new.txt');
	const contents = VSBuffer.fromString('reviewed contents');

	for (const skipParticipants of [true, false]) {
		for (const operation of ['create', 'rename', 'delete', 'copy'] as const) {
			test(`${operation} preserves participant policy through apply, undo and redo (${skipParticipants})`, async () => {
				const calls: { operation: string; skipParticipants: boolean | undefined }[] = [];
				let undoElement: IWorkspaceUndoRedoElement | undefined;
				const record = (operation: string, info?: IFileOperationUndoRedoInfo) => { calls.push({ operation, skipParticipants: info?.skipParticipants }); };
				const stat = (resource: URI) => upcastPartial<IFileStatWithMetadata>({ resource, isFile: true, isDirectory: false, size: contents.byteLength });
				const fileService = upcastPartial<IFileService>({
					exists: async () => true,
					resolve: async resource => stat(resource),
					readFile: async resource => upcastPartial<IFileContent>({ ...stat(resource), value: contents }),
					hasCapability: () => false
				});
				const workingCopyFileService = upcastPartial<IWorkingCopyFileService>({
					create: async (operations, _token, info) => { if (operations.length) { record('create', info); } return operations.map(operation => stat(operation.resource)); },
					createFolder: async operations => { assert.strictEqual(operations.length, 0); return []; },
					move: async (operations, _token, info) => { record('rename', info); return operations.map(operation => stat(operation.file.target)); },
					copy: async (operations, _token, info) => { record('copy', info); return operations.map(operation => stat(operation.file.target)); },
					delete: async (_operations, _token, info) => { record('delete', info); }
				});
				const undoRedoService = upcastPartial<IUndoRedoService>({
					pushElement: element => {
						if (element.type !== UndoRedoElementType.Workspace) { throw new Error('Expected a workspace undo element'); }
						undoElement = element;
					}
				});
				const instantiation = store.add(new InstantiationService(new ServiceCollection(
					[IFileService, fileService], [IWorkingCopyFileService, workingCopyFileService], [IUndoRedoService, undoRedoService],
					[IConfigurationService, upcastPartial<IConfigurationService>({})], [ITextFileService, upcastPartial<ITextFileService>({})],
					[ILogService, store.add(new NullLogService())]
				), true));
				const edit = operation === 'create' ? new ResourceFileEdit(undefined, newResource, { contents: Promise.resolve(contents) })
					: operation === 'delete' ? new ResourceFileEdit(oldResource, undefined)
						: new ResourceFileEdit(oldResource, newResource, { copy: operation === 'copy' });
				const bulk = instantiation.createInstance(BulkFileEdits, 'Reviewed task', 'test.task', new UndoRedoGroup(), undefined, false, { report: () => { } }, CancellationToken.None, [edit], skipParticipants);
				await bulk.apply();
				assert.ok(undoElement);
				await undoElement.undo();
				await undoElement.redo();
				const sequence = operation === 'rename' ? ['rename', 'rename', 'rename']
					: operation === 'delete' ? ['delete', 'create', 'delete'] : [operation, 'delete', 'create'];
				assert.deepStrictEqual(calls, sequence.map(operation => ({ operation, skipParticipants })));
			});
		}
	}
});

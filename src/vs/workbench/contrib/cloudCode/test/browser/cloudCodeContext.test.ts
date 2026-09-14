/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isEqualOrParent } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor, IDiffEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { EditorType } from '../../../../../editor/common/editorCommon.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileOperationError, FileOperationResult, IFileService, IFileStatWithPartialMetadata } from '../../../../../platform/files/common/files.js';
import { IWorkspace, IWorkspaceContextService, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IReadTextFileOptions, ITextFileContent, ITextFileService, TextFileOperationError, TextFileOperationResult } from '../../../../services/textfile/common/textfiles.js';
import { CloudCodeContext } from '../../browser/cloudCodeContext.js';
import { CLOUDCODE_MAX_ATTACHMENT_BYTES, CLOUDCODE_MAX_ATTACHMENTS } from '../../common/cloudCodeChatContext.js';

suite('CloudCodeContext', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const folder = toWorkspaceFolder(URI.file('/project'));
	const resource = URI.file('/project/src/example.ts');
	let context: CloudCodeContext;
	let trusted: boolean;
	let activeModel: ITextModel | null;
	let activeControl: ICodeEditor | IDiffEditor;
	let selection: Selection | null;
	let pickedFiles: URI[] | undefined;
	let diskContent: string;
	let diskSize: number;
	let diskIsFile: boolean;
	let readError: Error | undefined;
	let readResult: Promise<ITextFileContent> | undefined;
	let models: Map<string, ITextModel>;
	let reads: { resource: URI; options: IReadTextFileOptions | undefined }[];
	let stats: URI[];
	let dialogCalls: number;

	setup(() => {
		trusted = true;
		activeModel = null;
		selection = null;
		pickedFiles = [resource];
		diskContent = 'saved content';
		diskSize = diskContent.length;
		diskIsFile = true;
		readError = undefined;
		readResult = undefined;
		models = new Map();
		reads = [];
		stats = [];
		dialogCalls = 0;
		activeControl = upcastPartial<ICodeEditor>({
			getEditorType: () => EditorType.ICodeEditor,
			getModel: () => activeModel,
			getSelection: () => selection,
		});
		context = new CloudCodeContext(
			upcastPartial<IEditorService>({ get activeTextEditorControl() { return activeControl; } }),
			upcastPartial<IModelService>({ getModel: uri => models.get(uri.toString()) ?? null }),
			upcastPartial<ITextFileService>({ read: async (uri, options) => {
				reads.push({ resource: uri, options });
				if (readError) {
					throw readError;
				}
				return readResult ?? upcastPartial<ITextFileContent>({ value: diskContent });
			} }),
			upcastPartial<IFileService>({ stat: async uri => {
				stats.push(uri);
				return upcastPartial<IFileStatWithPartialMetadata>({ isFile: diskIsFile, size: diskSize });
			} }),
			upcastPartial<IFileDialogService>({ showOpenDialog: async () => {
				dialogCalls++;
				return pickedFiles;
			} }),
			upcastPartial<IWorkspaceContextService>({
				getWorkspaceFolder: uri => isEqualOrParent(uri, folder.uri) ? folder : null,
				getWorkspace: () => upcastPartial<IWorkspace>({ folders: [folder] }),
			}),
			upcastPartial<IWorkspaceTrustManagementService>({ isWorkspaceTrusted: () => trusted }),
		);
	});

	function openModel(content: string, uri: URI = resource): ITextModel {
		const model = disposables.add(createTextModel(content, 'typescript', undefined, uri));
		models.set(uri.toString(), model);
		activeModel = model;
		return model;
	}

	test('captures unsaved active buffers as immutable snapshots without reading disk', async () => {
		const model = openModel('unsaved content');
		const attachments = await context.readAttachments('file');
		model.setValue('changed after attachment');
		assert.deepStrictEqual({ attachments, reads, stats }, {
			attachments: [{ id: resource.toString(), label: 'src/example.ts', content: 'unsaved content', languageId: 'typescript' }],
			reads: [],
			stats: [],
		});
	});

	test('attaches a small selection from a large buffer with accurate line metadata', async () => {
		openModel(`first\nselected\n${'x'.repeat(CLOUDCODE_MAX_ATTACHMENT_BYTES)}`);
		selection = new Selection(2, 1, 3, 1);
		assert.deepStrictEqual(await context.readAttachments('selection'), [{
			id: `${resource.toString()}#2:1-3:1`, label: 'src/example.ts:2-2', content: 'selected\n', languageId: 'typescript', startLine: 2, endLine: 2,
		}]);
	});

	test('rejects missing editors and empty selections', async () => {
		await assert.rejects(context.readAttachments('file'), /Open a text file/);
		openModel('text');
		selection = new Selection(1, 1, 1, 1);
		await assert.rejects(context.readAttachments('selection'), /Select some code/);
	});

	test('rejects diff editors rather than silently choosing the modified side', async () => {
		activeControl = upcastPartial<IDiffEditor>({ getEditorType: () => EditorType.IDiffEditor });
		await assert.rejects(context.readAttachments('file'), /regular text editor/);
		await assert.rejects(context.readAttachments('selection'), /regular text editor/);
		assert.deepStrictEqual(reads, []);
	});

	test('supports explicitly attached untitled buffers and rejects unsupported URI schemes', async () => {
		openModel('new file', URI.parse('untitled:Untitled-1'));
		const attachments = await context.readAttachments('file');
		assert.deepStrictEqual(attachments.map(attachment => ({ label: attachment.label, content: attachment.content })), [{ label: 'Untitled-1', content: 'new file' }]);
		openModel('virtual text', URI.parse('https://example.com/file.txt'));
		await assert.rejects(context.readAttachments('file'), /Attach a local or remote text file/);
	});

	test('reads selected disk files with binary detection and byte limits', async () => {
		const external = URI.file('/outside/private/folder/notes.txt');
		pickedFiles = [external, external];
		assert.deepStrictEqual({ attachments: await context.readAttachments('files'), reads }, {
			attachments: [{ id: external.toString(), label: 'notes.txt', content: diskContent }],
			reads: [{ resource: external, options: { acceptTextOnly: true, limits: { size: CLOUDCODE_MAX_ATTACHMENT_BYTES } } }],
		});
	});

	test('prefers the unsaved model when selecting an already open file', async () => {
		openModel('unsaved content');
		assert.deepStrictEqual({ content: (await context.readAttachments('files'))[0].content, reads, stats }, { content: 'unsaved content', reads: [], stats: [] });
	});

	test('rejects directories, oversized files and unsupported schemes before reading', async () => {
		diskIsFile = false;
		await assert.rejects(context.readAttachments('files'), /not a text file/);
		diskIsFile = true;
		diskSize = CLOUDCODE_MAX_ATTACHMENT_BYTES + 1;
		await assert.rejects(context.readAttachments('files'), /exceeds the 16 KiB/);
		pickedFiles = [URI.parse('https://example.com/file.txt')];
		await assert.rejects(context.readAttachments('files'), /Attach a local or remote text file/);
		assert.deepStrictEqual(reads, []);
	});

	test('rejects binary files, file growth during reading and oversized UTF-8 content', async () => {
		readError = new TextFileOperationError('binary', TextFileOperationResult.FILE_IS_BINARY);
		await assert.rejects(context.readAttachments('files'), /contains binary data/);
		readError = new FileOperationError('grew', FileOperationResult.FILE_TOO_LARGE);
		await assert.rejects(context.readAttachments('files'), /exceeds the 16 KiB/);
		readError = undefined;
		openModel('界'.repeat(CLOUDCODE_MAX_ATTACHMENT_BYTES / 2));
		await assert.rejects(context.readAttachments('file'), /exceeds the 16 KiB/);
		activeModel!.setValue('text\0binary');
		await assert.rejects(context.readAttachments('file'), /contains binary data/);
	});

	test('caps file count before reading and rejects batches exceeding total bytes', async () => {
		pickedFiles = Array.from({ length: CLOUDCODE_MAX_ATTACHMENTS + 1 }, (_, index) => URI.file(`/project/${index}.txt`));
		await assert.rejects(context.readAttachments('files'), /Attach up to 5 files/);
		assert.deepStrictEqual(reads, []);
		pickedFiles = [resource, URI.file('/project/second.txt')];
		diskContent = 'x'.repeat(CLOUDCODE_MAX_ATTACHMENT_BYTES);
		diskSize = diskContent.length;
		await assert.rejects(context.readAttachments('files'), /Attachments must total 24 KiB or less/);
	});

	test('returns no attachments when the picker is cancelled', async () => {
		pickedFiles = undefined;
		assert.deepStrictEqual({ attachments: await context.readAttachments('files'), reads }, { attachments: [], reads: [] });
	});

	test('blocks untrusted workspaces before showing a file picker or reading buffers', async () => {
		openModel('private code');
		trusted = false;
		await assert.rejects(context.readAttachments('files'), /Trust this workspace/);
		await assert.rejects(context.readAttachments('file'), /Trust this workspace/);
		assert.deepStrictEqual({ reads, stats, dialogCalls }, { reads: [], stats: [], dialogCalls: 0 });
	});

	test('rechecks trust after asynchronous file reads', async () => {
		const deferred = new DeferredPromise<ITextFileContent>();
		readResult = deferred.p;
		const result = context.readAttachments('files');
		await Promise.resolve();
		await Promise.resolve();
		trusted = false;
		await deferred.complete(upcastPartial<ITextFileContent>({ value: 'private code' }));
		await assert.rejects(result, /Trust this workspace/);
	});
});

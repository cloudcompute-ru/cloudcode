/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILanguageSelection, ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IFileService, IFileStatWithPartialMetadata } from '../../../../../platform/files/common/files.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { ITextDiffEditorPane, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { CloudCodeEditWorkspace } from '../../browser/cloudCodeEditWorkspace.js';
import { ICloudCodeAttachment } from '../../common/cloudCodeChatContext.js';
import { ICloudCodeProposedEdit } from '../../common/cloudCodeEdits.js';

suite('CloudCodeEditWorkspace', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const resource = URI.file('/project/example.ts');
	let workspace: CloudCodeEditWorkspace;
	let model: ITextModel;
	let trusted: boolean;
	let modelReadonly: boolean;
	let configuredReadonly: boolean;
	let diskReadonly: boolean;
	let diskRevision: number;
	let releasedReferences: number;
	let resolveGate: Promise<void> | undefined;
	let openGate: Promise<void> | undefined;
	let statGate: Promise<void> | undefined;
	let opened: (IUntypedEditorInput | EditorInput)[];
	let previews: ITextModel[];

	setup(() => {
		model = disposables.add(createTextModel('before\nselected\nafter', 'typescript', undefined, resource));
		trusted = true;
		modelReadonly = false;
		configuredReadonly = false;
		diskReadonly = false;
		diskRevision = 1;
		releasedReferences = 0;
		resolveGate = undefined;
		openGate = undefined;
		statGate = undefined;
		opened = [];
		previews = [];
		workspace = disposables.add(new CloudCodeEditWorkspace(
			upcastPartial<ITextModelService>({
				registerTextModelContentProvider: () => Disposable.None,
				createModelReference: async () => {
					await resolveGate;
					return {
						object: upcastPartial<IResolvedTextEditorModel>({
							textEditorModel: model,
							isReadonly: () => modelReadonly,
							isDisposed: () => model.isDisposed(),
						}),
						dispose: () => { releasedReferences++; },
					};
				},
			}),
			upcastPartial<IModelService>({
				getModel: uri => uri.toString() === resource.toString() ? model : null,
				createModel: (value, _language, uri) => {
					assert.strictEqual(typeof value, 'string');
					const preview = createTextModel(value as string, 'typescript', undefined, uri);
					previews.push(preview);
					return preview;
				},
			}),
			upcastPartial<ILanguageService>({ createById: () => upcastPartial<ILanguageSelection>({ languageId: 'typescript' }) }),
			upcastPartial<IEditorService>({
				openEditor: async (editor: IUntypedEditorInput | EditorInput) => {
					opened.push(editor);
					await openGate;
					return upcastPartial<ITextDiffEditorPane>({});
				},
			}),
			upcastPartial<IFilesConfigurationService>({ isReadonly: () => configuredReadonly }),
			upcastPartial<IFileService>({
				stat: async () => {
					await statGate;
					return upcastPartial<IFileStatWithPartialMetadata>({ isFile: true, size: model.getValueLength(), readonly: diskReadonly, etag: String(diskRevision), mtime: diskRevision, ctime: 1 });
				},
			}),
			upcastPartial<IWorkspaceTrustManagementService>({ isWorkspaceTrusted: () => trusted }),
		));
	});

	function attachment(selection = false): ICloudCodeAttachment {
		return {
			id: 'attachment',
			resource: resource.toString(),
			label: 'example.ts',
			content: selection ? 'selected' : model.getValue(),
			...(selection ? { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 9 } } : {}),
		};
	}

	async function proposal(selection = false, replacement = 'updated'): Promise<ICloudCodeProposedEdit> {
		const [target] = await workspace.prepare([attachment(selection)]);
		return { target, replacement };
	}

	test('previews the full unsaved file and applies only the selection in a separate undo step', async () => {
		const edit = await proposal(true);
		await workspace.preview(edit);
		assert.deepStrictEqual({ file: model.getValue(), previews: previews.map(preview => preview.getValue()), releasedReferences }, {
			file: 'before\nselected\nafter',
			previews: ['before\nselected\nafter', 'before\nupdated\nafter'],
			releasedReferences: 0,
		});
		await workspace.apply(edit);
		assert.strictEqual(model.getValue(), 'before\nupdated\nafter');
		await model.undo();
		assert.strictEqual(model.getValue(), 'before\nselected\nafter');
	});

	test('normalizes proposed line endings to the current buffer and supports replacing the full file', async () => {
		model.setValue('first\r\nsecond');
		const edit = await proposal(false, 'new\nlines');
		await workspace.preview(edit);
		await workspace.apply(edit);
		assert.strictEqual(model.getValue(), 'new\r\nlines');
		await model.undo();
		assert.strictEqual(model.getValue(), 'first\r\nsecond');
	});

	test('requires successful preview and prevents applying a proposal twice', async () => {
		const edit = await proposal();
		await assert.rejects(workspace.apply(edit), /Preview this proposal/);
		await workspace.preview(edit);
		await workspace.apply(edit);
		await assert.rejects(workspace.apply(edit), /no longer available/);
	});

	test('rejects changed attachments and releases references on failure', async () => {
		const snapshot = attachment();
		model.setValue('changed');
		await assert.rejects(workspace.prepare([snapshot]), /file changed/);
		assert.strictEqual(releasedReferences, 1);
	});

	test('rejects changed text outside the selected range instead of overwriting concurrent edits', async () => {
		const edit = await proposal(true);
		await workspace.preview(edit);
		model.setValue('user change\nselected\nafter');
		await assert.rejects(workspace.apply(edit), /file changed/);
		assert.strictEqual(model.getValue(), 'user change\nselected\nafter');
	});

	test('rejects duplicate file attachments and arbitrary resource schemes', async () => {
		await assert.rejects(workspace.prepare([attachment(), attachment(true)]), /each file only once/);
		await assert.rejects(workspace.prepare([{ ...attachment(), resource: 'https://example.com/file.ts' }]), /only for attached/);
		assert.strictEqual(releasedReferences, 1);
	});

	test('rejects readonly models, configured files, and freshly reported disk permissions', async () => {
		modelReadonly = true;
		await assert.rejects(workspace.prepare([attachment()]), /read-only/);
		modelReadonly = false;
		const edit = await proposal();
		await workspace.preview(edit);
		configuredReadonly = true;
		await assert.rejects(workspace.apply(edit), /read-only/);
		configuredReadonly = false;
		diskReadonly = true;
		await assert.rejects(workspace.apply(edit), /read-only/);
		assert.strictEqual(model.getValue(), 'before\nselected\nafter');
	});

	test('blocks revoked workspace trust before mutation after awaiting the editor', async () => {
		const edit = await proposal();
		await workspace.preview(edit);
		const deferred = new DeferredPromise<void>();
		openGate = deferred.p;
		const applying = workspace.apply(edit);
		trusted = false;
		await deferred.complete();
		await assert.rejects(applying, /Trust this workspace/);
		assert.strictEqual(model.getValue(), 'before\nselected\nafter');
	});

	test('checks the baseline again after asynchronous file permission checks', async () => {
		const edit = await proposal();
		await workspace.preview(edit);
		const deferred = new DeferredPromise<void>();
		statGate = deferred.p;
		const applying = workspace.apply(edit);
		await Promise.resolve();
		await Promise.resolve();
		model.setValue('edited while checking');
		await deferred.complete();
		await assert.rejects(applying, /file changed/);
		assert.strictEqual(model.getValue(), 'edited while checking');
	});

	test('clearing a conversation invalidates in-flight application and disposes preview snapshots', async () => {
		const edit = await proposal();
		await workspace.preview(edit);
		const deferred = new DeferredPromise<void>();
		openGate = deferred.p;
		const applying = workspace.apply(edit);
		workspace.clear();
		await deferred.complete();
		await assert.rejects(applying, /no longer available/);
		assert.deepStrictEqual({ content: model.getValue(), releasedReferences, disposed: previews.map(preview => preview.isDisposed()) }, {
			content: 'before\nselected\nafter', releasedReferences: 1, disposed: [true, true],
		});
	});

	test('clearing during model resolution disposes the late reference', async () => {
		const deferred = new DeferredPromise<void>();
		resolveGate = deferred.p;
		const preparing = workspace.prepare([attachment()]);
		await Promise.resolve();
		await Promise.resolve();
		workspace.clear();
		await deferred.complete();
		await assert.rejects(preparing, /no longer available/);
		assert.strictEqual(releasedReferences, 1);
	});

	test('rejects fabricated target objects even when they copy an existing token', async () => {
		const edit = await proposal();
		await assert.rejects(workspace.preview({ ...edit, target: { ...edit.target } }), /no longer available/);
		assert.deepStrictEqual(opened, []);
	});

	test('rejects external disk changes before the retained model receives a file watcher update', async () => {
		const edit = await proposal(true);
		await workspace.preview(edit);
		diskRevision++;
		await assert.rejects(workspace.apply(edit), /file changed/);
		assert.strictEqual(model.getValue(), 'before\nselected\nafter');
	});

	test('enforces the replacement byte limit after expanding line endings', async () => {
		model.setValue('before\r\nselected\r\nafter');
		const edit = await proposal(true, '\n'.repeat(17 * 1024));
		await assert.rejects(workspace.preview(edit), /exceeds 32 KiB with this file's line endings/);
		assert.deepStrictEqual(previews, []);
	});

	test('caps the full baseline for selections and rejects binary or oversized replacements', async () => {
		model.setValue('x'.repeat(1024 * 1024 + 1));
		await assert.rejects(workspace.prepare([attachment(true)]), /up to 1 MiB/);
		model.setValue('before\nselected\nafter');
		const edit = await proposal();
		await assert.rejects(workspace.preview({ ...edit, replacement: 'x'.repeat(32 * 1024 + 1) }), /no larger than 32 KiB/);
		await assert.rejects(workspace.preview({ ...edit, replacement: 'text\0binary' }), /no larger than 32 KiB/);
	});
});

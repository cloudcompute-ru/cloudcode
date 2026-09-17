/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { VSBuffer, bufferToReadable } from '../../../../../base/common/buffer.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { extUriIgnorePathCase, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBulkEditOptions, IBulkEditService, ResourceEdit, ResourceFileEdit, ResourceTextEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { ILanguageSelection, ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { FileOperationError, FileOperationResult, IFileService, IFileStatWithPartialMetadata } from '../../../../../platform/files/common/files.js';
import { IUndoRedoElement, IUndoRedoService, UndoRedoElementType } from '../../../../../platform/undoRedo/common/undoRedo.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { ITextDiffEditorPane, IResourceMultiDiffEditorInput, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { ITextFileContent, ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { CloudCodeEditingWorkspace } from '../../browser/cloudCodeEditingWorkspace.js';
import { ICloudCodeAgentWorkspaceSession } from '../../common/cloudCodeAgent.js';
import { ICloudCodeSessionChange } from '../../common/cloudCodeEditingSession.js';

suite('CloudCodeEditingWorkspace', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const root = URI.file('/project');
	let workspace: CloudCodeEditingWorkspace;
	let files: Map<string, string>;
	let models: Map<string, ITextModel>;
	let revisions: Map<string, number>;
	let dirty: Set<string>;
	let lastElements: Map<string, IUndoRedoElement>;
	let opened: (IUntypedEditorInput | EditorInput)[];
	let previews: ITextModel[];
	let applications: { edits: ResourceEdit[]; options?: IBulkEditOptions }[];
	let trusted: boolean;
	let readonly: boolean;
	let failNativeApply: boolean;
	let partialNativeUndo: boolean;
	let ignoreAfterApply: boolean;
	let ignored: boolean;
	let undoCalls: number;
	let releasedReferences: number;
	let undoSnapshot: { files: Map<string, string>; models: Map<string, string>; dirty: Set<string> } | undefined;

	function addFile(path: string, diskContent = 'saved', bufferContent = diskContent): ITextModel {
		const uri = URI.joinPath(root, path);
		files.set(uri.toString(), diskContent);
		revisions.set(uri.toString(), 1);
		const model = disposables.add(createTextModel(bufferContent, 'typescript', undefined, uri));
		models.set(uri.toString(), model);
		if (diskContent !== bufferContent) {
			dirty.add(uri.toString());
		}
		return model;
	}

	setup(() => {
		files = new Map();
		models = new Map();
		revisions = new Map();
		dirty = new Set();
		lastElements = new Map();
		opened = [];
		previews = [];
		applications = [];
		trusted = true;
		readonly = false;
		failNativeApply = false;
		partialNativeUndo = false;
		ignoreAfterApply = false;
		ignored = false;
		undoCalls = 0;
		releasedReferences = 0;
		undoSnapshot = undefined;
		const assertValid = () => {
			if (!trusted) {
				throw new Error('Trust this workspace');
			}
		};
		const session = upcastPartial<ICloudCodeAgentWorkspaceSession>({
			roots: [{ id: '1', name: 'project' }],
			assertValid,
			resolveReference: value => {
				const path = relativePath(root, URI.parse(value));
				return path && !path.startsWith('../') ? { root: '1', path } : undefined;
			},
			authorizeEditPath: async (rootId, path, _token, requireSearchEligibility = true) => {
				assertValid();
				assert.strictEqual(rootId, '1');
				const resource = URI.joinPath(root, path).toString();
				if (ignored && requireSearchEligibility && files.has(resource)) { throw new Error('Excluded from search'); }
				return { resource, exists: files.has(resource) };
			},
			dispose: () => { },
		});
		workspace = disposables.add(new CloudCodeEditingWorkspace(session,
			upcastPartial<ITextModelService>({
				registerTextModelContentProvider: () => Disposable.None,
				createModelReference: async uri => {
					const model = models.get(uri.toString());
					assert.ok(model, `Expected a model for ${uri}`);
					return {
						object: upcastPartial<IResolvedTextEditorModel>({ textEditorModel: model, isReadonly: () => readonly, isDisposed: () => model.isDisposed() }),
						dispose: () => { releasedReferences++; },
					};
				},
			}),
			upcastPartial<IModelService>({
				getModel: uri => models.get(uri.toString()) ?? null,
				createModel: (value, _language, uri) => {
					assert.strictEqual(typeof value, 'string');
					const model = createTextModel(value as string, 'typescript', undefined, uri);
					previews.push(model);
					return model;
				},
			}),
			upcastPartial<ILanguageService>({ createById: () => upcastPartial<ILanguageSelection>({ languageId: 'typescript' }) }),
			upcastPartial<IEditorService>({ openEditor: async editor => { opened.push(editor); return upcastPartial<ITextDiffEditorPane>({}); } }),
			upcastPartial<IFilesConfigurationService>({ isReadonly: () => readonly }),
			upcastPartial<IFileService>({
				exists: async uri => files.has(uri.toString()),
				stat: async uri => {
					const key = uri.toString();
					const content = files.get(key);
					const isDirectory = key === root.toString() || [...files.keys()].some(path => path.startsWith(key + '/'));
					if (content === undefined && !isDirectory) {
						throw new FileOperationError('File not found', FileOperationResult.FILE_NOT_FOUND);
					}
					const revision = revisions.get(key) ?? 1;
					return upcastPartial<IFileStatWithPartialMetadata>({ resource: uri, isFile: content !== undefined, isDirectory, isSymbolicLink: false, readonly, size: content?.length ?? 0, etag: String(revision), mtime: revision, ctime: 1 });
				},
				canCreateFile: async uri => files.has(uri.toString()) ? new Error('File already exists') : true,
				canMove: async (_from, to) => files.has(to.toString()) ? new Error('File already exists') : true,
				canDelete: async () => true,
			}),
			upcastPartial<IUriIdentityService>({ extUri: extUriIgnorePathCase, asCanonicalUri: uri => uri }),
			upcastPartial<IBulkEditService>({ apply: async (edit, options) => {
				assert.ok(Array.isArray(edit));
				applications.push({ edits: edit, options });
				undoSnapshot = { files: new Map(files), models: new Map([...models].map(([uri, model]) => [uri, model.getValue()])), dirty: new Set(dirty) };
				for (const item of edit) {
					if (item instanceof ResourceTextEdit) {
						const model = models.get(item.resource.toString());
						assert.ok(model);
						assert.strictEqual(item.versionId, model.getVersionId());
						model.applyEdits([{ range: item.textEdit.range, text: item.textEdit.text }]);
						dirty.add(item.resource.toString());
					} else if (item instanceof ResourceFileEdit) {
						if (item.newResource && !item.oldResource) {
							const value = await item.options.contents;
							addFile(relativePath(root, item.newResource)!, value?.toString() ?? '');
						} else if (item.oldResource && item.newResource) {
							const oldKey = item.oldResource.toString();
							addFile(relativePath(root, item.newResource)!, files.get(oldKey)!, models.get(oldKey)?.getValue());
							files.delete(oldKey);
							models.delete(oldKey);
							dirty.delete(oldKey);
						} else if (item.oldResource) {
							files.delete(item.oldResource.toString());
							models.delete(item.oldResource.toString());
							dirty.delete(item.oldResource.toString());
						}
					}
					if (failNativeApply) {
						throw new Error('Native operation failed after the first edit');
					}
				}
				for (const uri of new Set([...files.keys(), ...undoSnapshot.files.keys()])) {
					lastElements.set(uri, { type: UndoRedoElementType.Resource, resource: URI.parse(uri), label: 'Task edit', code: options?.code ?? '', undo: () => { }, redo: () => { } });
				}
				ignored = ignoreAfterApply;
				return { isApplied: true, ariaSummary: 'Applied' };
			} }),
			upcastPartial<IUndoRedoService>({
				getLastElement: uri => lastElements.get(uri.toString()) ?? null,
				canUndo: () => !!undoSnapshot,
				undo: async () => {
					undoCalls++;
					assert.ok(undoSnapshot);
					files = new Map(undoSnapshot.files);
					dirty = new Set(undoSnapshot.dirty);
					for (const uri of models.keys()) {
						if (!undoSnapshot.models.has(uri)) {
							models.delete(uri);
						}
					}
					for (const [uri, text] of undoSnapshot.models) {
						const model = models.get(uri);
						if (model) {
							model.setValue(text);
						} else {
							addFile(relativePath(root, URI.parse(uri))!, files.get(uri), text);
						}
						if (partialNativeUndo) {
							break;
						}
					}
				},
			}),
			upcastPartial<ITextFileService>({
				isDirty: uri => dirty.has(uri.toString()),
				getEncoding: () => 'utf8',
				getEncodedReadable: async (_uri, value) => bufferToReadable(VSBuffer.fromString(value as string)),
				read: async uri => upcastPartial<ITextFileContent>({ value: files.get(uri.toString())!, encoding: 'utf8' }),
			}),
			upcastPartial<IWorkspaceContextService>({ getWorkspace: () => upcastPartial<IWorkspace>({ folders: [toWorkspaceFolder(root)] }) }),
		));
	});

	async function change(path: string, replacement: string | undefined, newPath = path): Promise<ICloudCodeSessionChange> {
		const before = await workspace.read('1', path, CancellationToken.None);
		const destination = newPath === path ? before : await workspace.read('1', newPath, CancellationToken.None);
		return {
			kind: before.content === undefined ? 'create' : replacement === undefined ? 'delete' : newPath !== path ? 'rename' : 'edit',
			before,
			after: { ...destination, content: replacement },
		};
	}

	test('previews one combined diff from unsaved baselines and refreshes its identity for later revisions', async () => {
		addFile('first.ts', 'saved', 'unsaved first');
		addFile('second.ts', 'second');
		const changes = [await change('first.ts', 'updated'), await change('second.ts', undefined), await change('new.ts', 'created')];
		await workspace.preview(changes);
		await workspace.preview(changes);
		const inputs = opened as IResourceMultiDiffEditorInput[];
		assert.deepStrictEqual({
			lengths: inputs.map(input => input.resources?.length),
			freshIdentity: inputs[0].multiDiffSource?.toString() !== inputs[1].multiDiffSource?.toString(),
			text: previews.slice(0, 6).map(model => model.getValue()),
			saved: files.get(URI.joinPath(root, 'first.ts').toString()), applications: applications.length,
		}, { lengths: [3, 3], freshIdentity: true, text: ['unsaved first', 'updated', 'second', '', '', 'created'], saved: 'saved', applications: 0 });
	});

	test('applies multiple edits together with one native undo source and preserves pre-existing unsaved text', async () => {
		const first = addFile('first.ts', 'saved', 'user draft');
		const second = addFile('second.ts', 'second');
		const changes = [await change('first.ts', 'user draft plus agent'), await change('second.ts', 'second update')];
		await workspace.preview(changes);
		assert.strictEqual(await workspace.apply(changes), true);
		const afterApply = [first.getValue(), second.getValue()];
		await workspace.undo();
		assert.deepStrictEqual({ afterApply, afterUndo: [first.getValue(), second.getValue()], calls: applications.length, edits: applications[0].edits.length, source: !!applications[0].options?.undoRedoSource, undoCalls }, {
			afterApply: ['user draft plus agent', 'second update'], afterUndo: ['user draft', 'second'], calls: 1, edits: 2, source: true, undoCalls: 1,
		});
	});

	test('rejects deletion of dirty buffers before native operations can discard user text', async () => {
		const model = addFile('first.ts', 'saved', 'user draft');
		const changes = [await change('first.ts', undefined)];
		await workspace.preview(changes);
		await assert.rejects(workspace.apply(changes), /unsaved|dirty|save/i);
		assert.deepStrictEqual({ text: model.getValue(), calls: applications.length }, { text: 'user draft', calls: 0 });
	});

	test('applies and undoes a create, dirty rename and clean deletion in one native operation', async () => {
		addFile('renamed.ts', 'saved', 'user draft');
		addFile('removed.ts', 'remove this');
		const changes = [await change('new.ts', 'new content'), await change('renamed.ts', 'user draft plus agent', 'destination.ts'), await change('removed.ts', undefined)];
		await workspace.preview(changes);
		assert.strictEqual(await workspace.apply(changes), true);
		const afterApply = {
			files: [...files.keys()].map(uri => relativePath(root, URI.parse(uri))).sort(),
			rename: models.get(URI.joinPath(root, 'destination.ts').toString())?.getValue(),
			created: files.get(URI.joinPath(root, 'new.ts').toString()),
		};
		assert.strictEqual(applications[0].options?.skipFileOperationParticipants, true);
		const destructiveEdits = applications[0].edits.filter((edit): edit is ResourceFileEdit => edit instanceof ResourceFileEdit && (!edit.oldResource || !edit.newResource));
		assert.strictEqual(destructiveEdits.length, 2);
		assert.ok(destructiveEdits.every(edit => edit.options.rejectIfDirty));
		await workspace.undo();
		assert.deepStrictEqual({ afterApply, restored: [...files.values()], draft: models.get(URI.joinPath(root, 'renamed.ts').toString())?.getValue(), calls: applications.length, undoCalls }, {
			afterApply: { files: ['destination.ts', 'new.ts'], rename: 'user draft plus agent', created: 'new content' }, restored: ['saved', 'remove this'], draft: 'user draft', calls: 1, undoCalls: 1,
		});
	});

	test('applies a staged create then rename as a single creation at its final path', async () => {
		const changes = [await change('temporary.ts', 'new content', 'final.ts')];
		await workspace.preview(changes);
		const result = await workspace.apply(changes);
		const nativeEdit = applications[0]?.edits[0] as ResourceFileEdit;
		assert.deepStrictEqual({ result, oldResource: nativeEdit.oldResource, newResource: nativeEdit.newResource?.toString(), files: [...files] }, {
			result: true, oldResource: undefined, newResource: URI.joinPath(root, 'final.ts').toString(), files: [[URI.joinPath(root, 'final.ts').toString(), 'new content']],
		});
	});

	test('applies a staged rename then delete as deletion of only the original file', async () => {
		addFile('original.ts', 'saved');
		const changes = [await change('original.ts', undefined, 'temporary.ts')];
		await workspace.preview(changes);
		const result = await workspace.apply(changes);
		const nativeEdit = applications[0]?.edits[0] as ResourceFileEdit;
		assert.deepStrictEqual({ result, oldResource: nativeEdit.oldResource?.toString(), newResource: nativeEdit.newResource, files: [...files] }, {
			result: true, oldResource: URI.joinPath(root, 'original.ts').toString(), newResource: undefined, files: [],
		});
	});

	test('blocks changes to any baseline before applying the complete task', async () => {
		const first = addFile('first.ts', 'first');
		const second = addFile('second.ts', 'second');
		const changes = [await change('first.ts', 'agent first'), await change('second.ts', 'agent second')];
		await workspace.preview(changes);
		second.setValue('later user text');
		await assert.rejects(workspace.apply(changes), /changed/i);
		assert.deepStrictEqual({ first: first.getValue(), second: second.getValue(), calls: applications.length }, { first: 'first', second: 'later user text', calls: 0 });
	});

	test('blocks externally changed disk content even when the open buffer has not updated', async () => {
		const model = addFile('first.ts', 'first');
		const changes = [await change('first.ts', 'agent')];
		await workspace.preview(changes);
		revisions.set(model.uri.toString(), 2);
		await assert.rejects(workspace.apply(changes), /changed/i);
		assert.strictEqual(applications.length, 0);
	});

	test('blocks destination files created after review instead of overwriting them', async () => {
		const changes = [await change('new.ts', 'agent content')];
		await workspace.preview(changes);
		addFile('new.ts', 'user content');
		await assert.rejects(workspace.apply(changes), /changed|exist/i);
		assert.deepStrictEqual({ content: files.get(URI.joinPath(root, 'new.ts').toString()), calls: applications.length }, { content: 'user content', calls: 0 });
	});

	test('retains task undo when applying changes makes captured files ignored', async () => {
		addFile('existing.ts', 'before');
		const edit = await change('existing.ts', 'after');
		await workspace.preview([edit]);
		ignoreAfterApply = true;
		assert.strictEqual(await workspace.apply([edit]), true);
		assert.strictEqual(ignored, true);
		await workspace.undo();
		assert.strictEqual(models.get(URI.joinPath(root, 'existing.ts').toString())!.getValue(), 'before');
	});

	test('blocks task undo after a file becomes read-only', async () => {
		addFile('existing.ts', 'before');
		const edit = await change('existing.ts', 'after');
		await workspace.preview([edit]);
		await workspace.apply([edit]);
		readonly = true;
		await assert.rejects(workspace.undo(), /read-only|safely/);
		assert.strictEqual(undoCalls, 0);
	});

	test('refuses whole-task undo after a user edits one of its files', async () => {
		const first = addFile('first.ts', 'first');
		const second = addFile('second.ts', 'second');
		const changes = [await change('first.ts', 'agent first'), await change('second.ts', 'agent second')];
		await workspace.preview(changes);
		await workspace.apply(changes);
		second.setValue('user text after agent');
		await assert.rejects(workspace.undo(), /changed|undo/i);
		assert.deepStrictEqual({ first: first.getValue(), second: second.getValue(), undoCalls }, { first: 'agent first', second: 'user text after agent', undoCalls: 0 });
	});

	test('allows undo after autosave persists exactly the applied text', async () => {
		const first = addFile('first.ts', 'saved', 'user draft');
		const changes = [await change('first.ts', 'agent addition to user draft')];
		await workspace.preview(changes);
		await workspace.apply(changes);
		files.set(first.uri.toString(), first.getValue());
		revisions.set(first.uri.toString(), 2);
		dirty.delete(first.uri.toString());
		await workspace.undo();
		assert.deepStrictEqual({ content: first.getValue(), undoCalls }, { content: 'user draft', undoCalls: 1 });
	});

	test('blocks undo after external disk edits even when the model retains the applied text', async () => {
		const first = addFile('first.ts', 'first');
		const changes = [await change('first.ts', 'agent text')];
		await workspace.preview(changes);
		await workspace.apply(changes);
		files.set(first.uri.toString(), 'external user text');
		revisions.set(first.uri.toString(), 2);
		await assert.rejects(workspace.undo(), /changed|undo/i);
		assert.deepStrictEqual({ buffer: first.getValue(), disk: files.get(first.uri.toString()), undoCalls }, { buffer: 'agent text', disk: 'external user text', undoCalls: 0 });
	});

	test('refuses task undo when a later native undo element becomes current', async () => {
		const first = addFile('first.ts', 'first');
		const changes = [await change('first.ts', 'agent')];
		await workspace.preview(changes);
		await workspace.apply(changes);
		lastElements.set(first.uri.toString(), { type: UndoRedoElementType.Resource, resource: first.uri, label: 'Later edit', code: 'other', undo: () => { }, redo: () => { } });
		await assert.rejects(workspace.undo(), /changed|undo/i);
		assert.strictEqual(undoCalls, 0);
	});

	test('does not report the entire task undone when native undo only restores one file', async () => {
		const first = addFile('first.ts', 'first');
		const second = addFile('second.ts', 'second');
		const changes = [await change('first.ts', 'agent first'), await change('second.ts', 'agent second')];
		await workspace.preview(changes);
		await workspace.apply(changes);
		partialNativeUndo = true;
		await assert.rejects(workspace.undo(), /complete task was not undone/i);
		assert.deepStrictEqual({ first: first.getValue(), second: second.getValue(), undoCalls }, { first: 'first', second: 'agent second', undoCalls: 1 });
	});

	test('reports partial application when native operations fail after an edit', async () => {
		const first = addFile('first.ts', 'first');
		const second = addFile('second.ts', 'second');
		const changes = [await change('first.ts', 'agent first'), await change('second.ts', 'agent second')];
		await workspace.preview(changes);
		failNativeApply = true;
		const result = await workspace.apply(changes);
		assert.deepStrictEqual({ result, first: first.getValue(), second: second.getValue(), calls: applications.length }, { result: false, first: 'agent first', second: 'second', calls: 1 });
	});

	test('uses provider-aware path identity and releases captured models on disposal', async () => {
		addFile('first.ts', 'first');
		await workspace.read('1', 'first.ts', CancellationToken.None);
		const sameKey = workspace.key('1', 'first.ts') === workspace.key('1', 'FIRST.ts');
		workspace.dispose();
		assert.deepStrictEqual({ sameKey, releasedReferences }, { sameKey: true, releasedReferences: 1 });
	});

	test('rechecks workspace trust before applying reviewed changes', async () => {
		const first = addFile('first.ts', 'first');
		const changes = [await change('first.ts', 'agent')];
		await workspace.preview(changes);
		trusted = false;
		await assert.rejects(workspace.apply(changes), /Trust/i);
		assert.deepStrictEqual({ content: first.getValue(), calls: applications.length }, { content: 'first', calls: 0 });
	});

	test('blocks reviewed changes when file permissions become read-only', async () => {
		const first = addFile('first.ts', 'first');
		const changes = [await change('first.ts', 'agent')];
		await workspace.preview(changes);
		readonly = true;
		await assert.rejects(workspace.apply(changes), /read-only/i);
		assert.deepStrictEqual({ content: first.getValue(), calls: applications.length }, { content: 'first', calls: 0 });
	});
});

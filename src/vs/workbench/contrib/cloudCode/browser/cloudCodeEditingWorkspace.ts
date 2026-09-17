/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer, readableToBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, IReference } from '../../../../base/common/lifecycle.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IBulkEditService, ResourceEdit, ResourceFileEdit, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { IFileService, IFileStatWithPartialMetadata } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IUndoRedoElement, IUndoRedoService, UndoRedoSource } from '../../../../platform/undoRedo/common/undoRedo.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { ICloudCodeAgentWorkspace, ICloudCodeAgentWorkspaceSession } from '../common/cloudCodeAgent.js';
import { CloudCodeEditingReadOnlyError, CloudCodeEditingSession, ICloudCodeEditingSession, ICloudCodeEditingSessionFactory, ICloudCodeEditingWorkspace, ICloudCodeSessionChange, ICloudCodeSessionFile } from '../common/cloudCodeEditingSession.js';

const maxBaselineBytes = 1024 * 1024;
const previewScheme = 'cloudcode-session-preview';

type DiskState = Pick<IFileStatWithPartialMetadata, 'etag' | 'mtime' | 'ctime' | 'size'>;

interface Baseline {
	readonly snapshot: ICloudCodeSessionFile;
	readonly resource: URI;
	readonly disk?: DiskState;
	readonly reference?: IReference<IResolvedTextEditorModel>;
}

interface PostState {
	readonly baseline: Baseline;
	readonly content: string | undefined;
	readonly disk?: DiskState;
	readonly undoElement: IUndoRedoElement | null;
	readonly encoding: string;
}

/** Creates independent adapters so a later conversation cannot invalidate an earlier task's undo. */
export class CloudCodeEditingWorkspaceFactory implements ICloudCodeEditingSessionFactory {
	constructor(
		private readonly agentWorkspace: ICloudCodeAgentWorkspace,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	createSession(): ICloudCodeEditingSession {
		return new CloudCodeEditingSession(this.instantiationService.createInstance(CloudCodeEditingWorkspace, this.agentWorkspace.createSession()));
	}
}

/** Applies one reviewed task through native workspace edits, retaining conservative conflict checks. */
export class CloudCodeEditingWorkspace extends Disposable implements ICloudCodeEditingWorkspace {
	private readonly baselines = new Map<string, Baseline>();
	private readonly previewModels = new Map<string, ITextModel>();
	private readonly previewDisposables = this._register(new DisposableStore());
	private readonly source = new UndoRedoSource();
	private readonly code = `cloudcode.task.${generateUuid()}`;
	private readonly folders: readonly URI[];
	private reviewed: string | undefined;
	private attempted = false;
	private postStates: readonly PostState[] | undefined;
	private undoSafe = false;
	private appliedChanges: readonly ICloudCodeSessionChange[] = [];

	constructor(
		private readonly session: ICloudCodeAgentWorkspaceSession,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IEditorService private readonly editorService: IEditorService,
		@IFilesConfigurationService private readonly filesConfigurationService: IFilesConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@IUndoRedoService private readonly undoRedoService: IUndoRedoService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._register(session);
		this.folders = workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
		this._register(this.textModelService.registerTextModelContentProvider(previewScheme, {
			provideTextContent: async resource => this.previewModels.get(resource.toString()) ?? null,
		}));
	}

	assertValid(): void {
		if (this._store.isDisposed) {
			throw new CancellationError();
		}
		this.session.assertValid();
	}

	key(root: string, path: string): string {
		return this.uriIdentityService.extUri.getComparisonKey(this.resource(root, path));
	}

	async read(root: string, path: string, token: CancellationToken): Promise<ICloudCodeSessionFile> {
		this.check(token);
		if (this.attempted) {
			throw this.expiredError();
		}
		const key = this.key(root, path);
		const existing = this.baselines.get(key);
		if (existing) {
			return existing.snapshot;
		}
		const access = await this.authorize(root, path, token);
		const resource = this.resource(root, path);
		if (!access.exists) {
			if (this.modelService.getModel(resource)) {
				throw this.changedError();
			}
			const snapshot: ICloudCodeSessionFile = { root, path, resource: resource.toString(), content: undefined };
			this.baselines.set(key, { snapshot, resource });
			return snapshot;
		}
		const stat = await this.fileService.stat(resource);
		this.check(token);
		if (stat.size > maxBaselineBytes && !this.modelService.getModel(resource)) {
			throw this.sizeError();
		}
		const reference = await this.textModelService.createModelReference(resource);
		try {
			this.check(token);
			const model = reference.object.textEditorModel;
			const content = this.modelContent(model);
			await this.authorize(root, path, token);
			const currentStat = await this.fileService.stat(resource);
			this.check(token);
			if (!this.sameDisk(stat, currentStat) || model.getValue() !== content) {
				throw this.changedError();
			}
			const snapshot: ICloudCodeSessionFile = { root, path, resource: resource.toString(), content, languageId: model.getLanguageId() };
			this._register(reference);
			this.baselines.set(key, { snapshot, resource, reference, disk: this.disk(currentStat) });
			return snapshot;
		} catch (error) {
			reference.dispose();
			throw error;
		}
	}

	async preview(changes: readonly ICloudCodeSessionChange[]): Promise<void> {
		this.assertValid();
		this.validateChanges(changes);
		const revision = generateUuid();
		const resources = changes.map(change => {
			const original = URI.from({ scheme: previewScheme, authority: revision, path: '/before/' + change.before.root + '/' + change.before.path });
			const modified = URI.from({ scheme: previewScheme, authority: revision, path: '/after/' + change.after.root + '/' + change.after.path });
			this.previewModel(original, change.before.content ?? '', change.before.languageId);
			this.previewModel(modified, change.after.content ?? '', change.after.languageId ?? change.before.languageId);
			return { original: { resource: original }, modified: { resource: modified }, goToFileResource: this.resource(change.after.root, change.after.path) };
		});
		const pane = await this.editorService.openEditor({
			multiDiffSource: URI.from({ scheme: previewScheme, authority: revision, path: '/task' }),
			label: localize('cloudCode.session.preview', "CloudCode — Task Changes"),
			resources,
			isTransient: true,
			options: { pinned: true },
		});
		this.assertValid();
		if (!pane) {
			throw new Error(localize('cloudCode.session.previewFailed', "The task diff could not be opened. Try again before accepting these changes."));
		}
		this.reviewed = JSON.stringify(changes);
	}

	async apply(changes: readonly ICloudCodeSessionChange[]): Promise<boolean> {
		this.assertValid();
		const touched = this.validateChanges(changes);
		if (this.attempted || this.reviewed !== JSON.stringify(changes)) {
			throw this.expiredError();
		}
		const textEdits: ResourceEdit[] = [];
		const fileEdits: ResourceEdit[] = [];
		for (const baseline of touched) {
			await this.assertBaseline(baseline);
		}
		for (const change of changes) {
			const before = this.baselines.get(this.key(change.before.root, change.before.path))!;
			const destination = this.resource(change.after.root, change.after.path);
			if (change.kind === 'delete' && this.textFileService.isDirty(before.resource)) {
				throw new Error(localize('cloudCode.session.dirtyDelete', "Save or revert '{0}' before accepting its deletion. Your unsaved changes were preserved.", change.before.path));
			}
			if (change.before.content !== undefined && change.after.content !== undefined && change.before.content !== change.after.content) {
				const model = before.reference!.object.textEditorModel;
				textEdits.push(new ResourceTextEdit(before.resource, { range: model.getFullModelRange(), text: change.after.content }, model.getVersionId()));
			}
			let validation: Error | true = true;
			if (change.kind === 'create') {
				validation = await this.fileService.canCreateFile(destination, { overwrite: false });
				const encoded = await this.textFileService.getEncodedReadable(destination, change.after.content!);
				const contents = encoded instanceof VSBuffer ? encoded : readableToBuffer(encoded);
				fileEdits.push(new ResourceFileEdit(undefined, destination, { overwrite: false, rejectIfDirty: true, contents: Promise.resolve(contents) }));
			} else if (change.kind === 'rename') {
				validation = await this.fileService.canMove(before.resource, destination, false);
				fileEdits.push(new ResourceFileEdit(before.resource, destination, { overwrite: false }));
			} else if (change.kind === 'delete') {
				validation = await this.fileService.canDelete(before.resource, { recursive: false });
				fileEdits.push(new ResourceFileEdit(before.resource, undefined, { recursive: false, maxSize: maxBaselineBytes, rejectIfDirty: true }));
			}
			if (validation instanceof Error) {
				throw new Error(localize('cloudCode.session.preflightFailed', "'{0}' cannot be changed safely. Check file permissions and destination conflicts.", change.before.path));
			}
		}
		// Repeat every check after asynchronous preparation. Text version guards remain active inside bulk edit.
		for (const baseline of touched) {
			await this.assertBaseline(baseline);
		}
		for (const change of changes) {
			if (change.kind === 'delete' && this.textFileService.isDirty(this.resource(change.before.root, change.before.path))) {
				throw this.changedError();
			}
		}
		this.assertValid();
		for (const baseline of touched) {
			this.assertModelBaseline(baseline);
		}
		this.attempted = true;
		this.appliedChanges = changes;
		let complete = false;
		try {
			const result = await this.bulkEditService.apply([...textEdits, ...fileEdits], {
				label: localize('cloudCode.session.undoLabel', "CloudCode Task Changes"), code: this.code, undoRedoSource: this.source,
				skipFileOperationParticipants: true,
			});
			complete = result.isApplied;
		} catch {
			// Native file operations are not atomic. Retain the session for review and safe undo.
		}
		try {
			const states: PostState[] = [];
			for (const baseline of touched) {
				const state = await this.currentState(baseline);
				states.push({ ...state, baseline, undoElement: this.undoRedoService.getLastElement(baseline.resource), encoding: this.textFileService.getEncoding(baseline.resource) });
			}
			this.postStates = states;
			const expected = this.expectedContents(changes, touched);
			complete = complete && states.every(state => state.content === expected.get(this.key(state.baseline.snapshot.root, state.baseline.snapshot.path)));
			this.undoSafe = states.every(state => {
				const expectedContent = expected.get(this.key(state.baseline.snapshot.root, state.baseline.snapshot.path));
				return (state.content === expectedContent || state.content === state.baseline.snapshot.content) &&
					(state.content === state.baseline.snapshot.content || state.undoElement?.code === this.code);
			});
		} catch {
			complete = false;
			this.undoSafe = false;
		}
		return complete;
	}

	async undo(): Promise<void> {
		this.assertValid();
		const states = this.postStates;
		if (!states || !this.undoSafe || !this.undoRedoService.canUndo(this.source)) {
			throw this.undoConflictError();
		}
		for (const state of states) {
			const current = await this.currentState(state.baseline);
			if (current.content !== state.content || this.undoRedoService.getLastElement(state.baseline.resource) !== state.undoElement || !await this.matchesSavedState(state, current.disk)) {
				throw this.undoConflictError();
			}
		}
		await this.assertUndoWritable(states);
		this.assertValid();
		// Synchronous check immediately before handing control to native undo.
		for (const state of states) {
			const model = this.modelService.getModel(state.baseline.resource);
			if ((model && state.content !== undefined && model.getValue() !== state.content) || (state.content === undefined && this.textFileService.isDirty(state.baseline.resource)) || this.undoRedoService.getLastElement(state.baseline.resource) !== state.undoElement) {
				throw this.undoConflictError();
			}
		}
		await this.undoRedoService.undo(this.source);
		for (const state of states) {
			if ((await this.currentState(state.baseline)).content !== state.baseline.snapshot.content) {
				this.undoSafe = false;
				throw new Error(localize('cloudCode.session.undoIncomplete', "The complete task was not undone. Review the affected files before continuing."));
			}
		}
		this.undoSafe = false;
	}



	/** Validate every inverse operation before native undo can begin a partial reversal. */
	private async assertUndoWritable(states: readonly PostState[]): Promise<void> {
		for (const state of states) {
			const resource = state.baseline.resource;
			if (state.content !== undefined) {
				this.assertWritable(resource, await this.fileService.stat(resource), state.baseline.reference?.object.isDisposed() ? undefined : state.baseline.reference);
			} else if (this.filesConfigurationService.isReadonly(resource)) {
				throw this.undoConflictError();
			}
			const parent = dirname(resource);
			const parentStat = await this.fileService.stat(parent);
			this.assertValid();
			if (!parentStat.isDirectory || parentStat.isSymbolicLink || parentStat.readonly || parentStat.locked || this.filesConfigurationService.isReadonly(parent, parentStat)) {
				throw this.undoConflictError();
			}
		}
		const current = new Map(states.map(state => [this.key(state.baseline.snapshot.root, state.baseline.snapshot.path), state.content]));
		for (const change of this.appliedChanges) {
			const before = this.resource(change.before.root, change.before.path);
			const after = this.resource(change.after.root, change.after.path);
			const beforeExists = current.get(this.key(change.before.root, change.before.path)) !== undefined;
			const afterExists = current.get(this.key(change.after.root, change.after.path)) !== undefined;
			let validation: Error | true = true;
			if (change.kind === 'create' && afterExists) {
				validation = await this.fileService.canDelete(after, { recursive: false });
			} else if (change.kind === 'delete' && !beforeExists) {
				validation = await this.fileService.canCreateFile(before, { overwrite: false });
			} else if (change.kind === 'rename' && !beforeExists && afterExists) {
				validation = await this.fileService.canMove(after, before, false);
			}
			this.assertValid();
			if (validation instanceof Error) {
				throw this.undoConflictError();
			}
		}
	}

	/** Ordinary save/autosave may change metadata, but must write exactly the applied text and encoding. */
	private async matchesSavedState(state: PostState, currentDisk: DiskState | undefined): Promise<boolean> {
		if (this.sameDisk(currentDisk, state.disk)) {
			return true;
		}
		if (!currentDisk || state.content === undefined || currentDisk.size > maxBaselineBytes) {
			return false;
		}
		const content = await this.textFileService.read(state.baseline.resource, { acceptTextOnly: true, limits: { size: maxBaselineBytes } });
		this.assertValid();
		const stat = await this.fileService.stat(state.baseline.resource);
		this.assertValid();
		return content.value === state.content && content.encoding === state.encoding && this.sameDisk(currentDisk, stat);
	}

	private resource(root: string, path: string): URI {
		this.assertValid();
		const index = this.session.roots.findIndex(entry => entry.id === root);
		if (index < 0 || !this.folders[index] || !path || path.split('/').some(segment => !segment || segment === '.' || segment === '..') || /[\\:\x00-\x1f\x7f]/.test(path)) {
			throw new Error(localize('cloudCode.session.invalidPath', "Choose a relative path inside the current project."));
		}
		return this.uriIdentityService.asCanonicalUri(joinPath(this.folders[index], path));
	}

	private async authorize(root: string, path: string, token = CancellationToken.None, requireSearchEligibility = true): Promise<{ resource: string; exists: boolean }> {
		this.check(token);
		if (!this.session.authorizeEditPath) {
			throw new Error(localize('cloudCode.session.unavailable', "Task editing is unavailable in this workspace."));
		}
		const access = await this.session.authorizeEditPath(root, path, token, requireSearchEligibility);
		this.check(token);
		if (!this.uriIdentityService.extUri.isEqual(URI.parse(access.resource), this.resource(root, path))) {
			throw this.changedError();
		}
		return access;
	}

	private validateChanges(changes: readonly ICloudCodeSessionChange[]): Baseline[] {
		if (!changes.length || changes.length > 20 || this.attempted) {
			throw this.expiredError();
		}
		const touched = new Map<string, Baseline>();
		for (const change of changes) {
			const key = this.key(change.before.root, change.before.path);
			const baseline = this.baselines.get(key);
			if (!baseline || baseline.snapshot !== change.before || change.before.root !== change.after.root || touched.has(key)) {
				throw this.expiredError();
			}
			touched.set(key, baseline);
			const destinationKey = this.key(change.after.root, change.after.path);
			if (change.after.resource !== this.resource(change.after.root, change.after.path).toString()) {
				throw this.expiredError();
			}
			if (change.after.content !== undefined && (change.after.content.includes('\0') || VSBuffer.fromString(change.after.content).byteLength > maxBaselineBytes)) {
				throw this.sizeError();
			}
			const existsBefore = change.before.content !== undefined;
			const existsAfter = change.after.content !== undefined;
			if ((change.kind === 'create' && (existsBefore || !existsAfter)) ||
				(change.kind === 'edit' && (!existsBefore || !existsAfter || key !== destinationKey)) ||
				(change.kind === 'delete' && (!existsBefore || existsAfter)) ||
				(change.kind === 'rename' && (!existsBefore || !existsAfter || key === destinationKey))) {
				throw this.expiredError();
			}
			if (destinationKey !== key) {
				const destination = this.baselines.get(destinationKey);
				if (!destination || destination.snapshot.content !== undefined || touched.has(destinationKey)) {
					throw this.changedError();
				}
				touched.set(destinationKey, destination);
			}
		}
		return [...touched.values()];
	}

	private async assertBaseline(baseline: Baseline): Promise<void> {
		const access = await this.authorize(baseline.snapshot.root, baseline.snapshot.path);
		if (access.exists !== (baseline.snapshot.content !== undefined)) {
			throw this.changedError();
		}
		if (access.exists) {
			const stat = await this.fileService.stat(baseline.resource);
			this.assertValid();
			this.assertWritable(baseline.resource, stat, baseline.reference);
			if (!this.sameDisk(stat, baseline.disk)) {
				throw this.changedError();
			}
		} else if (this.filesConfigurationService.isReadonly(baseline.resource)) {
			throw this.changedError();
		}
		this.assertModelBaseline(baseline);
	}

	private assertModelBaseline(baseline: Baseline): void {
		if (baseline.reference) {
			if (baseline.reference.object.isDisposed() || baseline.reference.object.textEditorModel.isDisposed() || baseline.reference.object.textEditorModel.getValue() !== baseline.snapshot.content) {
				throw this.changedError();
			}
		} else if (this.modelService.getModel(baseline.resource)) {
			throw this.changedError();
		}
	}

	private async currentState(baseline: Baseline): Promise<{ content: string | undefined; disk?: DiskState }> {
		const access = await this.authorize(baseline.snapshot.root, baseline.snapshot.path, CancellationToken.None, false);
		if (!access.exists) {
			return { content: undefined };
		}
		const stat = await this.fileService.stat(baseline.resource);
		this.assertValid();
		let model = this.modelService.getModel(baseline.resource);
		if (!model) {
			if (stat.size > maxBaselineBytes) {
				throw this.sizeError();
			}
			const reference = await this.textModelService.createModelReference(baseline.resource);
			this._register(reference);
			this.assertValid();
			model = reference.object.textEditorModel;
		}
		return { content: this.modelContent(model), disk: this.disk(stat) };
	}

	private expectedContents(changes: readonly ICloudCodeSessionChange[], touched: readonly Baseline[]): Map<string, string | undefined> {
		const expected = new Map(touched.map(baseline => [this.key(baseline.snapshot.root, baseline.snapshot.path), baseline.snapshot.content]));
		for (const change of changes) {
			const beforeKey = this.key(change.before.root, change.before.path);
			const afterKey = this.key(change.after.root, change.after.path);
			expected.set(beforeKey, beforeKey === afterKey ? change.after.content : undefined);
			expected.set(afterKey, change.after.content);
		}
		return expected;
	}

	private assertWritable(resource: URI, stat: IFileStatWithPartialMetadata, reference?: IReference<IResolvedTextEditorModel>): void {
		if (!stat.isFile || stat.isSymbolicLink || stat.readonly || stat.locked || reference?.object.isReadonly() || this.filesConfigurationService.isReadonly(resource, stat)) {
			throw new Error(localize('cloudCode.session.readonly', "'{0}' is read-only or unavailable for editing.", basename(resource)));
		}
	}

	private previewModel(resource: URI, value: string, languageId = 'plaintext'): void {
		const model = this.previewDisposables.add(this.modelService.createModel(value, this.languageService.createById(languageId), resource));
		this.previewModels.set(resource.toString(), model);
		this.previewDisposables.add(model.onWillDispose(() => this.previewModels.delete(resource.toString())));
	}

	private modelContent(model: ITextModel): string {
		if (model.getValueLength() > maxBaselineBytes) {
			throw this.sizeError();
		}
		const content = model.getValue();
		if (VSBuffer.fromString(content).byteLength > maxBaselineBytes) {
			throw this.sizeError();
		}
		if (content.includes('\0')) {
			throw new Error(localize('cloudCode.session.binary', "Task editing supports text files only."));
		}
		return content;
	}

	private disk(stat: IFileStatWithPartialMetadata): DiskState {
		return { etag: stat.etag, mtime: stat.mtime, ctime: stat.ctime, size: stat.size };
	}

	private sameDisk(a: DiskState | undefined, b: DiskState | undefined): boolean {
		return a === undefined || b === undefined ? a === b : a.etag === b.etag && a.mtime === b.mtime && a.ctime === b.ctime && a.size === b.size;
	}

	private check(token: CancellationToken): void {
		this.assertValid();
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
	}

	private sizeError(): Error {
		return new CloudCodeEditingReadOnlyError(localize('cloudCode.session.tooLarge', "Task editing supports text files up to 1 MiB. Read larger files in bounded ranges."));
	}

	private changedError(): Error {
		return new Error(localize('cloudCode.session.changed', "A task file changed or its destination is occupied. Your changes were preserved; request a new edit."));
	}

	private expiredError(): Error {
		return new Error(localize('cloudCode.session.expired', "Preview the current task changes before accepting them. This task may already have been applied."));
	}

	private undoConflictError(): Error {
		return new Error(localize('cloudCode.session.undoConflict', "The task cannot be undone safely because an affected file or its undo history changed. Your changes were preserved."));
	}
}

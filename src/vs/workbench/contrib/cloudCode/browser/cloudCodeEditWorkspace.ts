/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableStore, IReference } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { IFileService, IFileStatWithPartialMetadata } from '../../../../platform/files/common/files.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { DEFAULT_EDITOR_ASSOCIATION } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { CLOUDCODE_MAX_ATTACHMENTS, ICloudCodeAttachment } from '../common/cloudCodeChatContext.js';
import { ICloudCodeEditProvider, ICloudCodeEditTarget, ICloudCodeProposedEdit } from '../common/cloudCodeEdits.js';

const MAX_REPLACEMENT_BYTES = 32 * 1024;
const MAX_BASELINE_BYTES = 1024 * 1024;
const PREVIEW_SCHEME = 'cloudcode-edit-preview';

interface IPreparedEdit {
	readonly target: ICloudCodeEditTarget;
	readonly resource: URI;
	readonly reference: IReference<IResolvedTextEditorModel>;
	readonly baseline: string;
	readonly range: Range;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly diskState?: { readonly etag: string; readonly mtime: number; readonly ctime: number; readonly size: number };
	preview?: { readonly replacement: string; readonly original: URI; readonly modified: URI };
	applied: boolean;
}

/** Holds explicit attachment capabilities and applies reviewed edits to unchanged text buffers. */
export class CloudCodeEditWorkspace extends Disposable implements ICloudCodeEditProvider {

	private readonly sessionDisposables = this._register(new DisposableStore());
	private readonly targets = new Map<string, IPreparedEdit>();
	private readonly previewModels = new Map<string, ITextModel>();
	private revision = 0;

	constructor(
		@ITextModelService private readonly textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IEditorService private readonly editorService: IEditorService,
		@IFilesConfigurationService private readonly filesConfigurationService: IFilesConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustService: IWorkspaceTrustManagementService,
	) {
		super();
		this._register(this.textModelService.registerTextModelContentProvider(PREVIEW_SCHEME, {
			provideTextContent: resource => this.previewModels.get(resource.toString()) ?? null,
		}));
	}

	/** Resolves only supplied resources and verifies the attached snapshot before inference starts. */
	async prepare(attachments: readonly ICloudCodeAttachment[]): Promise<readonly ICloudCodeEditTarget[]> {
		this.clear();
		const revision = this.revision;
		this.assertCurrent(revision);
		if (!attachments.length || attachments.length > CLOUDCODE_MAX_ATTACHMENTS) {
			throw new Error(localize('cloudCode.edits.attachFiles', "Attach between 1 and {0} files or selections before requesting edits.", CLOUDCODE_MAX_ATTACHMENTS));
		}
		const pending = new DisposableStore();
		const prepared: IPreparedEdit[] = [];
		const resources = new Set<string>();
		const models = new Set<ITextModel>();
		try {
			for (const attachment of attachments) {
				if (!attachment.resource) {
					throw new Error(localize('cloudCode.edits.missingResource', "Attach the file again before requesting an edit."));
				}
				const resource = URI.parse(attachment.resource);
				if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote && resource.scheme !== Schemas.untitled) {
					throw new Error(localize('cloudCode.edits.unsupportedResource', "Edits are available only for attached local files, remote files, and untitled buffers."));
				}
				if (resources.has(resource.toString())) {
					throw this.duplicateResourceError();
				}
				resources.add(resource.toString());
				const stat = resource.scheme === Schemas.untitled ? undefined : await this.fileService.stat(resource);
				this.assertCurrent(revision);
				if (stat && (!stat.isFile || (!this.modelService.getModel(resource) && stat.size > MAX_BASELINE_BYTES))) {
					throw new Error(localize('cloudCode.edits.invalidFile', "Attach a text file smaller than 1 MiB before requesting edits."));
				}
				const reference = pending.add(await this.textModelService.createModelReference(resource));
				this.assertCurrent(revision);
				const model = reference.object.textEditorModel;
				if (models.has(model)) {
					throw this.duplicateResourceError();
				}
				models.add(model);
				if (model.getValueLength() > MAX_BASELINE_BYTES) {
					throw this.baselineTooLargeError();
				}
				const baseline = model.getValue();
				if (VSBuffer.fromString(baseline).byteLength > MAX_BASELINE_BYTES || baseline.includes('\0')) {
					throw this.baselineTooLargeError();
				}
				const range = attachment.range ? Range.lift(attachment.range) : model.getFullModelRange();
				if (!Range.equalsRange(model.validateRange(range), range) || model.getValueInRange(range) !== attachment.content) {
					throw this.changedFileError();
				}
				const entry: IPreparedEdit = {
					target: { token: generateUuid(), attachment },
					resource,
					reference,
					baseline,
					range,
					startOffset: model.getOffsetAt(range.getStartPosition()),
					endOffset: model.getOffsetAt(range.getEndPosition()),
					diskState: stat ? { etag: stat.etag, mtime: stat.mtime, ctime: stat.ctime, size: stat.size } : undefined,
					applied: false,
				};
				this.assertWritable(entry, stat);
				prepared.push(entry);
			}
			this.assertCurrent(revision);
			for (const entry of prepared) {
				this.assertBaseline(entry);
			}
			this.sessionDisposables.add(pending);
			for (const entry of prepared) {
				this.targets.set(entry.target.token, entry);
			}
			return prepared.map(entry => entry.target);
		} catch (error) {
			pending.dispose();
			throw error;
		}
	}

	/** Opens immutable full-file snapshots in the native diff editor. */
	async preview(edit: ICloudCodeProposedEdit): Promise<void> {
		const revision = this.revision;
		const entry = this.getEntry(edit, revision);
		const replacement = this.normalizedReplacement(entry, edit.replacement);
		let preview = entry.preview;
		if (!preview || preview.replacement !== replacement ||
			!this.previewModels.get(preview.original.toString()) || !this.previewModels.get(preview.modified.toString())) {
			const namespace = generateUuid();
			const original = URI.from({ scheme: PREVIEW_SCHEME, authority: namespace, path: '/before/' + basename(entry.resource) });
			const modified = URI.from({ scheme: PREVIEW_SCHEME, authority: namespace, path: '/after/' + basename(entry.resource) });
			this.createPreviewModel(original, entry.baseline, entry.reference.object.textEditorModel.getLanguageId());
			this.createPreviewModel(modified, entry.baseline.slice(0, entry.startOffset) + replacement + entry.baseline.slice(entry.endOffset), entry.reference.object.textEditorModel.getLanguageId());
			preview = { original, modified, replacement };
		}
		const pane = await this.editorService.openEditor({
			original: { resource: preview.original },
			modified: { resource: preview.modified },
			label: localize('cloudCode.edits.previewLabel', "{0} — Proposed Change", entry.target.attachment.label),
			options: { pinned: true, override: DEFAULT_EDITOR_ASSOCIATION.id },
		});
		this.getEntry(edit, revision);
		if (!pane) {
			throw new Error(localize('cloudCode.edits.previewFailed', "The diff preview could not be opened. Try again before accepting the change."));
		}
		entry.preview = preview;
	}

	/** Adds one undo step to the existing buffer; the editor's usual save policy remains in effect. */
	async apply(edit: ICloudCodeProposedEdit): Promise<void> {
		const revision = this.revision;
		const entry = this.getEntry(edit, revision);
		const replacement = this.normalizedReplacement(entry, edit.replacement);
		if (entry.preview?.replacement !== replacement) {
			throw new Error(localize('cloudCode.edits.previewFirst', "Preview this proposal before accepting it."));
		}
		const pane = await this.editorService.openEditor({
			resource: entry.resource,
			options: { pinned: true, override: DEFAULT_EDITOR_ASSOCIATION.id },
		});
		this.getEntry(edit, revision);
		if (!pane) {
			throw new Error(localize('cloudCode.edits.openFailed', "The file could not be opened. No changes were applied."));
		}
		const stat = entry.resource.scheme === Schemas.untitled ? undefined : await this.fileService.stat(entry.resource);
		this.getEntry(edit, revision);
		this.assertWritable(entry, stat);
		if (entry.diskState && (!stat || stat.etag !== entry.diskState.etag || stat.mtime !== entry.diskState.mtime || stat.ctime !== entry.diskState.ctime || stat.size !== entry.diskState.size)) {
			throw this.changedFileError();
		}
		const model = entry.reference.object.textEditorModel;
		// There must be no asynchronous work between the final baseline check and mutation.
		this.assertBaseline(entry);
		model.pushStackElement();
		model.pushEditOperations(null, [{ range: entry.range, text: replacement }], () => null);
		model.pushStackElement();
		entry.applied = true;
	}

	/** Invalidates pending operations and releases snapshots when the conversation is reset. */
	clear(): void {
		this.revision++;
		this.targets.clear();
		this.previewModels.clear();
		this.sessionDisposables.clear();
	}

	private getEntry(edit: ICloudCodeProposedEdit, revision: number): IPreparedEdit {
		this.assertCurrent(revision);
		const entry = this.targets.get(edit.target.token);
		if (!entry || entry.target !== edit.target || entry.applied) {
			throw new Error(localize('cloudCode.edits.expired', "This proposal is no longer available. Request a new edit."));
		}
		this.assertBaseline(entry);
		return entry;
	}

	private assertCurrent(revision: number): void {
		if (revision !== this.revision || this._store.isDisposed) {
			throw new Error(localize('cloudCode.edits.expired', "This proposal is no longer available. Request a new edit."));
		}
		if (!this.workspaceTrustService.isWorkspaceTrusted()) {
			throw new Error(localize('cloudCode.edits.workspaceTrust', "Trust this workspace before proposing or applying edits."));
		}
	}

	private assertBaseline(entry: IPreparedEdit): void {
		const model = entry.reference.object.textEditorModel;
		if (entry.reference.object.isDisposed() || model.isDisposed() || model.getValue() !== entry.baseline) {
			throw this.changedFileError();
		}
	}

	private assertWritable(entry: IPreparedEdit, stat: IFileStatWithPartialMetadata | undefined): void {
		if ((stat && (!stat.isFile || stat.readonly || stat.locked)) ||
			entry.reference.object.isReadonly() || this.filesConfigurationService.isReadonly(entry.resource, stat)) {
			throw new Error(localize('cloudCode.edits.readonly', "'{0}' is read-only. No changes were applied.", entry.target.attachment.label));
		}
	}

	private normalizedReplacement(entry: IPreparedEdit, replacement: string): string {
		if (VSBuffer.fromString(replacement).byteLength > MAX_REPLACEMENT_BYTES || replacement.includes('\0')) {
			throw new Error(localize('cloudCode.edits.replacementTooLarge', "The proposed replacement must be text no larger than {0} KiB.", MAX_REPLACEMENT_BYTES / 1024));
		}
		const normalized = replacement.replace(/\r\n|\r|\n/g, entry.reference.object.textEditorModel.getEOL());
		if (VSBuffer.fromString(normalized).byteLength > MAX_REPLACEMENT_BYTES) {
			throw new Error(localize('cloudCode.edits.normalizedReplacementTooLarge', "The proposed replacement exceeds {0} KiB with this file's line endings. Request a smaller change.", MAX_REPLACEMENT_BYTES / 1024));
		}
		return normalized;
	}

	private createPreviewModel(resource: URI, value: string, languageId: string): void {
		const model = this.sessionDisposables.add(this.modelService.createModel(value, this.languageService.createById(languageId), resource));
		this.previewModels.set(resource.toString(), model);
		this.sessionDisposables.add(model.onWillDispose(() => this.previewModels.delete(resource.toString())));
	}

	private duplicateResourceError(): Error {
		return new Error(localize('cloudCode.edits.duplicateResource', "Attach each file only once when requesting edits. Choose either the whole file or one selection."));
	}

	private changedFileError(): Error {
		return new Error(localize('cloudCode.edits.fileChanged', "The file changed after it was attached or the edit was requested. Attach its current contents and request a new edit."));
	}

	private baselineTooLargeError(): Error {
		return new Error(localize('cloudCode.edits.baselineTooLarge', "Edit proposals support text files up to 1 MiB. Open a smaller file."));
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}
}

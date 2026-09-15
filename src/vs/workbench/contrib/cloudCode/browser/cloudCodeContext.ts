/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, extname, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { getCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { cloudCodeImageMimeType, CLOUDCODE_MAX_IMAGE_BYTES } from '../../../../platform/cloudCode/common/cloudCodeImages.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService, TextFileOperationError, TextFileOperationResult } from '../../../services/textfile/common/textfiles.js';
import { CLOUDCODE_MAX_ATTACHMENT_BYTES, CLOUDCODE_MAX_ATTACHMENTS, CloudCodeAttachmentKind, ICloudCodeAttachment, mergeCloudCodeAttachments } from '../common/cloudCodeChatContext.js';

/** Reads only explicitly attached files and images, capturing editor buffers without saving them. */
export class CloudCodeContext {

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IFileService private readonly fileService: IFileService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustService: IWorkspaceTrustManagementService,
	) { }

	/** Rechecked before sending so revoking workspace trust also blocks queued attachments. */
	assertWorkspaceTrusted(): void {
		if (!this.workspaceTrustService.isWorkspaceTrusted()) {
			throw new Error(localize('cloudCode.context.workspaceTrust', "Trust this workspace before attaching or sending project files."));
		}
	}

	/** A cancelled picker returns no attachments; failed batches never return partial results. */
	async readAttachments(kind: CloudCodeAttachmentKind): Promise<readonly ICloudCodeAttachment[]> {
		this.assertWorkspaceTrusted();
		if (kind !== 'files') {
			const control = this.editorService.activeTextEditorControl;
			if (isDiffEditor(control)) {
				throw new Error(localize('cloudCode.context.diffEditor', "Open the file in a regular text editor before attaching it or its selection."));
			}
			const editor = getCodeEditor(control);
			const model = editor?.getModel();
			if (!model) {
				throw new Error(localize('cloudCode.context.noEditor', "Open a text file before attaching it to the chat."));
			}
			if (kind === 'selection') {
				const selection = editor?.getSelection();
				if (!selection || selection.isEmpty()) {
					throw new Error(localize('cloudCode.context.noSelection', "Select some code in the editor first."));
				}
				return [this.snapshotModel(model, selection)];
			}
			return [this.snapshotModel(model)];
		}

		const resources = await this.fileDialogService.showOpenDialog({
			title: localize('cloudCode.context.pickFiles', "Attach Files to CloudCode Chat"),
			openLabel: localize('cloudCode.context.attach', "Attach"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			availableFileSystems: [Schemas.file, Schemas.vscodeRemote],
		});
		this.assertWorkspaceTrusted();
		if (!resources?.length) {
			return [];
		}
		return this.readResources(resources);
	}

	/** Picker, clipboard and Explorer drops share the same snapshot and trust checks. */
	async readResources(resources: readonly URI[]): Promise<readonly ICloudCodeAttachment[]> {
		this.assertWorkspaceTrusted();
		const unique = [...new Map(resources.map(resource => [resource.toString(), resource])).values()];
		if (unique.length > CLOUDCODE_MAX_ATTACHMENTS) {
			throw new Error(localize('cloudCode.context.tooMany', "Attach up to {0} files at a time.", CLOUDCODE_MAX_ATTACHMENTS));
		}
		let attachments: readonly ICloudCodeAttachment[] = [];
		for (const resource of unique) {
			attachments = mergeCloudCodeAttachments(attachments, [await this.readFile(resource)]);
		}
		return attachments;
	}

	/** Clipboard blobs have no editable resource and are never written to the workspace. */
	readFileData(name: string, bytes: Uint8Array): ICloudCodeAttachment {
		this.assertWorkspaceTrusted();
		const label = basename(URI.file(name));
		const mimeType = cloudCodeImageMimeType(bytes);
		if (mimeType) {
			if (bytes.byteLength > CLOUDCODE_MAX_IMAGE_BYTES) {
				throw new Error(localize('cloudcode.imageTooLarge', "Images must be 4 MiB or smaller."));
			}
			return { id: generateUuid(), label, content: '', image: { dataUrl: `data:${mimeType};base64,${encodeBase64(VSBuffer.wrap(bytes))}` } };
		}
		if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic)$/i.test(label)) {
			throw new Error(localize('cloudcode.unsupportedImage', "Use a valid PNG, JPEG, GIF, or WebP image."));
		}
		this.assertSize(bytes.byteLength, URI.file(label));
		let content: string;
		try {
			content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		} catch {
			throw this.binaryFileError(URI.file(label));
		}
		this.assertContent(content, URI.file(label));
		return { id: generateUuid(), label, content };
	}

	private async readFile(resource: URI): Promise<ICloudCodeAttachment> {
		this.assertWorkspaceTrusted();
		this.assertSupportedResource(resource, false);
		const model = this.modelService.getModel(resource);
		if (model) {
			return this.snapshotModel(model);
		}
		const stat = await this.fileService.stat(resource);
		this.assertWorkspaceTrusted();
		if (!stat.isFile) {
			throw new Error(localize('cloudCode.context.notFile', "'{0}' is not a text file.", basename(resource)));
		}
		if (/^\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic)$/i.test(extname(resource))) {
			if (stat.size > CLOUDCODE_MAX_IMAGE_BYTES) {
				throw new Error(localize('cloudcode.imageTooLarge', "Images must be 4 MiB or smaller."));
			}
			const file = await this.fileService.readFile(resource, { limits: { size: CLOUDCODE_MAX_IMAGE_BYTES } });
			const image = this.readFileData(basename(resource), file.value.buffer);
			return { ...image, id: resource.toString(), label: this.resourceLabel(resource) };
		}
		if (this.canReference(resource, stat.size)) {
			return this.fileReference(resource);
		}
		this.assertSize(stat.size, resource);
		let content: string;
		try {
			const file = await this.textFileService.read(resource, { acceptTextOnly: true, limits: { size: CLOUDCODE_MAX_ATTACHMENT_BYTES } });
			content = file.value;
		} catch (error) {
			if (error instanceof TextFileOperationError && error.textFileOperationResult === TextFileOperationResult.FILE_IS_BINARY) {
				throw this.binaryFileError(resource);
			}
			if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_TOO_LARGE) {
				if (this.canReference(resource, CLOUDCODE_MAX_ATTACHMENT_BYTES + 1)) {
					return this.fileReference(resource);
				}
				this.assertSize(CLOUDCODE_MAX_ATTACHMENT_BYTES + 1, resource);
			}
			throw error;
		}
		this.assertWorkspaceTrusted();
		// The editor may have opened (or changed) this file while the disk read was pending.
		const currentModel = this.modelService.getModel(resource);
		if (currentModel) {
			return this.snapshotModel(currentModel);
		}
		if (this.canReference(resource, VSBuffer.fromString(content).byteLength)) {
			return this.fileReference(resource);
		}
		this.assertContent(content, resource);
		return { id: resource.toString(), resource: resource.toString(), label: this.resourceLabel(resource), content };
	}

	private snapshotModel(model: ITextModel, range?: IRange): ICloudCodeAttachment {
		this.assertSupportedResource(model.uri, true);
		const length = range ? model.getValueLengthInRange(range) : model.getValueLength();
		if (!range && this.canReference(model.uri, length)) {
			return this.fileReference(model.uri, model.getLanguageId());
		}
		this.assertSize(length, model.uri);
		const content = range ? model.getValueInRange(range) : model.getValue();
		if (!range && this.canReference(model.uri, VSBuffer.fromString(content).byteLength)) {
			return this.fileReference(model.uri, model.getLanguageId());
		}
		this.assertContent(content, model.uri);
		const label = this.resourceLabel(model.uri);
		const endLine = range && range.endColumn === 1 && range.endLineNumber > range.startLineNumber ? range.endLineNumber - 1 : range?.endLineNumber;
		return {
			id: range ? `${model.uri.toString()}#${range.startLineNumber}:${range.startColumn}-${range.endLineNumber}:${range.endColumn}` : model.uri.toString(),
			label: range ? localize('cloudCode.context.selectionLabel', "{0}:{1}-{2}", label, range.startLineNumber, endLine) : label,
			content,
			resource: model.uri.toString(),
			...(range ? { range: { startLineNumber: range.startLineNumber, startColumn: range.startColumn, endLineNumber: range.endLineNumber, endColumn: range.endColumn } } : {}),
			languageId: model.getLanguageId(),
			...(range ? { startLine: range.startLineNumber, endLine } : {}),
		};
	}

	private canReference(resource: URI, bytes: number): boolean {
		return bytes > CLOUDCODE_MAX_ATTACHMENT_BYTES && (resource.scheme === Schemas.file || resource.scheme === Schemas.vscodeRemote) && !!this.workspaceContextService.getWorkspaceFolder(resource);
	}

	private fileReference(resource: URI, languageId?: string): ICloudCodeAttachment {
		this.assertWorkspaceTrusted();
		return { id: resource.toString(), resource: resource.toString(), label: this.resourceLabel(resource), content: '', reference: true, languageId };
	}

	private assertSupportedResource(resource: URI, allowUntitled: boolean): void {
		if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote && !(allowUntitled && resource.scheme === Schemas.untitled)) {
			throw new Error(localize('cloudCode.context.unsupported', "Attach a local or remote text file, or an untitled editor buffer."));
		}
	}

	private assertSize(bytes: number, resource: URI): void {
		if (bytes > CLOUDCODE_MAX_ATTACHMENT_BYTES) {
			throw new Error(localize('cloudCode.context.tooLarge', "'{0}' exceeds the {1} KiB attachment limit. Attach a smaller selection instead.", basename(resource), CLOUDCODE_MAX_ATTACHMENT_BYTES / 1024));
		}
	}

	private assertContent(content: string, resource: URI): void {
		this.assertSize(VSBuffer.fromString(content).byteLength, resource);
		if (content.includes('\0')) {
			throw this.binaryFileError(resource);
		}
	}

	private binaryFileError(resource: URI): Error {
		return new Error(localize('cloudCode.context.binary', "'{0}' contains binary data. Attach a text file or a PNG, JPEG, GIF, or WebP image.", basename(resource)));
	}

	private resourceLabel(resource: URI): string {
		const folder = this.workspaceContextService.getWorkspaceFolder(resource);
		if (!folder) {
			return basename(resource);
		}
		const path = relativePath(folder.uri, resource) ?? basename(resource);
		return this.workspaceContextService.getWorkspace().folders.length > 1 ? `${folder.name}/${path}` : path;
	}
}

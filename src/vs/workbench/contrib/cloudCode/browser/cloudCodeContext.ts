/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { getCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService, TextFileOperationError, TextFileOperationResult } from '../../../services/textfile/common/textfiles.js';
import { CLOUDCODE_MAX_ATTACHMENT_BYTES, CLOUDCODE_MAX_ATTACHMENTS, CLOUDCODE_MAX_ATTACHMENTS_BYTES, CloudCodeAttachmentKind, ICloudCodeAttachment } from '../common/cloudCodeChatContext.js';

/** Reads only explicitly attached text, capturing editor buffers without saving them. */
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
		const uniqueResources = [...new Map(resources.map(resource => [resource.toString(), resource])).values()];
		if (uniqueResources.length > CLOUDCODE_MAX_ATTACHMENTS) {
			throw new Error(localize('cloudCode.context.tooMany', "Attach up to {0} files at a time.", CLOUDCODE_MAX_ATTACHMENTS));
		}
		const attachments: ICloudCodeAttachment[] = [];
		let totalBytes = 0;
		for (const resource of uniqueResources) {
			const attachment = await this.readFile(resource);
			totalBytes += VSBuffer.fromString(attachment.content).byteLength;
			if (totalBytes > CLOUDCODE_MAX_ATTACHMENTS_BYTES) {
				throw new Error(localize('cloudCode.context.batchTooLarge', "Attachments must total {0} KiB or less. Choose fewer files or attach a selection.", CLOUDCODE_MAX_ATTACHMENTS_BYTES / 1024));
			}
			attachments.push(attachment);
		}
		return attachments;
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
		this.assertContent(content, resource);
		return { id: resource.toString(), label: this.resourceLabel(resource), content };
	}

	private snapshotModel(model: ITextModel, range?: IRange): ICloudCodeAttachment {
		this.assertSupportedResource(model.uri, true);
		const length = range ? model.getValueLengthInRange(range) : model.getValueLength();
		this.assertSize(length, model.uri);
		const content = range ? model.getValueInRange(range) : model.getValue();
		this.assertContent(content, model.uri);
		const label = this.resourceLabel(model.uri);
		const endLine = range && range.endColumn === 1 && range.endLineNumber > range.startLineNumber ? range.endLineNumber - 1 : range?.endLineNumber;
		return {
			id: range ? `${model.uri.toString()}#${range.startLineNumber}:${range.startColumn}-${range.endLineNumber}:${range.endColumn}` : model.uri.toString(),
			label: range ? localize('cloudCode.context.selectionLabel', "{0}:{1}-{2}", label, range.startLineNumber, endLine) : label,
			content,
			languageId: model.getLanguageId(),
			...(range ? { startLine: range.startLineNumber, endLine } : {}),
		};
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
		return new Error(localize('cloudCode.context.binary', "'{0}' contains binary data. Only text files can be attached.", basename(resource)));
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CLOUDCODE_MAX_IMAGE_BYTES } from '../../../../platform/cloudCode/common/cloudCodeImages.js';
import { extractEditorsDropData, getPathForFile } from '../../../../platform/dnd/browser/dnd.js';
import { CLOUDCODE_MAX_ATTACHMENTS, ICloudCodeAttachment, mergeCloudCodeAttachments } from '../common/cloudCodeChatContext.js';
import { CloudCodeContext } from './cloudCodeContext.js';

/** Captures transfer data synchronously before Chromium clears the paste/drop event. */
export class CloudCodeAttachmentInput {
	constructor(
		private readonly context: CloudCodeContext,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) { }

	async readPaste(files: readonly File[], hasText: boolean): Promise<readonly ICloudCodeAttachment[]> {
		if (files.length) {
			return this.readFiles(files);
		}
		const resources = await this.clipboardService.readResources();
		if (resources.length) {
			return this.context.readResources(resources);
		}
		if (!hasText) {
			const image = await this.clipboardService.readImage();
			if (image.byteLength) {
				return [this.context.readFileData('Screenshot.png', image)];
			}
		}
		return [];
	}

	captureDrop(event: DragEvent): () => Promise<readonly ICloudCodeAttachment[]> {
		const resources = extractEditorsDropData(event).flatMap(editor => editor.resource ? [editor.resource] : []);
		const files = Array.from(event.dataTransfer?.files ?? []).filter(file => !getPathForFile(file));
		return async () => {
			if (resources.length + files.length > CLOUDCODE_MAX_ATTACHMENTS) {
				throw new Error(localize('cloudcode.tooManyDroppedFiles', "Attach up to {0} files at a time.", CLOUDCODE_MAX_ATTACHMENTS));
			}
			return mergeCloudCodeAttachments(await this.context.readResources(resources), await this.readFiles(files));
		};
	}

	private async readFiles(files: readonly File[]): Promise<readonly ICloudCodeAttachment[]> {
		this.context.assertWorkspaceTrusted();
		if (files.length > CLOUDCODE_MAX_ATTACHMENTS) {
			throw new Error(localize('cloudcode.tooManyDroppedFiles', "Attach up to {0} files at a time.", CLOUDCODE_MAX_ATTACHMENTS));
		}
		let attachments: readonly ICloudCodeAttachment[] = [];
		for (const file of files) {
			if (file.size > CLOUDCODE_MAX_IMAGE_BYTES) {
				throw new Error(localize('cloudcode.imageTooLarge', "Images must be 4 MiB or smaller."));
			}
			const bytes = new Uint8Array(await file.arrayBuffer());
			attachments = mergeCloudCodeAttachments(attachments, [this.context.readFileData(file.name, bytes)]);
		}
		return attachments;
	}
}

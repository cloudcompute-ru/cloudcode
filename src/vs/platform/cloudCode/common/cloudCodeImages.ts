/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64 } from '../../../base/common/buffer.js';

export const CLOUDCODE_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const CLOUDCODE_MAX_IMAGES_BYTES = 8 * 1024 * 1024;
export const CLOUDCODE_MAX_IMAGES = 5;

export interface ICloudCodeImage {
	readonly dataUrl: string;
}

/** Only raster formats accepted by the inference endpoint may be previewed or sent. */
export function cloudCodeImageMimeType(bytes: Uint8Array): string | undefined {
	if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
		return 'image/png';
	}
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
		return 'image/jpeg';
	}
	const header = String.fromCharCode(...bytes.subarray(0, 12));
	if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
		return 'image/gif';
	}
	if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
		return 'image/webp';
	}
	return undefined;
}

/** Validate inline data at the IPC boundary; remote URLs and SVG are never accepted. */
export function cloudCodeImageBytes(dataUrl: string): number | undefined {
	if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(CLOUDCODE_MAX_IMAGE_BYTES / 3) * 4 + 32) {
		return undefined;
	}
	const prefix = /^data:(?<mime>image\/(?:png|jpeg|gif|webp));base64,/.exec(dataUrl);
	if (!prefix) {
		return undefined;
	}
	const data = dataUrl.slice(prefix[0].length);
	const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
	const body = padding ? data.slice(0, -padding) : data;
	const size = data.length / 4 * 3 - padding;
	if (!data.length || data.length % 4 || /[^A-Za-z0-9+/]/.test(body) || size > CLOUDCODE_MAX_IMAGE_BYTES || cloudCodeImageMimeType(decodeBase64(data.slice(0, 32)).buffer) !== prefix.groups!.mime) {
		return undefined;
	}
	return size;
}

/** Enforce the shared image budget across all retained conversation turns. */
export function cloudCodeImagesWithinLimit(images: readonly ICloudCodeImage[]): boolean {
	if (images.length > CLOUDCODE_MAX_IMAGES) {
		return false;
	}
	let total = 0;
	for (const image of images) {
		const size = cloudCodeImageBytes(image?.dataUrl);
		if (size === undefined || (total += size) > CLOUDCODE_MAX_IMAGES_BYTES) {
			return false;
		}
	}
	return true;
}

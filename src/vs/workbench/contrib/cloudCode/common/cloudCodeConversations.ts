/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ICloudCodeAccount, ICloudCodeMessage } from '../../../../platform/cloudCode/common/cloudCode.js';
import { cloudCodeImagesWithinLimit } from '../../../../platform/cloudCode/common/cloudCodeImages.js';
import { ICloudCodeChatMessage } from './cloudCodeChat.js';
import { ICloudCodeAttachment, mergeCloudCodeAttachments } from './cloudCodeChatContext.js';
import { CloudCodeChatMode } from './cloudCodeEdits.js';

export interface ICloudCodeConversation {
	readonly id: string;
	readonly title: string;
	readonly messages: readonly ICloudCodeChatMessage[];
	readonly history: readonly ICloudCodeMessage[];
	readonly attachments: readonly ICloudCodeAttachment[];
	readonly draft: string;
	readonly mode: CloudCodeChatMode;
	readonly model?: string;
}

export interface ICloudCodeConversationArchive {
	readonly conversations: readonly ICloudCodeConversation[];
	readonly activeId: string;
}

export interface ICloudCodeConversationStorage {
	scope(account: ICloudCodeAccount): string;
	read(scope: string): string | undefined;
	write(scope: string, value: string): void;
}

const maxArchiveLength = 32 * 1024 * 1024;

/** Keep recent chats within a bounded local archive, including the active conversation. */
export function serializeCloudCodeConversations(archive: ICloudCodeConversationArchive): string {
	const conversations = [...archive.conversations];
	while (conversations.length > 30) {
		conversations.splice(conversations.findIndex(conversation => conversation.id !== archive.activeId), 1);
	}
	let result = JSON.stringify({ conversations, activeId: archive.activeId });
	while (result.length > maxArchiveLength && conversations.length > 1) {
		const index = conversations.findIndex(conversation => conversation.id !== archive.activeId);
		conversations.splice(index, 1);
		result = JSON.stringify({ conversations, activeId: archive.activeId });
	}
	if (result.length > maxArchiveLength) {
		throw new Error(localize('cloudcode.historyFull', "Chat history exceeds local storage capacity."));
	}
	return result;
}

/** Stored local data is untrusted; validate it before using it as UI or model context. */
export function parseCloudCodeConversations(value: string | undefined): ICloudCodeConversationArchive | undefined {
	if (!value || value.length > maxArchiveLength) {
		return undefined;
	}
	try {
		const archive: unknown = JSON.parse(value);
		if (!isObject(archive) || !Array.isArray(archive.conversations) || archive.conversations.length > 30 || typeof archive.activeId !== 'string') {
			return undefined;
		}
		const conversations = archive.conversations;
		if (!conversations.every(isConversation) || new Set(conversations.map(conversation => conversation.id)).size !== conversations.length) {
			return undefined;
		}
		return { conversations, activeId: archive.activeId };
	} catch {
		return undefined;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAttachment(value: unknown): value is ICloudCodeAttachment {
	if (!isObject(value) || typeof value.id !== 'string' || typeof value.label !== 'string' || value.label.length > 4096 || typeof value.content !== 'string') {
		return false;
	}
	if (value.resource !== undefined && typeof value.resource !== 'string' || value.languageId !== undefined && typeof value.languageId !== 'string') {
		return false;
	}
	for (const key of ['startLine', 'endLine']) {
		if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1)) {
			return false;
		}
	}
	const range = value.range;
	if (range !== undefined && (!isObject(range) || !['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn'].every(key => typeof range[key] === 'number' && Number.isSafeInteger(range[key]) && range[key] > 0))) {
		return false;
	}
	if (value.image !== undefined && (!isObject(value.image) || typeof value.image.dataUrl !== 'string' || !cloudCodeImagesWithinLimit([{ dataUrl: value.image.dataUrl }]))) {
		return false;
	}
	try {
		mergeCloudCodeAttachments([], [value as object as ICloudCodeAttachment]);
		return true;
	} catch {
		return false;
	}
}

function isConversation(value: unknown): value is ICloudCodeConversation {
	if (!isObject(value) || typeof value.id !== 'string' || value.id.length > 100 || typeof value.title !== 'string' || value.title.length > 100
		|| typeof value.draft !== 'string' || value.draft.length > 65536 || !['ask', 'agent', 'edit'].includes(value.mode as string)
		|| value.model !== undefined && typeof value.model !== 'string') {
		return false;
	}
	if (!Array.isArray(value.messages) || value.messages.length > 512 || !value.messages.every(message => isObject(message)
		&& ['user', 'assistant'].includes(message.role as string) && typeof message.text === 'string' && message.text.length <= 2097152
		&& (message.incomplete === undefined || typeof message.incomplete === 'boolean') && message.progress === undefined
		&& (message.activity === undefined || Array.isArray(message.activity) && message.activity.length <= 100 && message.activity.every(item => typeof item === 'string' && item.length <= 4096))
		&& (message.attachments === undefined || Array.isArray(message.attachments) && message.attachments.length <= 5 && message.attachments.every(isAttachment)))) {
		return false;
	}
	if (!Array.isArray(value.history) || value.history.length > 32 || !value.history.every(message => isObject(message)
		&& ['user', 'assistant'].includes(message.role as string) && typeof message.content === 'string' && message.content.length <= 2097152
		&& (message.images === undefined || message.role === 'user' && Array.isArray(message.images) && message.images.every(image => isObject(image) && typeof image.dataUrl === 'string' && cloudCodeImagesWithinLimit([{ dataUrl: image.dataUrl }]))))) {
		return false;
	}
	return Array.isArray(value.attachments) && value.attachments.length <= 5 && value.attachments.every(isAttachment);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICloudCodeConversation, parseCloudCodeConversations, serializeCloudCodeConversations } from '../../common/cloudCodeConversations.js';

suite('CloudCode conversation storage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const chat: ICloudCodeConversation = { id: 'first', title: 'Review package.json', draft: 'Check the scripts', mode: 'agent', model: 'model', attachments: [], messages: [{ role: 'user', text: 'Review package.json' }], history: [] };

	test('round trips conversation state', () => {
		const archive = { conversations: [chat], activeId: chat.id };
		assert.deepStrictEqual(parseCloudCodeConversations(serializeCloudCodeConversations(archive)), archive);
	});

	test('retains the active conversation and newest chats when the archive is full', () => {
		const conversations = Array.from({ length: 34 }, (_, index) => ({ ...chat, id: String(index) }));
		const archive = parseCloudCodeConversations(serializeCloudCodeConversations({ conversations, activeId: '0' }))!;
		assert.deepStrictEqual({ ids: archive.conversations.map(chat => chat.id), activeId: archive.activeId }, {
			ids: ['0', ...Array.from({ length: 29 }, (_, index) => String(index + 5))], activeId: '0'
		});
	});

	test('rejects malformed state, duplicate IDs, stale progress, and remote image URLs', () => {
		const invalid = [undefined, '{', '{}', JSON.stringify({ conversations: [chat, chat], activeId: chat.id }),
			JSON.stringify({ conversations: [{ ...chat, messages: [{ role: 'assistant', text: '', progress: 'Reading files' }] }], activeId: chat.id }),
			JSON.stringify({ conversations: [{ ...chat, history: [{ role: 'user', content: 'Screenshot', images: [{ dataUrl: 'https://example.com/image.png' }] }] }], activeId: chat.id }),
			JSON.stringify({ conversations: [{ ...chat, attachments: [{ id: 'image', label: 'image.png', content: '', image: { dataUrl: 'https://example.com/image.png' } }] }], activeId: chat.id })];
		assert.deepStrictEqual(invalid.map(parseCloudCodeConversations), invalid.map(() => undefined));
	});
});

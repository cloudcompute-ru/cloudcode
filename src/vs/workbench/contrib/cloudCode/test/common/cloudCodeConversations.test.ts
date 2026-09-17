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

	test('round trips proposal metadata and rejects malformed proposal states', () => {
		const conversation = { ...chat, messages: [{ role: 'user' as const, text: 'Fix the version' }, { role: 'assistant' as const, text: 'Proposed an update.', proposedEdits: true }] };
		const archive = { conversations: [conversation], activeId: chat.id };
		assert.deepStrictEqual(parseCloudCodeConversations(serializeCloudCodeConversations(archive)), archive);
		for (const message of [{ role: 'assistant', text: 'Update', proposedEdits: 'applied' }, { role: 'user', text: 'Update', proposedEdits: true }]) {
			assert.strictEqual(parseCloudCodeConversations(JSON.stringify({ ...archive, conversations: [{ ...chat, messages: [message] }] })), undefined);
		}
	});

	test('persists unread file references and rejects references containing fake snapshots', () => {
		const reference = { id: 'file', label: 'package-lock.json', resource: 'file:///project/package-lock.json', content: '', reference: true as const };
		const archive = { conversations: [{ ...chat, attachments: [reference] }], activeId: chat.id };
		assert.deepStrictEqual(parseCloudCodeConversations(serializeCloudCodeConversations(archive)), archive);
		for (const invalid of [{ ...reference, content: 'fake snapshot' }, { ...reference, resource: undefined }, { ...reference, reference: false }]) {
			assert.strictEqual(parseCloudCodeConversations(JSON.stringify({ ...archive, conversations: [{ ...chat, attachments: [invalid] }] })), undefined);
		}
	});

	test('round trips inline token positions and rejects references that do not match an attachment', () => {
		const conversation = { ...chat, draft: 'Review [file.json] next', draftReferences: [{ id: 'file', start: 7, end: 18 }], attachments: [{ id: 'file', label: 'file.json', content: '{}' }] };
		const archive = { conversations: [conversation], activeId: chat.id };
		assert.deepStrictEqual(parseCloudCodeConversations(serializeCloudCodeConversations(archive)), archive);
		assert.strictEqual(parseCloudCodeConversations(JSON.stringify({ ...archive, conversations: [{ ...conversation, draftReferences: [{ id: 'missing', start: 7, end: 18 }] }] })), undefined);
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

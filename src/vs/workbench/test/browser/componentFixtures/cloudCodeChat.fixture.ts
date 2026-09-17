/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CloudCodeChatWidget } from '../../../contrib/cloudCode/browser/cloudCodeChatWidget.js';
import { CloudCodeChatStatus } from '../../../contrib/cloudCode/common/cloudCodeChat.js';
import { CloudCodeEditingSessionStatus } from '../../../contrib/cloudCode/common/cloudCodeEditingSession.js';
import { ComponentFixtureContext, defineComponentFixture, defineThemedFixtureGroup } from './fixtureUtils.js';

function renderChat({ container, disposableStore }: ComponentFixtureContext, status: CloudCodeChatStatus, variant?: 'signingIn' | 'error' | 'incomplete'): CloudCodeChatWidget {
	container.style.width = '360px';
	container.style.height = '600px';
	container.style.backgroundColor = 'var(--vscode-sideBar-background)';
	const widget = disposableStore.add(new CloudCodeChatWidget(container));
	widget.setSession(status === 'disconnected' ? { status: variant === 'signingIn' ? 'signingIn' : 'signedOut' } : {
		status: 'signedIn',
		persisted: true,
		account: {
			user: { id: 1, name: 'Alex', email: 'alex@example.com' },
			team: { id: 1, name: 'My workspace' },
			balance: null
		}
	});
	widget.setModels(status === 'loading' ? [] : [{ id: 'example-model', name: 'Example chat model' }], status === 'loading' ? undefined : 'example-model', status === 'loading');
	if (status !== 'disconnected') {
		widget.setMessages([
			{ role: 'user', text: 'How do I debounce a search input?' },
			{ role: 'assistant', text: 'Keep a timer and cancel it when the input changes. Start a new timer for each keystroke, then run the search when it expires.', incomplete: variant === 'incomplete' }
		]);
	}
	if (variant === 'error') {
		widget.setError('Your CloudCompute balance is insufficient. Add funds to continue chatting.');
	}
	widget.setStatus(status);
	return widget;
}

function renderTask(context: ComponentFixtureContext, status: CloudCodeEditingSessionStatus, reviewed = false): void {
	const widget = renderChat(context, 'ready');
	widget.setMessages([
		{ role: 'user', text: 'Add debounced search and update the tests.' },
		{ role: 'assistant', text: 'Prepared the search helper and tests. Review the combined changes below.', proposedEdits: true }
	]);
	widget.setEditingSessions([{
		id: 'example-task', title: 'Add debounced search and update the tests', status, reviewed,
		changes: [{ kind: 'edit', path: 'src/search.ts' }, { kind: 'create', path: 'src/utils/debounce.ts' }, { kind: 'rename', path: 'test/search.test.ts', newPath: 'test/search/debouncedSearch.test.ts' }, { kind: 'delete', path: 'src/legacySearch.ts' }],
		...(status === 'partial' ? { error: 'Some changes could not be applied because a file changed during the review.' } : {})
	}], false);
}

export default defineThemedFixtureGroup({ path: 'cloudCode/' }, {
	Disconnected: defineComponentFixture({ render: context => { renderChat(context, 'disconnected'); } }),
	SigningIn: defineComponentFixture({ render: context => { renderChat(context, 'disconnected', 'signingIn'); } }),
	LoadingModels: defineComponentFixture({ render: context => { renderChat(context, 'loading'); } }),
	Conversation: defineComponentFixture({ render: context => { renderChat(context, 'ready'); } }),
	Running: defineComponentFixture({ render: context => { renderChat(context, 'running'); } }),
	Error: defineComponentFixture({ render: context => { renderChat(context, 'ready', 'error'); } }),
	Stopped: defineComponentFixture({ render: context => { renderChat(context, 'ready', 'incomplete'); } }),
	TaskReview: defineComponentFixture({ render: context => renderTask(context, 'pending') }),
	TaskReviewed: defineComponentFixture({ render: context => renderTask(context, 'pending', true) }),
	TaskApplied: defineComponentFixture({ render: context => renderTask(context, 'applied', true) }),
	TaskPartial: defineComponentFixture({ render: context => renderTask(context, 'partial', true) }),
});

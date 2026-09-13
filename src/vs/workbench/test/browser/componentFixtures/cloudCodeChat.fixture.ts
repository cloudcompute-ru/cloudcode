/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CloudCodeChatWidget } from '../../../contrib/cloudCode/browser/cloudCodeChatWidget.js';
import { CloudCodeChatStatus } from '../../../contrib/cloudCode/common/cloudCodeChat.js';
import { ComponentFixtureContext, defineComponentFixture, defineThemedFixtureGroup } from './fixtureUtils.js';

function renderChat({ container, disposableStore }: ComponentFixtureContext, status: CloudCodeChatStatus, variant?: 'signingIn' | 'error' | 'incomplete'): void {
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
}

export default defineThemedFixtureGroup({ path: 'cloudCode/' }, {
	Disconnected: defineComponentFixture({ render: context => renderChat(context, 'disconnected') }),
	SigningIn: defineComponentFixture({ render: context => renderChat(context, 'disconnected', 'signingIn') }),
	LoadingModels: defineComponentFixture({ render: context => renderChat(context, 'loading') }),
	Conversation: defineComponentFixture({ render: context => renderChat(context, 'ready') }),
	Running: defineComponentFixture({ render: context => renderChat(context, 'running') }),
	Error: defineComponentFixture({ render: context => renderChat(context, 'ready', 'error') }),
	Stopped: defineComponentFixture({ render: context => renderChat(context, 'ready', 'incomplete') }),
});

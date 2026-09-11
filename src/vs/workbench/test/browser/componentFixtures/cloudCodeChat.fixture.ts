/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CloudCodeChatStatus, CloudCodeChatWidget } from '../../../contrib/cloudCode/browser/cloudCodeChatWidget.js';
import { ComponentFixtureContext, defineComponentFixture, defineThemedFixtureGroup } from './fixtureUtils.js';

function renderChat({ container, disposableStore }: ComponentFixtureContext, status: CloudCodeChatStatus): void {
	container.style.width = '360px';
	container.style.height = '600px';
	container.style.backgroundColor = 'var(--vscode-sideBar-background)';
	const widget = disposableStore.add(new CloudCodeChatWidget(container));
	if (status !== 'disconnected') {
		widget.setMessages([
			{ role: 'user', text: 'Where should I start exploring this project?' },
			{ role: 'assistant', text: 'This is sample content for reviewing the conversation layout.\n\nThe CloudCode panel does not connect to a model yet.' }
		]);
	}
	widget.setStatus(status);
}

export default defineThemedFixtureGroup({ path: 'cloudCode/' }, {
	Disconnected: defineComponentFixture({ render: context => renderChat(context, 'disconnected') }),
	Conversation: defineComponentFixture({ render: context => renderChat(context, 'ready') }),
	Running: defineComponentFixture({ render: context => renderChat(context, 'running') }),
});

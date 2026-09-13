/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/cloudCodeChat.css';
import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles, defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';

export interface ICloudCodeChatMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

export type CloudCodeChatStatus = 'disconnected' | 'ready' | 'running';

/**
 * Presentation only. The workbench starts disconnected; a future controller can
 * supply messages and status and listen to user actions without changing the UI.
 */
export class CloudCodeChatWidget extends Disposable {

	readonly domNode: HTMLElement;
	private readonly conversation: HTMLElement;
	private readonly emptyState: HTMLElement;
	private readonly messages: HTMLElement;
	private readonly prompt: HTMLTextAreaElement;
	private readonly statusLabel: HTMLElement;
	private readonly connectionHint: HTMLElement;
	private readonly progressBar: ProgressBar;
	private readonly sendButton: Button;
	private readonly stopButton: Button;
	private status: CloudCodeChatStatus = 'disconnected';

	private readonly submitEmitter = this._register(new Emitter<string>());
	readonly onDidSubmit = this.submitEmitter.event;
	private readonly stopEmitter = this._register(new Emitter<void>());
	readonly onDidStop = this.stopEmitter.event;

	constructor(parent: HTMLElement) {
		super();

		this.domNode = dom.append(parent, dom.$('.cloudcode-chat'));
		this.conversation = dom.append(this.domNode, dom.$('.cloudcode-chat-conversation', {
			role: 'region',
			'aria-label': localize('cloudcode.conversation', "Conversation"),
			tabIndex: 0
		}));

		this.emptyState = dom.append(this.conversation, dom.$('.cloudcode-chat-empty'));
		dom.append(this.emptyState, dom.$('h2')).textContent = localize('cloudcode.welcome', "Start a conversation");
		dom.append(this.emptyState, dom.$('p')).textContent = localize('cloudcode.welcomeDetail', "Ask a question about your code or describe what you want to build.");
		this.messages = dom.append(this.conversation, dom.$('.cloudcode-chat-messages', {
			role: 'log',
			'aria-label': localize('cloudcode.messages', "Chat messages"),
			'aria-live': 'polite',
			'aria-relevant': 'additions text'
		}));

		const composer = dom.append(this.domNode, dom.$('.cloudcode-chat-composer'));
		const progress = dom.append(composer, dom.$('.cloudcode-chat-progress'));
		this.progressBar = this._register(new ProgressBar(progress, {
			...defaultProgressBarStyles,
			ariaLabel: localize('cloudcode.progress', "CloudCode response in progress")
		}));

		const promptLabel = dom.append(composer, dom.$('label.cloudcode-chat-prompt-label'));
		dom.append(promptLabel, dom.$('span')).textContent = localize('cloudcode.message', "Message");
		this.prompt = dom.append(promptLabel, dom.$('textarea.cloudcode-chat-prompt', {
			rows: 4,
			placeholder: localize('cloudcode.promptPlaceholder', "Ask CloudCode…")
		}));

		const footer = dom.append(composer, dom.$('.cloudcode-chat-footer'));
		this.statusLabel = dom.append(footer, dom.$('.cloudcode-chat-status', { role: 'status', 'aria-live': 'polite' }));
		const actions = dom.append(footer, dom.$('.cloudcode-chat-actions'));
		this.stopButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		this.stopButton.label = localize('cloudcode.stop', "Stop");
		this.sendButton = this._register(new Button(actions, defaultButtonStyles));
		this.sendButton.label = localize('cloudcode.send', "Send");

		this.connectionHint = dom.append(composer, dom.$('p.cloudcode-chat-hint'));
		this.connectionHint.textContent = localize('cloudcode.disconnectedHint', "Chat is not connected yet. Messages cannot be sent.");

		this._register(dom.addDisposableListener(this.prompt, dom.EventType.INPUT, () => this.updateControls()));
		this._register(dom.addDisposableListener(this.prompt, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && this.status === 'ready') {
				event.preventDefault();
				this.submit();
			}
		}));
		this._register(this.sendButton.onDidClick(() => this.submit()));
		this._register(this.stopButton.onDidClick(() => {
			if (this.status === 'running') {
				this.stopEmitter.fire();
			}
		}));
		this.setStatus('disconnected');
	}

	/** Renders plain text without interpreting model or user content as HTML. */
	setMessages(messages: readonly ICloudCodeChatMessage[]): void {
		const wasAtBottom = this.conversation.scrollHeight - this.conversation.scrollTop - this.conversation.clientHeight < 20;
		dom.clearNode(this.messages);
		this.emptyState.hidden = messages.length > 0;
		for (const message of messages) {
			const row = dom.append(this.messages, dom.$('.cloudcode-chat-message'));
			row.classList.toggle('user', message.role === 'user');
			dom.append(row, dom.$('h3')).textContent = message.role === 'user'
				? localize('cloudcode.user', "You")
				: localize('cloudcode.assistant', "CloudCode");
			dom.append(row, dom.$('p')).textContent = message.text;
		}
		if (wasAtBottom) {
			this.conversation.scrollTop = this.conversation.scrollHeight;
		}
	}

	/** Updates visual state only; this never starts or cancels inference. */
	setStatus(status: CloudCodeChatStatus): void {
		this.status = status;
		this.domNode.classList.toggle('running', status === 'running');
		this.statusLabel.textContent = status === 'running'
			? localize('cloudcode.working', "Working…")
			: status === 'ready'
				? localize('cloudcode.ready', "Ready")
				: localize('cloudcode.disconnected', "Not connected");
		this.connectionHint.hidden = status !== 'disconnected';
		if (status === 'running') {
			this.progressBar.infinite().show();
		} else {
			this.progressBar.stop().hide();
		}
		this.updateControls();
	}

	focus(): void {
		this.prompt.focus();
	}

	private updateControls(): void {
		this.sendButton.enabled = this.status === 'ready' && this.prompt.value.trim().length > 0;
		this.stopButton.enabled = this.status === 'running';
	}

	private submit(): void {
		const prompt = this.prompt.value.trim();
		if (this.status !== 'ready' || !prompt) {
			return;
		}
		this.prompt.value = '';
		this.updateControls();
		this.submitEmitter.fire(prompt);
		this.focus();
	}
}

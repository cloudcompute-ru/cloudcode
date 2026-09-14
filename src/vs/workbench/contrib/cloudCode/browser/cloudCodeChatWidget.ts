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
import { ICloudCodeModel, ICloudCodeState } from '../../../../platform/cloudCode/common/cloudCode.js';
import { defaultButtonStyles, defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { CloudCodeChatStatus, ICloudCodeChatMessage, ICloudCodeChatView } from '../common/cloudCodeChat.js';

/** Presentation only; browser sign-in and inference run through the controller. */
export class CloudCodeChatWidget extends Disposable implements ICloudCodeChatView {

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
	private readonly header: HTMLElement;
	private readonly accountLabel: HTMLElement;
	private readonly sessionHint: HTMLElement;
	private readonly accountButton: Button;
	private readonly modelPicker: HTMLElement;
	private readonly modelButton: Button;
	private models: readonly ICloudCodeModel[] = [];
	private selectedModel: string | undefined;
	private readonly retryModelsButton: Button;
	private readonly errorLabel: HTMLElement;
	private responseText: Text | undefined;
	private state: ICloudCodeState = { status: 'signedOut' };
	private loadingModels = false;
	private status: CloudCodeChatStatus = 'disconnected';

	private readonly submitEmitter = this._register(new Emitter<string>());
	readonly onDidSubmit = this.submitEmitter.event;
	private readonly stopEmitter = this._register(new Emitter<void>());
	readonly onDidStop = this.stopEmitter.event;
	private readonly signInEmitter = this._register(new Emitter<void>());
	readonly onDidSignIn = this.signInEmitter.event;
	private readonly cancelSignInEmitter = this._register(new Emitter<void>());
	readonly onDidCancelSignIn = this.cancelSignInEmitter.event;
	private readonly signOutEmitter = this._register(new Emitter<void>());
	readonly onDidSignOut = this.signOutEmitter.event;
	private readonly newConversationEmitter = this._register(new Emitter<void>());
	readonly onDidNewConversation = this.newConversationEmitter.event;
	private readonly selectModelEmitter = this._register(new Emitter<string>());
	readonly onDidSelectModel = this.selectModelEmitter.event;
	private readonly retryModelsEmitter = this._register(new Emitter<void>());
	readonly onDidRetryModels = this.retryModelsEmitter.event;

	constructor(parent: HTMLElement, private readonly pickModel: (models: readonly ICloudCodeModel[], selected: string | undefined) => Promise<string | undefined> = async () => undefined) {
		super();

		this.domNode = dom.append(parent, dom.$('.cloudcode-chat'));
		const header = this.header = dom.append(this.domNode, dom.$('.cloudcode-chat-header'));
		this.accountLabel = dom.append(header, dom.$('.cloudcode-chat-account'));
		const accountActions = dom.append(header, dom.$('.cloudcode-chat-account-actions'));
		this.accountButton = this._register(new Button(accountActions, defaultButtonStyles));
		this.sessionHint = dom.append(header, dom.$('p.cloudcode-chat-hint'));
		this.conversation = dom.append(this.domNode, dom.$('.cloudcode-chat-conversation', {
			role: 'region',
			'aria-label': localize('cloudcode.conversation', "Conversation"),
			tabIndex: 0
		}));

		this.emptyState = dom.append(this.conversation, dom.$('.cloudcode-chat-empty'));
		dom.append(this.emptyState, dom.$('h2')).textContent = localize('cloudcode.welcome', "Start a conversation");
		dom.append(this.emptyState, dom.$('p')).textContent = localize('cloudcode.welcomeDetail', "Ask a coding question or paste a snippet. Project files are not attached automatically.");
		this.messages = dom.append(this.conversation, dom.$('.cloudcode-chat-messages', {
			role: 'log',
			'aria-label': localize('cloudcode.messages', "Chat messages"),
			'aria-live': 'polite',
			'aria-relevant': 'additions text'
		}));

		const composer = dom.append(this.domNode, dom.$('.cloudcode-chat-composer'));
		this.errorLabel = dom.append(composer, dom.$('p.cloudcode-chat-error', { role: 'alert' }));
		this.errorLabel.hidden = true;
		const progress = dom.append(composer, dom.$('.cloudcode-chat-progress'));
		this.progressBar = this._register(new ProgressBar(progress, {
			...defaultProgressBarStyles,
			ariaLabel: localize('cloudcode.progress', "CloudCode response in progress")
		}));

		const promptLabel = dom.append(composer, dom.$('label.cloudcode-chat-prompt-label'));
		this.prompt = dom.append(promptLabel, dom.$('textarea.cloudcode-chat-prompt', {
			rows: 3,
			'aria-label': localize('cloudcode.message', "Message"),
			placeholder: localize('cloudcode.promptPlaceholder', "Ask CloudCode…")
		}));

		const footer = dom.append(composer, dom.$('.cloudcode-chat-footer'));
		this.modelPicker = dom.append(footer, dom.$('.cloudcode-chat-model-picker'));
		this.modelButton = this._register(new Button(this.modelPicker, { ...defaultButtonStyles, secondary: true }));
		this.modelButton.element.classList.add('cloudcode-chat-model');
		this.retryModelsButton = this._register(new Button(this.modelPicker, { ...defaultButtonStyles, secondary: true }));
		this.retryModelsButton.label = localize('cloudcode.retryModels', "Retry");

		this.statusLabel = dom.append(composer, dom.$('.cloudcode-chat-status', { role: 'status', 'aria-live': 'polite' }));
		const actions = dom.append(footer, dom.$('.cloudcode-chat-actions'));
		this.stopButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		this.stopButton.label = localize('cloudcode.stop', "Stop");
		this.sendButton = this._register(new Button(actions, defaultButtonStyles));
		this.sendButton.label = localize('cloudcode.send', "Send");

		this.connectionHint = dom.append(composer, dom.$('p.cloudcode-chat-hint'));

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
		this._register(this.accountButton.onDidClick(() => {
			if (this.state.status === 'signedIn') {
				this.signOutEmitter.fire();
			} else if (this.state.status === 'signingIn') {
				this.cancelSignInEmitter.fire();
			} else {
				this.signInEmitter.fire();
			}
		}));
		this._register(this.retryModelsButton.onDidClick(() => this.retryModelsEmitter.fire()));
		this._register(this.modelButton.onDidClick(async () => {
			const models = this.models;
			const selected = await this.pickModel(models, this.selectedModel);
			if (!this._store.isDisposed && selected && models === this.models && this.state.status === 'signedIn' && this.status !== 'running' && this.models.some(model => model.id === selected)) {
				this.selectedModel = selected;
				this.updateModelLabel();
				this.selectModelEmitter.fire(selected);
			}
		}));
		this.setSession(this.state);
		this.setModels([], undefined, false);
		this.setStatus('disconnected');
	}

	setSession(state: ICloudCodeState): void {
		this.state = state;
		const account = state.account;
		this.accountLabel.textContent = state.status === 'signedIn' && account
			? localize('cloudcode.account', "{0} · {1}", account.user.name, account.team.name)
			: state.status === 'signingIn'
				? localize('cloudcode.signingIn', "Finish signing in in your browser…")
				: localize('cloudcode.signedOut', "Sign in with your CloudCompute account.");
		this.accountButton.label = state.status === 'signedIn'
			? localize('cloudcode.signOut', "Sign Out")
			: state.status === 'signingIn'
				? localize('cloudcode.cancelSignIn', "Cancel Sign-in")
				: localize('cloudcode.signIn', "Sign in to CloudCompute");
		this.accountButton.secondary = state.status !== 'signedOut';
		this.header.hidden = state.status === 'signedIn' && state.persisted !== false;
		this.accountLabel.hidden = state.status === 'signedIn';
		this.accountButton.element.hidden = state.status === 'signedIn';
		this.modelPicker.hidden = state.status !== 'signedIn';
		this.sessionHint.hidden = state.status !== 'signedIn' || state.persisted !== false;
		this.sessionHint.textContent = localize('cloudcode.sessionNotSaved', "This session could not be saved securely. Sign in again after restarting CloudCode.");
		this.updateControls();
	}

	setModels(models: readonly ICloudCodeModel[], selected: string | undefined, loading: boolean): void {
		this.loadingModels = loading;
		this.models = models;
		this.selectedModel = selected;
		this.updateModelLabel();
		this.retryModelsButton.element.hidden = loading || models.length > 0;
		this.updateControls();
	}

	/** Renders plain text without interpreting model or user content as HTML. */
	setMessages(messages: readonly ICloudCodeChatMessage[]): void {
		const wasAtBottom = this.conversation.scrollHeight - this.conversation.scrollTop - this.conversation.clientHeight < 20;
		dom.clearNode(this.messages);
		this.responseText = undefined;
		this.emptyState.hidden = messages.length > 0;
		for (const message of messages) {
			const row = dom.append(this.messages, dom.$('.cloudcode-chat-message'));
			row.classList.toggle('user', message.role === 'user');
			dom.append(row, dom.$('h3')).textContent = message.role === 'user'
				? localize('cloudcode.user', "You")
				: localize('cloudcode.assistant', "CloudCode");
			const body = dom.append(row, dom.$('p'));
			const text = body.ownerDocument.createTextNode(message.text);
			body.appendChild(text);
			if (message.role === 'assistant') {
				this.responseText = text;
			}
			if (message.incomplete) {
				dom.append(row, dom.$('p.cloudcode-chat-incomplete')).textContent = localize('cloudcode.incomplete', "Response incomplete. This question and response will not be included in the next message.");
			}
		}
		if (wasAtBottom) {
			this.conversation.scrollTop = this.conversation.scrollHeight;
		}
	}

	/** Adds a delta to the active text node, preserving existing transcript DOM and selection. */
	appendResponse(text: string): void {
		const wasAtBottom = this.conversation.scrollHeight - this.conversation.scrollTop - this.conversation.clientHeight < 20;
		this.responseText?.appendData(text);
		if (wasAtBottom) {
			this.conversation.scrollTop = this.conversation.scrollHeight;
		}
	}

	setError(message: string | undefined): void {
		this.errorLabel.textContent = message ?? '';
		this.errorLabel.hidden = !message;
	}

	setDraft(value: string): void {
		this.prompt.value = value;
		this.updateControls();
	}

	/** Updates visual state only; this never starts or cancels inference. */
	setStatus(status: CloudCodeChatStatus): void {
		this.status = status;
		this.domNode.classList.toggle('running', status === 'running');
		this.statusLabel.textContent = status === 'running'
			? localize('cloudcode.working', "Working…")
			: status === 'loading'
				? localize('cloudcode.loading', "Loading…")
				: status === 'ready'
					? localize('cloudcode.ready', "Ready")
					: localize('cloudcode.disconnected', "Not connected");
		this.connectionHint.hidden = status !== 'disconnected';
		this.connectionHint.textContent = this.state.status === 'signedIn'
			? localize('cloudcode.modelNeeded', "A chat model must be available before you can send a message.")
			: localize('cloudcode.signInNeeded', "Sign in to send messages using your CloudCompute balance.");
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
		this.modelButton.enabled = this.state.status === 'signedIn' && !this.loadingModels && this.status !== 'running' && this.models.length > 0;
		this.stopButton.element.hidden = this.status !== 'running';
	}

	newConversation(): void {
		this.newConversationEmitter.fire();
		this.focus();
	}

	private updateModelLabel(): void {
		this.modelButton.label = this.loadingModels
			? localize('cloudcode.loadingModels', "Loading models…")
			: this.models.find(model => model.id === this.selectedModel)?.name ?? localize('cloudcode.selectModel', "Select Model…");
		this.modelButton.element.setAttribute('aria-label', localize('cloudcode.searchModels', "Search Models: {0}", this.modelButton.label));
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

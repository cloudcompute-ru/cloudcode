/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { CLOUDCODE_MAX_CONTEXT_BYTES, CLOUDCODE_MAX_MESSAGE_LENGTH, CLOUDCODE_MAX_MESSAGES, ICloudCodeMessage, ICloudCodeModel, ICloudCodeService, ICloudCodeState } from '../../../../platform/cloudCode/common/cloudCode.js';
import { ICloudCodeChatMessage, ICloudCodeChatView } from './cloudCodeChat.js';

/** Owns one window's conversation and coordinates the shared native transport. */
export class CloudCodeChatController extends Disposable {

	private state: ICloudCodeState = { status: 'signedOut' };
	private revision = 0;
	private modelRequest = 0;
	private models: readonly ICloudCodeModel[] = [];
	private selectedModel: string | undefined;
	private loadingModels = false;
	private messages: ICloudCodeChatMessage[] = [];
	private history: ICloudCodeMessage[] = [];
	private activeRequest: { id: string; prompt: string; text: string } | undefined;
	private disposed = false;
	private cancellationOnDispose: Promise<void> = Promise.resolve();

	constructor(
		private readonly view: ICloudCodeChatView,
		@ICloudCodeService private readonly service: ICloudCodeService,
	) {
		super();
		this._register(service.onDidChangeState(state => {
			this.revision++;
			this.applyState(state);
		}));
		this._register(service.onDidReceiveChatDelta(delta => {
			if (this.activeRequest?.id === delta.requestId) {
				this.activeRequest.text += delta.text;
				this.view.appendResponse(delta.text);
			}
		}));
		this._register(view.onDidSubmit(prompt => void this.submit(prompt)));
		this._register(view.onDidStop(() => this.stop()));
		this._register(view.onDidSignIn(() => void this.signIn()));
		this._register(view.onDidCancelSignIn(() => void this.cancelSignIn()));
		this._register(view.onDidSignOut(() => void this.signOut()));
		this._register(view.onDidNewConversation(() => this.newConversation()));
		this._register(view.onDidRetryModels(() => void this.loadModels()));
		this._register(view.onDidSelectModel(model => {
			if (!this.activeRequest && this.models.some(candidate => candidate.id === model)) {
				this.selectedModel = model;
				this.updateStatus();
			}
		}));
	}

	async initialize(): Promise<void> {
		const revision = this.revision;
		try {
			const state = await this.service.getState();
			if (!this.disposed && this.revision === revision) {
				this.applyState(state);
			}
		} catch (error) {
			if (this.revision === revision) {
				this.showError(error);
			}
		}
	}

	private applyState(state: ICloudCodeState): void {
		const oldAccount = this.state.account;
		const accountChanged = oldAccount?.user.id !== state.account?.user.id || oldAccount?.team.id !== state.account?.team.id;
		const connectionChanged = this.state.status !== state.status;
		const wasSignedIn = this.state.status === 'signedIn';
		this.state = state;
		if (accountChanged || wasSignedIn && state.status !== 'signedIn') {
			this.newConversation();
		}
		if (accountChanged || state.status !== 'signedIn') {
			this.models = [];
			this.selectedModel = undefined;
			this.loadingModels = false;
			this.modelRequest++;
		}
		this.view.setSession(state);
		this.view.setModels(this.models, this.selectedModel, this.loadingModels);
		this.updateStatus();
		if (state.status === 'signedIn' && (connectionChanged || accountChanged)) {
			void this.loadModels();
		}
	}

	private async signIn(): Promise<void> {
		if (this.state.status !== 'signedOut') {
			return;
		}
		this.view.setError(undefined);
		try {
			await this.service.signIn();
		} catch (error) {
			this.showError(error);
		}
	}

	private async cancelSignIn(): Promise<void> {
		try {
			await this.service.cancelSignIn();
		} catch (error) {
			this.showError(error);
		}
	}

	private async signOut(): Promise<void> {
		this.stop();
		try {
			await this.service.signOut();
		} catch (error) {
			this.showError(error);
		}
	}

	private async loadModels(): Promise<void> {
		if (this.disposed || this.state.status !== 'signedIn' || this.loadingModels || this.activeRequest) {
			return;
		}
		const request = ++this.modelRequest;
		this.loadingModels = true;
		this.view.setError(undefined);
		this.view.setModels(this.models, this.selectedModel, true);
		this.updateStatus();
		try {
			const models = await this.service.getModels();
			if (this.disposed || request !== this.modelRequest) {
				return;
			}
			this.models = models;
			if (!models.some(model => model.id === this.selectedModel)) {
				this.selectedModel = models[0]?.id;
			}
			if (!models.length) {
				this.view.setError(localize('cloudcode.noModels', "No chat models are available for this account. Retry after a model becomes available."));
			}
		} catch (error) {
			if (request === this.modelRequest) {
				this.showError(error);
			}
		} finally {
			if (!this.disposed && request === this.modelRequest) {
				this.loadingModels = false;
				this.view.setModels(this.models, this.selectedModel, false);
				this.updateStatus();
			}
		}
	}

	private async submit(prompt: string): Promise<void> {
		prompt = prompt.trim();
		if (this.disposed || this.state.status !== 'signedIn' || !this.selectedModel || this.loadingModels || this.activeRequest || !prompt) {
			return;
		}
		const context: ICloudCodeMessage[] = [...this.history, { role: 'user', content: prompt }];
		const encoder = new TextEncoder();
		if (prompt.length > CLOUDCODE_MAX_MESSAGE_LENGTH) {
			this.view.setDraft(prompt);
			this.view.setError(localize('cloudcode.messageTooLong', "This message is too long. Shorten it before sending."));
			return;
		}
		if (context.length > CLOUDCODE_MAX_MESSAGES || context.some(message => message.content.length > CLOUDCODE_MAX_MESSAGE_LENGTH) || context.reduce((size, message) => size + encoder.encode(message.content).byteLength, 0) > CLOUDCODE_MAX_CONTEXT_BYTES) {
			this.view.setDraft(prompt);
			this.view.setError(localize('cloudcode.conversationTooLong', "This conversation has reached the chat context limit. Start a New Chat and shorten long messages to continue."));
			return;
		}
		const request = { id: generateUuid(), prompt, text: '' };
		this.activeRequest = request;
		this.messages.push({ role: 'user', text: prompt }, { role: 'assistant', text: '' });
		this.view.setError(undefined);
		this.view.setMessages(this.messages);
		this.updateStatus();
		try {
			const result = await this.service.streamChat(request.id, this.selectedModel, context);
			if (this.disposed || this.activeRequest !== request) {
				return;
			}
			this.finishResponse(result.cancelled);
		} catch (error) {
			if (!this.disposed && this.activeRequest === request) {
				this.finishResponse(true);
				this.showError(error);
			}
		}
	}

	private finishResponse(incomplete: boolean): void {
		const request = this.activeRequest;
		if (!request) {
			return;
		}
		this.messages[this.messages.length - 1] = { role: 'assistant', text: request.text, incomplete };
		if (!incomplete) {
			this.history.push({ role: 'user', content: request.prompt }, { role: 'assistant', content: request.text });
		}
		this.activeRequest = undefined;
		this.view.setMessages(this.messages);
		this.updateStatus();
	}

	private stop(): void {
		const request = this.activeRequest;
		if (request) {
			// Ignore subsequent deltas immediately, even while native cancellation is in flight.
			this.finishResponse(true);
			void this.service.cancelChat(request.id).catch(error => this.showError(error));
		}
	}

	private newConversation(): void {
		this.stop();
		this.messages = [];
		this.history = [];
		this.view.setMessages(this.messages);
		this.view.setDraft('');
		this.view.setError(undefined);
	}

	private updateStatus(): void {
		this.view.setStatus(this.activeRequest ? 'running' : this.loadingModels ? 'loading' : this.state.status === 'signedIn' && this.selectedModel ? 'ready' : 'disconnected');
	}

	private showError(error: unknown): void {
		if (!this.disposed) {
			this.view.setError(error instanceof Error ? error.message : localize('cloudcode.unexpectedError', "CloudCode could not complete this action. Please try again."));
		}
	}

	/** Gives window shutdown a chance to deliver cancellation to the shared process. */
	shutdown(): Promise<void> {
		this.dispose();
		return this.cancellationOnDispose;
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.modelRequest++;
		const request = this.activeRequest;
		this.activeRequest = undefined;
		if (request) {
			this.cancellationOnDispose = this.service.cancelChat(request.id).catch(() => { /* The window is closing. */ });
		}
		super.dispose();
	}
}

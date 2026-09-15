/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cloudCodeImagesWithinLimit } from '../../../../platform/cloudCode/common/cloudCodeImages.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { CLOUDCODE_MAX_CONTEXT_BYTES, CLOUDCODE_MAX_MESSAGE_LENGTH, CLOUDCODE_MAX_MESSAGES, ICloudCodeMessage, ICloudCodeModel, ICloudCodeService, ICloudCodeState } from '../../../../platform/cloudCode/common/cloudCode.js';
import { cloudCodeUserMessage, formatCloudCodePrompt, ICloudCodeAttachment, ICloudCodeContextProvider, mergeCloudCodeAttachments } from './cloudCodeChatContext.js';
import { ICloudCodeChatMessage, ICloudCodeChatView } from './cloudCodeChat.js';
import { ICloudCodeAgent } from './cloudCodeAgent.js';
import { CloudCodeChatMode, formatCloudCodeEditPrompt, ICloudCodeEditProposal, ICloudCodeEditProvider, ICloudCodeEditTarget, parseCloudCodeEdits } from './cloudCodeEdits.js';

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
	private attachments: readonly ICloudCodeAttachment[] = [];
	private attachmentRevision = 0;
	private loadingAttachments = false;
	private historyHasAttachments = false;
	private mode: CloudCodeChatMode;
	private editProposals: readonly ICloudCodeEditProposal[] = [];
	private editBusy = false;
	private editRevision = 0;
	private activeRequest: { id: string; message: ICloudCodeMessage; text: string; hasAttachments: boolean; targets?: readonly ICloudCodeEditTarget[] } | undefined;
	private activeAgent: { source: CancellationTokenSource; completion: Promise<void>; conversation: number; activity: string[] } | undefined;
	private agentConversation = 0;
	private disposed = false;
	private cancellationOnDispose: Promise<void> = Promise.resolve();

	constructor(
		private readonly view: ICloudCodeChatView,
		private readonly contextProvider: ICloudCodeContextProvider | undefined,
		private readonly editProvider: ICloudCodeEditProvider | undefined,
		private readonly agent: ICloudCodeAgent | undefined,
		@ICloudCodeService private readonly service: ICloudCodeService,
	) {
		super();
		this.mode = agent ? 'agent' : 'ask';
		this._register(service.onDidChangeState(state => {
			this.revision++;
			this.applyState(state);
		}));
		this._register(service.onDidReceiveChatDelta(delta => {
			if (this.activeRequest?.id === delta.requestId) {
				this.activeRequest.text += delta.text;
				if (!this.activeRequest.targets) {
					this.view.appendResponse(delta.text);
				}
			}
		}));
		this._register(view.onDidRequestAttachments(read => void this.attachContext(read || undefined)));
		this._register(view.onDidRemoveAttachment(id => {
			if (this.editBusy || this.running) {
				return;
			}
			this.attachments = this.attachments.filter(attachment => attachment.id !== id);
			this.view.setAttachments(this.attachments, this.loadingAttachments);
		}));
		this._register(view.onDidChangeMode(mode => {
			if (!this.running && !this.editBusy && !this.loadingAttachments && !this.hasPendingEdits()) {
				this.mode = mode;
			}
			this.view.setEditMode(this.mode);
		}));
		this._register(view.onDidReviewEdit(event => void this.reviewEdit(event.id, event.action)));
		this.view.setEditMode(this.mode);
		this.view.setEditProposals([], false);
		this._register(view.onDidSubmit(prompt => void this.submit(prompt)));
		this._register(view.onDidStop(() => this.stop()));
		this._register(view.onDidSignIn(() => void this.signIn()));
		this._register(view.onDidCancelSignIn(() => void this.cancelSignIn()));
		this._register(view.onDidSignOut(() => void this.signOut()));
		this._register(view.onDidNewConversation(() => this.newConversation()));
		this._register(view.onDidRetryModels(() => void this.loadModels()));
		this._register(view.onDidSelectModel(model => {
			if (!this.running && !this.editBusy && this.models.some(candidate => candidate.id === model)) {
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
		this.newConversation();
		try {
			await this.service.signOut();
		} catch (error) {
			this.showError(error);
		}
	}

	private async loadModels(): Promise<void> {
		if (this.disposed || this.state.status !== 'signedIn' || this.loadingModels || this.editBusy || this.running) {
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

	private async attachContext(read?: () => Promise<readonly ICloudCodeAttachment[]>): Promise<void> {
		if (!this.contextProvider || this.disposed || this.loadingAttachments || this.editBusy || this.hasPendingEdits() || this.running || this.state.status !== 'signedIn') {
			return;
		}
		const revision = ++this.attachmentRevision;
		this.loadingAttachments = true;
		this.view.setError(undefined);
		this.view.setAttachments(this.attachments, true);
		try {
			const attachments = await (read ? read() : this.contextProvider.pickAttachments());
			if (this.disposed || revision !== this.attachmentRevision) {
				return;
			}
			if (attachments.length) {
				this.contextProvider.assertWorkspaceTrusted();
			}
			this.attachments = mergeCloudCodeAttachments(this.attachments, attachments);
		} catch (error) {
			if (revision === this.attachmentRevision) {
				this.showError(error);
			}
		} finally {
			if (!this.disposed && revision === this.attachmentRevision) {
				this.loadingAttachments = false;
				this.view.setAttachments(this.attachments, false);
			}
		}
	}

	private async submit(prompt: string): Promise<void> {
		prompt = prompt.trim();
		if (this.disposed || this.state.status !== 'signedIn' || !this.selectedModel || this.loadingModels || this.loadingAttachments || this.editBusy || this.hasPendingEdits() || this.running || !prompt) {
			return;
		}
		if (this.models.find(model => model.id === this.selectedModel)?.supportsImages === false
			&& (this.attachments.some(attachment => attachment.image) || this.mode === 'ask' && this.history.some(message => message.images?.length))) {
			this.view.setDraft(prompt);
			this.view.setError(localize('cloudcode.imageModelNeeded', "Choose a model that supports images before sending screenshots."));
			return;
		}
		if (this.mode === 'agent') {
			this.submitAgent(prompt, this.selectedModel);
			return;
		}
		try {
			if (this.attachments.length || this.historyHasAttachments) {
				this.contextProvider?.assertWorkspaceTrusted();
			}
		} catch (error) {
			this.view.setDraft(prompt);
			this.showError(error);
			return;
		}
		let targets: readonly ICloudCodeEditTarget[] | undefined;
		if (this.mode === 'edit') {
			this.view.setDraft(prompt);
			if (!this.editProvider || !this.attachments.some(attachment => !attachment.image)) {
				this.view.setError(localize('cloudcode.editNeedsAttachments', "Attach a file or selection before requesting edits."));
				return;
			}
			this.clearEditProposals();
			const revision = this.editRevision;
			this.editBusy = true;
			this.view.setEditProposals(this.editProposals, true);
			this.updateStatus();
			try {
				targets = await this.editProvider.prepare(this.attachments.filter(attachment => !attachment.image));
				if (this.disposed || revision !== this.editRevision) {
					return;
				}
			} catch (error) {
				if (!this.disposed && revision === this.editRevision) {
					this.editProvider.clear();
					this.showError(error);
				}
				return;
			} finally {
				if (!this.disposed && revision === this.editRevision) {
					this.editBusy = false;
					this.view.setEditProposals(this.editProposals, false);
					this.updateStatus();
				}
			}
		}
		// Edit requests use only the current instruction and freshly validated targets.
		const content = targets ? formatCloudCodeEditPrompt(prompt, targets) : formatCloudCodePrompt(prompt, this.attachments);
		const message = cloudCodeUserMessage(content, this.attachments);
		const context: ICloudCodeMessage[] = [...(targets ? [] : this.history), message];
		const encoder = new TextEncoder();
		if (prompt.length > CLOUDCODE_MAX_MESSAGE_LENGTH) {
			if (targets) {
				this.editProvider?.clear();
			}
			this.view.setDraft(prompt);
			this.view.setError(localize('cloudcode.messageTooLong', "This message is too long. Shorten it before sending."));
			return;
		}
		if (content.length > CLOUDCODE_MAX_MESSAGE_LENGTH) {
			if (targets) {
				this.editProvider?.clear();
			}
			this.view.setDraft(prompt);
			this.view.setError(localize('cloudcode.messageAndContextTooLong', "The message and attachments are too long. Shorten the message or remove an attachment."));
			return;
		}
		if (!cloudCodeImagesWithinLimit(context.flatMap(message => message.images ?? [])) || context.length > CLOUDCODE_MAX_MESSAGES || context.some(message => message.content.length > CLOUDCODE_MAX_MESSAGE_LENGTH) || context.reduce((size, message) => size + encoder.encode(message.content).byteLength, 0) > CLOUDCODE_MAX_CONTEXT_BYTES) {
			this.view.setDraft(prompt);
			if (targets) {
				this.editProvider?.clear();
			}
			this.view.setError(localize('cloudcode.conversationTooLong', "This conversation has reached the chat context limit. Start a New Chat and shorten long messages to continue."));
			return;
		}
		const request = { id: generateUuid(), message, text: '', hasAttachments: this.attachments.length > 0, targets };
		this.activeRequest = request;
		this.messages.push({ role: 'user', text: prompt, attachments: this.attachments }, { role: 'assistant', text: '', progress: targets ? localize('cloudcode.preparingEdits', "Preparing proposed changes…") : undefined });
		this.view.setDraft('');
		this.attachments = [];
		this.view.setAttachments(this.attachments, false);
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

	private submitAgent(prompt: string, model: string): void {
		const agent = this.agent;
		if (!agent || prompt.length > CLOUDCODE_MAX_MESSAGE_LENGTH) {
			this.view.setDraft(prompt);
			this.view.setError(!agent
				? localize('cloudcode.agentUnavailable', "Agent mode is not available in this window.")
				: localize('cloudcode.messageTooLong', "This message is too long. Shorten it before sending."));
			return;
		}
		this.clearEditProposals();
		const disposables = new DisposableStore();
		const request = { source: disposables.add(new CancellationTokenSource()), completion: Promise.resolve(), conversation: this.agentConversation, activity: [] as string[] };
		this.activeAgent = request;
		const attachments = this.attachments;
		const responseIndex = this.messages.length + 1;
		this.messages.push({ role: 'user', text: prompt, attachments }, { role: 'assistant', text: '', progress: localize('cloudcode.agentStarting', "Exploring your project…") });
		this.attachments = [];
		this.history = [];
		this.historyHasAttachments = false;
		this.view.setAttachments([], false);
		this.view.setDraft('');
		this.view.setError(undefined);
		this.view.setMessages(this.messages);
		this.updateStatus();
		const isCurrent = () => !this.disposed && this.activeAgent === request && request.conversation === this.agentConversation;
		request.completion = (async () => {
			try {
				const result = await agent.run(prompt, attachments, model, request.source.token, message => {
					if (!isCurrent() || request.source.token.isCancellationRequested) {
						return;
					}
					request.activity.push(message);
					this.messages[responseIndex] = { role: 'assistant', text: '', progress: message, activity: [...request.activity] };
					this.view.setMessages(this.messages);
				});
				if (!isCurrent()) {
					return;
				}
				if (request.source.token.isCancellationRequested) {
					throw new CancellationError();
				}
				this.editProposals = result.edits.map(edit => ({ ...edit, id: generateUuid(), status: 'pending', reviewed: false }));
				this.messages[responseIndex] = { role: 'assistant', text: result.text, attachments: result.attachments, activity: [...request.activity] };
				if (!result.edits.length) {
					this.history = [cloudCodeUserMessage(formatCloudCodePrompt(prompt, result.attachments), result.attachments), { role: 'assistant', content: result.text }];
					this.historyHasAttachments = result.attachments.length > 0;
				}
				this.view.setEditProposals(this.editProposals, false);
				this.view.setMessages(this.messages);
			} catch (error) {
				if (isCurrent()) {
					const stopped = request.source.token.isCancellationRequested || isCancellationError(error);
					this.messages[responseIndex] = {
						role: 'assistant',
						text: stopped ? localize('cloudcode.agentStopped', "Agent stopped. No changes were applied.") : localize('cloudcode.agentFailed', "Agent could not complete this task. No changes were applied."),
						incomplete: true,
						activity: [...request.activity]
					};
					this.view.setMessages(this.messages);
					if (!stopped) {
						this.showError(error);
					}
				}
			} finally {
				disposables.dispose();
				if (this.activeAgent === request) {
					this.activeAgent = undefined;
					if (!this.disposed) {
						this.updateStatus();
						if (this.state.status === 'signedIn' && !this.selectedModel) {
							void this.loadModels();
						}
					}
				}
			}
		})();
	}

	private finishResponse(incomplete: boolean): void {
		const request = this.activeRequest;
		if (!request) {
			return;
		}
		let responseText = request.text;
		if (request.targets) {
			responseText = localize('cloudcode.editsIncomplete', "No changes were prepared. Attach the code again to retry.");
			if (!incomplete) {
				try {
					this.editProposals = parseCloudCodeEdits(request.text, request.targets).map(edit => ({ ...edit, id: generateUuid(), status: 'pending', reviewed: false }));
					responseText = this.editProposals.length
						? localize('cloudcode.editsReady', "Review each proposed diff, then accept or reject the change.")
						: localize('cloudcode.noEdits', "No changes were proposed.");
				} catch (error) {
					incomplete = true;
					this.showError(error);
				}
			}
			if (!this.editProposals.length) {
				this.editProvider?.clear();
			}
			this.view.setEditProposals(this.editProposals, false);
		}
		this.messages[this.messages.length - 1] = { role: 'assistant', text: responseText, incomplete };
		if (!incomplete && !request.targets) {
			this.historyHasAttachments ||= request.hasAttachments;
			this.history.push(request.message, { role: 'assistant', content: request.text });
		}
		this.activeRequest = undefined;
		this.view.setMessages(this.messages);
		this.updateStatus();
	}

	private hasPendingEdits(): boolean {
		return this.editProposals.some(proposal => proposal.status === 'pending');
	}

	private clearEditProposals(): void {
		this.editRevision++;
		this.editProvider?.clear();
		this.editProposals = [];
		this.editBusy = false;
		this.view.setEditProposals([], false);
	}

	private async reviewEdit(id: string, action: 'preview' | 'accept' | 'reject'): Promise<void> {
		if (this.disposed || !this.editProvider || this.editBusy || this.running || this.state.status !== 'signedIn') {
			return;
		}
		const proposal = this.editProposals.find(candidate => candidate.id === id);
		if (!proposal || proposal.status !== 'pending' || action === 'accept' && !proposal.reviewed) {
			return;
		}
		const revision = this.editRevision;
		this.editBusy = true;
		this.view.setError(undefined);
		this.view.setEditProposals(this.editProposals, true);
		this.updateStatus();
		try {
			if (action === 'preview') {
				await this.editProvider.preview(proposal);
			} else if (action === 'accept') {
				await this.editProvider.apply(proposal);
			}
			if (this.disposed || revision !== this.editRevision) {
				return;
			}
			this.editProposals = this.editProposals.map(candidate => candidate !== proposal ? candidate : {
				...proposal,
				status: action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'pending',
				reviewed: proposal.reviewed || action === 'preview',
				error: undefined
			});
			if (action === 'accept') {
				// Earlier source snapshots no longer describe the accepted editor contents.
				this.history = [];
				this.historyHasAttachments = false;
			}
			if (!this.hasPendingEdits()) {
				this.editProvider.clear();
				if (this.editProposals.some(candidate => candidate.status === 'accepted')) {
					this.messages.push({ role: 'assistant', text: localize('cloudcode.editsAccepted', "Changes are in the editor and can be undone with Undo. The next request starts fresh; attach the updated code for further changes.") });
					this.view.setMessages(this.messages);
				}
			}
		} catch (error) {
			if (!this.disposed && revision === this.editRevision) {
				const message = error instanceof Error ? error.message : localize('cloudcode.editFailed', "The proposed change could not be reviewed or applied.");
				this.editProposals = this.editProposals.map(candidate => candidate !== proposal ? candidate : { ...proposal, error: message, reviewed: false });
				this.showError(error);
			}
		} finally {
			if (!this.disposed && revision === this.editRevision) {
				this.editBusy = false;
				this.view.setEditProposals(this.editProposals, false);
				this.updateStatus();
			}
		}
	}

	private stop(): void {
		if (this.activeAgent) {
			this.activeAgent.source.cancel();
			this.editProvider?.clear();
			if (this.activeAgent.conversation === this.agentConversation) {
				this.messages[this.messages.length - 1] = {
					role: 'assistant',
					text: localize('cloudcode.agentStopped', "Agent stopped. No changes were applied."),
					incomplete: true,
					activity: [...this.activeAgent.activity]
				};
				this.view.setMessages(this.messages);
			}
		}
		const request = this.activeRequest;
		if (request) {
			// Ignore subsequent deltas immediately, even while native cancellation is in flight.
			this.finishResponse(true);
			void this.service.cancelChat(request.id).catch(error => this.showError(error));
		}
	}

	private newConversation(): void {
		this.agentConversation++;
		this.stop();
		this.clearEditProposals();
		this.attachmentRevision++;
		this.loadingAttachments = false;
		this.attachments = [];
		this.historyHasAttachments = false;
		this.view.setAttachments(this.attachments, false);
		this.messages = [];
		this.history = [];
		this.view.setMessages(this.messages);
		this.view.setDraft('');
		this.view.setError(undefined);
		this.updateStatus();
	}

	private updateStatus(): void {
		this.view.setStatus(this.running ? 'running' : this.loadingModels || this.editBusy ? 'loading' : this.state.status === 'signedIn' && this.selectedModel ? 'ready' : 'disconnected');
	}

	private get running(): boolean {
		return !!this.activeRequest || !!this.activeAgent;
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
		this.agentConversation++;
		this.activeAgent?.source.cancel();
		this.cancellationOnDispose = this.activeAgent?.completion ?? Promise.resolve();
		this.editRevision++;
		this.editProvider?.clear();
		this.modelRequest++;
		this.attachmentRevision++;
		const request = this.activeRequest;
		this.activeRequest = undefined;
		if (request) {
			this.cancellationOnDispose = Promise.all([this.cancellationOnDispose, this.service.cancelChat(request.id).catch(() => { /* The window is closing. */ })]).then(() => undefined);
		}
		super.dispose();
	}
}

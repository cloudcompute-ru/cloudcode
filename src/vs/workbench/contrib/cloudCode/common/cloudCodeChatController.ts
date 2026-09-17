/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cloudCodeImagesWithinLimit } from '../../../../platform/cloudCode/common/cloudCodeImages.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { ICloudCodeConversation, ICloudCodeConversationStorage, parseCloudCodeConversations, serializeCloudCodeConversations } from './cloudCodeConversations.js';
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
import { CloudCodeEditingSessionAction, ICloudCodeEditingSession } from './cloudCodeEditingSession.js';

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
	private readonly editingSessions = new Map<string, { session: ICloudCodeEditingSession; title: string; checkpoint: boolean; error?: string }>();
	private activeRequest: { id: string; message: ICloudCodeMessage; text: string; hasAttachments: boolean; targets?: readonly ICloudCodeEditTarget[] } | undefined;
	private activeAgent: { source: CancellationTokenSource; completion: Promise<void>; conversation: number; activity: string[] } | undefined;
	private agentConversation = 0;
	private disposed = false;
	private cancellationOnDispose: Promise<void> = Promise.resolve();
	private conversations: ICloudCodeConversation[] = [];
	private conversationId = generateUuid();
	private conversationScope: string | undefined;
	private readonly saveScheduler = this._register(new RunOnceScheduler(() => this.saveConversations(), 500));

	constructor(
		private readonly view: ICloudCodeChatView,
		private readonly contextProvider: ICloudCodeContextProvider | undefined,
		private readonly editProvider: ICloudCodeEditProvider | undefined,
		private readonly agent: ICloudCodeAgent | undefined,
		private readonly conversationStorage: ICloudCodeConversationStorage | undefined,
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
		this._register(view.onDidChangeDraftAttachments(attachments => {
			if (this.running || this.editBusy || this.loadingAttachments || this.hasPendingEdits() || this.state.status !== 'signedIn') {
				this.view.setAttachments(this.attachments, this.loadingAttachments);
				return;
			}
			try {
				if (attachments.length) { this.contextProvider?.assertWorkspaceTrusted(); }
				const nextAttachments = mergeCloudCodeAttachments([], attachments);
				this.useReferenceMode(nextAttachments);
				this.attachments = nextAttachments;
			} catch (error) { this.showError(error); }
			this.view.setAttachments(this.attachments, false);
			this.saveScheduler.schedule();
		}));
		this._register(view.onDidRemoveAttachment(id => {
			if (this.editBusy || this.running) {
				return;
			}
			this.attachments = this.attachments.filter(attachment => attachment.id !== id);
			this.view.setAttachments(this.attachments, this.loadingAttachments);
		}));
		this._register(view.onDidChangeMode(mode => {
			if (!this.running && !this.editBusy && !this.loadingAttachments && !this.hasPendingEdits()) {
				if (mode !== 'agent' && this.attachments.some(attachment => attachment.reference)) {
					this.view.setError(localize('cloudcode.referenceMode', "Use Agent mode to read attached file references, or remove them before switching modes."));
				} else {
					this.mode = mode;
				}
			}
			this.view.setEditMode(this.mode);
			this.saveScheduler.schedule();
		}));
		this._register(view.onDidReviewEdit(event => void this.reviewEdit(event.id, event.action)));
		if (view.onDidReviewEditingSession) {
			this._register(view.onDidReviewEditingSession(event => void this.reviewEditingSession(event.id, event.action)));
		}
		this.view.setEditMode(this.mode);
		this.view.setEditProposals([], false);
		this.renderEditingSessions();
		this._register(view.onDidSubmit(prompt => void this.submit(prompt)));
		this._register(view.onDidStop(() => this.stop()));
		this._register(view.onDidSignIn(() => void this.signIn()));
		this._register(view.onDidCancelSignIn(() => void this.cancelSignIn()));
		this._register(view.onDidSignOut(() => void this.signOut()));
		this._register(view.onDidNewConversation(() => this.newConversation()));
		this._register(view.onDidSelectConversation(id => this.selectConversation(id)));
		this._register(view.onDidChangeDraft(() => this.saveScheduler.schedule()));
		this.renderConversations();
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
		if (accountChanged || wasSignedIn && state.status !== 'signedIn') {
			this.resetConversation();
			this.saveConversations();
			this.conversations = [];
			this.conversationScope = undefined;
			this.conversationId = generateUuid();
			this.selectedModel = undefined;
			this.clearConversation();
		}
		this.state = state;
		if (accountChanged || state.status !== 'signedIn') {
			this.models = [];
			if (state.status !== 'signedIn') { this.selectedModel = undefined; }
			this.loadingModels = false;
			this.modelRequest++;
		}
		if (state.status === 'signedIn' && state.account && !this.conversationScope && this.conversationStorage) {
			try {
				this.conversationScope = this.conversationStorage.scope(state.account);
				const archive = parseCloudCodeConversations(this.conversationStorage.read(this.conversationScope));
				if (archive) {
					this.conversations = [...archive.conversations];
					const active = this.conversations.find(chat => chat.id === archive.activeId) ?? this.conversations.at(-1);
					if (active) { this.restoreConversation(active); }
				}
			} catch (error) { this.showError(error); }
		}
		this.renderConversations();
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

	private useReferenceMode(attachments: readonly ICloudCodeAttachment[]): void {
		if (attachments.some(attachment => attachment.reference)) {
			if (!this.agent) {
				throw new Error(localize('cloudcode.referenceAgentRequired', "File references require Agent mode. Open a project in the desktop app or attach a smaller code selection."));
			}
			this.mode = 'agent';
			this.view.setEditMode(this.mode);
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
			const nextAttachments = mergeCloudCodeAttachments(this.attachments, attachments);
			this.useReferenceMode(nextAttachments);
			this.attachments = nextAttachments;
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
		try {
			this.useReferenceMode(this.attachments);
		} catch (error) {
			this.view.setDraft(prompt);
			this.showError(error);
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
		this.renderConversations();
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
		const history = this.agentHistory();
		this.clearEditProposals();
		const disposables = new DisposableStore();
		const request = { source: disposables.add(new CancellationTokenSource()), completion: Promise.resolve(), conversation: this.agentConversation, activity: [] as string[] };
		this.activeAgent = request;
		const attachments = this.attachments;
		const responseIndex = this.messages.length + 1;
		this.messages.push({ role: 'user', text: prompt, attachments }, { role: 'assistant', text: '', progress: localize('cloudcode.agentStarting', "Exploring your project…") });
		this.attachments = [];
		this.view.setAttachments([], false);
		this.view.setDraft('');
		this.view.setError(undefined);
		this.view.setMessages(this.messages);
		this.renderConversations();
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
				}, history);
				if (!isCurrent()) {
					result.editingSession?.dispose();
					for (const checkpoint of result.checkpoints ?? []) { checkpoint.dispose(); }
					return;
				}
				const stopped = request.source.token.isCancellationRequested;
				if (stopped && !result.error && !result.commandCount && !result.checkpoints?.length) {
					result.editingSession?.dispose();
					throw new CancellationError();
				}
				const incomplete = stopped || result.incomplete;
				for (const [index, checkpoint] of (result.checkpoints ?? []).entries()) {
					this.retainEditingSession(checkpoint, localize('cloudcode.checkpointTitle', "{0} — Checkpoint {1}", prompt.replace(/\s+/g, ' ').trim().slice(0, 60), index + 1), true);
				}
				if (result.editingSession) {
					if (!incomplete && result.editingSession.changes.length) {
						this.retainEditingSession(result.editingSession, prompt);
					} else {
						result.editingSession.dispose();
					}
				}
				this.editProposals = incomplete ? [] : result.edits.map(edit => ({ ...edit, id: generateUuid(), status: 'pending', reviewed: false }));
				this.messages[responseIndex] = {
					role: 'assistant', text: stopped && !result.error ? localize('cloudcode.agentStoppedAfterCommands', "Agent stopped. Applied checkpoints and any command side effects remain in your project. Unapplied changes were discarded.") : result.text,
					attachments: result.attachments, activity: [...request.activity],
					...(incomplete ? { incomplete: true } : result.edits.length || result.editingSession?.changes.length ? { proposedEdits: true } : {})
				};
				for (const checkpoint of result.checkpoints ?? []) { this.recordEditingSessionOutcome(checkpoint); }
				if (result.error) { this.showError(new Error(result.error)); }
				this.history = this.agentHistory();
				this.historyHasAttachments = false;
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

	/** Only completed discussion is reusable; attachment snapshots and tool authority are task-local. */
	private agentHistory(): ICloudCodeMessage[] {
		const history: ICloudCodeMessage[] = [];
		let user: string | undefined;
		for (const message of this.messages) {
			if (message.incomplete || message.progress !== undefined) {
				user = undefined;
				continue;
			}
			let content = message.text;
			const labels = message.attachments?.map(attachment => attachment.label);
			if (labels?.length) {
				content += `\n\nPreviously referenced files (read again for current contents): ${JSON.stringify(labels)}`;
			}
			if (message.role === 'user') {
				user = content;
				continue;
			}
			if (message.proposedEdits) {
				content = `Proposal only; no edits were applied by this response. Later review outcomes are recorded separately.\n${content}`;
			}
			if (user !== undefined) {
				history.push({ role: 'user', content: user }, { role: 'assistant', content });
				user = undefined;
			} else if (history.length) {
				// Review and archive notices belong to the preceding completed turn.
				const previous = history[history.length - 1];
				history[history.length - 1] = { role: 'assistant', content: `${previous.content}\n\n${content}` };
			}
		}
		return history.slice(-CLOUDCODE_MAX_MESSAGES);
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
		this.messages[this.messages.length - 1] = { role: 'assistant', text: responseText, incomplete, ...(request.targets && this.editProposals.length ? { proposedEdits: true } : {}) };
		if (!incomplete && !request.targets) {
			this.historyHasAttachments ||= request.hasAttachments;
			this.history.push(request.message, { role: 'assistant', content: request.text });
		}
		this.activeRequest = undefined;
		this.view.setMessages(this.messages);
		this.updateStatus();
	}

	private hasPendingEdits(): boolean {
		return this.editProposals.some(proposal => proposal.status === 'pending') || [...this.editingSessions.values()].some(({ session }) => session.status === 'pending');
	}

	private retainEditingSession(session: ICloudCodeEditingSession, prompt: string, checkpoint = false): void {
		this.editingSessions.set(session.id, { session, title: prompt.replace(/\s+/g, ' ').trim().slice(0, 80), checkpoint });
		while (this.editingSessions.size > 5) {
			const oldest = [...this.editingSessions.values()].find(entry => entry.session.status === 'rejected' || entry.session.status === 'undone') ?? this.editingSessions.values().next().value!;
			this.editingSessions.delete(oldest.session.id);
			oldest.session.dispose();
			if (oldest.session.status === 'applied' || oldest.session.status === 'partial') {
				this.messages.push({ role: 'assistant', text: localize('cloudcode.olderTaskReviewClosed', "The oldest task review was closed. Its applied changes remain in your files.") });
			}
		}
		this.renderEditingSessions();
	}

	private renderEditingSessions(): void {
		this.view.setEditingSessions?.([...this.editingSessions.values()].map(({ session, title, checkpoint, error }) => ({
			id: session.id,
			title,
			checkpoint,
			status: session.status,
			reviewed: session.reviewed,
			changes: session.changes.map(change => ({ kind: change.kind, path: change.kind === 'create' ? change.after.path : change.before.path, ...(change.kind === 'rename' ? { newPath: change.after.path } : {}) })),
			error
		})), this.editBusy);
	}

	private clearEditingSessions(): void {
		for (const { session } of this.editingSessions.values()) {
			session.dispose();
		}
		this.editingSessions.clear();
		if (!this.disposed) {
			this.renderEditingSessions();
		}
	}

	private async reviewEditingSession(id: string, action: CloudCodeEditingSessionAction): Promise<void> {
		if (this.disposed || this.editBusy || this.running || this.state.status !== 'signedIn') {
			return;
		}
		const entry = this.editingSessions.get(id);
		if (!entry) {
			return;
		}
		const { session } = entry;
		if (action === 'undo' ? session.status !== 'applied' && session.status !== 'partial' : session.status !== 'pending' || action === 'accept' && !session.reviewed) {
			return;
		}
		const revision = this.editRevision;
		const before = session.status;
		this.editBusy = true;
		entry.error = undefined;
		this.view.setError(undefined);
		this.renderEditingSessions();
		this.view.setEditProposals(this.editProposals, true);
		this.updateStatus();
		try {
			switch (action) {
				case 'preview': await session.preview(); break;
				case 'accept': await session.apply(); break;
				case 'reject': session.reject(); break;
				case 'undo': await session.undo(); break;
			}
		} catch (error) {
			if (!this.disposed && revision === this.editRevision) {
				entry.error = error instanceof Error ? error.message : localize('cloudcode.taskReviewFailed', "The task changes could not be reviewed or updated.");
				this.showError(error);
			}
		} finally {
			if (!this.disposed && revision === this.editRevision) {
				if (session.status !== before) {
					this.recordEditingSessionOutcome(session);
				}
				this.editBusy = false;
				this.renderEditingSessions();
				this.view.setEditProposals(this.editProposals, false);
				this.updateStatus();
			}
		}
	}

	private recordEditingSessionOutcome(session: ICloudCodeEditingSession): void {
		const paths = session.changes.map(change => change.kind === 'rename' ? `${change.before.path} → ${change.after.path}` : change.kind === 'create' ? change.after.path : change.before.path).join(', ');
		let text: string;
		switch (session.status) {
			case 'applied': text = localize('cloudcode.taskApplied', "Applied the task changes: {0}. Read these files again before making further changes.", paths); break;
			case 'partial': text = localize('cloudcode.taskPartiallyApplied', "The task changes were only partly applied: {0}. Read the current files again before making further changes.", paths); break;
			case 'rejected': text = localize('cloudcode.taskRejected', "Rejected the task changes: {0}. These changes were not applied.", paths); break;
			case 'undone': text = localize('cloudcode.taskUndone', "Undid the task changes: {0}. Read these files again before making further changes.", paths); break;
			default: return;
		}
		this.messages.push({ role: 'assistant', text });
		this.history = this.agentHistory();
		this.historyHasAttachments = false;
		this.view.setMessages(this.messages);
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
			if (action !== 'preview') {
				this.messages.push({ role: 'assistant', text: action === 'accept'
					? localize('cloudcode.editAcceptedFile', "Applied the proposed change to {0} in the editor. It can be undone with Undo. Read the file again before making further changes.", proposal.target.attachment.label)
					: localize('cloudcode.editRejectedFile', "Rejected the proposed change to {0}. This proposal was not applied.", proposal.target.attachment.label) });
				// Retain the discussion and review outcome without replaying stale source snapshots.
				this.history = this.agentHistory();
				this.historyHasAttachments = false;
				this.view.setMessages(this.messages);
			}
			if (!this.hasPendingEdits()) {
				this.editProvider.clear();
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
			const conversationId = this.conversationId;
			void this.service.cancelChat(request.id).catch(error => { if (this.conversationId === conversationId) { this.showError(error); } });
		}
	}

	private resetConversation(): void {
		this.stop();
		this.agentConversation++;
		if (this.hasPendingEdits()) {
			this.messages.push({ role: 'assistant', text: localize('cloudcode.archivedEdits', "The unreviewed changes were discarded. Ask again to prepare a fresh diff.") });
		}
		this.clearEditProposals();
		this.clearEditingSessions();
		this.attachmentRevision++;
		this.loadingAttachments = false;
	}

	private clearConversation(): void {
		this.attachments = [];
		this.historyHasAttachments = false;
		this.view.setAttachments([], false);
		this.messages = [];
		this.history = [];
		this.view.setMessages([]);
		this.view.setDraft('');
		this.view.setError(undefined);
		this.updateStatus();
	}

	private newConversation(): void {
		this.resetConversation();
		this.saveConversations();
		if (this.messages.length || this.attachments.length || this.view.getDraft()) {
			this.conversationId = generateUuid();
		}
		this.clearConversation();
		this.renderConversations();
		this.saveScheduler.schedule();
	}

	private selectConversation(id: string): void {
		if (id === this.conversationId || this.state.status !== 'signedIn') { return; }
		const target = this.conversations.find(chat => chat.id === id);
		if (!target) { return; }
		this.resetConversation();
		this.saveConversations();
		this.restoreConversation(target);
		this.renderConversations();
		this.saveScheduler.schedule();
	}

	private restoreConversation(chat: ICloudCodeConversation): void {
		this.conversationId = chat.id;
		this.messages = [...chat.messages];
		this.history = [...chat.history];
		this.attachments = chat.attachments;
		this.historyHasAttachments = this.history.some(message => message.images?.length) || this.messages.some(message => message.attachments?.length);
		this.mode = chat.mode === 'agent' && !this.agent ? 'ask' : chat.mode;
		if (this.agent && this.attachments.some(attachment => attachment.reference)) {
			this.mode = 'agent';
		}
		this.selectedModel = this.models.length ? this.models.find(model => model.id === chat.model)?.id ?? this.models[0].id : chat.model;
		this.view.setMessages(this.messages);
		this.view.setAttachments(this.attachments, false);
		this.view.setDraft(chat.draft, chat.draftReferences ?? []);
		this.view.setEditMode(this.mode);
		this.view.setModels(this.models, this.selectedModel, this.loadingModels);
		this.view.setError(undefined);
		this.updateStatus();
	}

	private snapshotConversation(): ICloudCodeConversation {
		const title = this.messages.find(message => message.role === 'user')?.text.replace(/\s+/g, ' ').trim().slice(0, 80)
			|| this.view.getDraft().replace(/\s+/g, ' ').trim().slice(0, 80) || localize('cloudcode.newChat', "New Chat");
		const unfinished = !!this.activeRequest || !!this.activeAgent && this.activeAgent.conversation === this.agentConversation && !this.activeAgent.source.token.isCancellationRequested;
		const messages = this.messages.map((message, index) => {
			const { progress, ...rest } = message;
			return progress !== undefined || unfinished && index === this.messages.length - 1 ? { ...rest, text: this.activeRequest?.text || localize('cloudcode.interruptedChat', "This request was interrupted."), incomplete: true } : rest;
		});
		if (this.hasPendingEdits()) {
			messages.push({ role: 'assistant', text: localize('cloudcode.archivedEdits', "The unreviewed changes were discarded. Ask again to prepare a fresh diff.") });
		}
		return { id: this.conversationId, title, messages, history: this.history, attachments: this.attachments, draft: this.view.getDraft(), draftReferences: this.view.getDraftReferences(), mode: this.mode, model: this.selectedModel };
	}

	private renderConversations(): void {
		const current = this.snapshotConversation();
		const chats = this.conversations.some(chat => chat.id === current.id) ? this.conversations.map(chat => chat.id === current.id ? current : chat) : [...this.conversations, current];
		this.view.setConversations(chats.map(chat => ({ id: chat.id, title: chat.title })), this.conversationId);
	}

	private saveConversations(): void {
		this.saveScheduler.cancel();
		if (this.state.status !== 'signedIn') { return; }
		const current = this.snapshotConversation();
		const index = this.conversations.findIndex(chat => chat.id === current.id);
		if (index === -1) { this.conversations.push(current); } else { this.conversations[index] = current; }
		try {
			const serialized = serializeCloudCodeConversations({ conversations: this.conversations, activeId: this.conversationId });
			const archive = parseCloudCodeConversations(serialized);
			if (!archive) { throw new Error(localize('cloudcode.historyInvalid', "This conversation could not be saved.")); }
			this.conversations = [...archive.conversations];
			if (this.conversationScope) { this.conversationStorage?.write(this.conversationScope, serialized); }
		} catch (error) { this.showError(error); }
		this.renderConversations();
	}

	private updateStatus(): void {
		if (!this.disposed) { this.saveScheduler.schedule(); }
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
		this.saveConversations();
		this.disposed = true;
		this.agentConversation++;
		this.activeAgent?.source.cancel();
		this.cancellationOnDispose = this.activeAgent?.completion ?? Promise.resolve();
		this.editRevision++;
		this.editProvider?.clear();
		this.clearEditingSessions();
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

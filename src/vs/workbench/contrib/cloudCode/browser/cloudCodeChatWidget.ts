/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/cloudCodeChat.css';
import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICloudCodeModel, ICloudCodeState } from '../../../../platform/cloudCode/common/cloudCode.js';
import { defaultButtonStyles, defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ICloudCodeAttachment } from '../common/cloudCodeChatContext.js';
import { CloudCodeChatStatus, ICloudCodeChatMessage, ICloudCodeChatView } from '../common/cloudCodeChat.js';
import { CloudCodeChatMode, ICloudCodeEditProposal } from '../common/cloudCodeEdits.js';

/** Presentation only; browser sign-in and inference run through the controller. */
export class CloudCodeChatWidget extends Disposable implements ICloudCodeChatView {

	readonly domNode: HTMLElement;
	private readonly conversation: HTMLElement;
	private readonly emptyState: HTMLElement;
	private readonly messages: HTMLElement;
	private readonly prompt: HTMLTextAreaElement;
	private readonly attachButton: Button;
	private readonly attachmentsNode: HTMLElement;
	private readonly attachmentHint: HTMLElement;
	private readonly attachmentDisposables = this._register(new DisposableStore());
	private loadingAttachments = false;
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
	private readonly modeButton: Button;
	private mode: CloudCodeChatMode = 'ask';
	private readonly proposalsNode: HTMLElement;
	private readonly proposalHint: HTMLElement;
	private readonly proposalList: HTMLElement;
	private readonly proposalDisposables = this._register(new DisposableStore());
	private proposals: readonly ICloudCodeEditProposal[] = [];
	private proposalButtons: { proposal: ICloudCodeEditProposal; preview: Button; accept: Button; reject: Button }[] = [];
	private editingBusy = false;
	private models: readonly ICloudCodeModel[] = [];
	private selectedModel: string | undefined;
	private readonly retryModelsButton: Button;
	private readonly errorLabel: HTMLElement;
	private responseText: Text | undefined;
	private state: ICloudCodeState = { status: 'signedOut' };
	private loadingModels = false;
	private status: CloudCodeChatStatus = 'disconnected';

	private readonly changeModeEmitter = this._register(new Emitter<CloudCodeChatMode>());
	readonly onDidChangeMode = this.changeModeEmitter.event;
	private readonly reviewEditEmitter = this._register(new Emitter<{ id: string; action: 'preview' | 'accept' | 'reject' }>());
	readonly onDidReviewEdit = this.reviewEditEmitter.event;
	private readonly requestAttachmentsEmitter = this._register(new Emitter<void>());
	readonly onDidRequestAttachments = this.requestAttachmentsEmitter.event;
	private readonly removeAttachmentEmitter = this._register(new Emitter<string>());
	readonly onDidRemoveAttachment = this.removeAttachmentEmitter.event;
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

	constructor(
		parent: HTMLElement,
		private readonly pickModel: (models: readonly ICloudCodeModel[], selected: string | undefined) => Promise<string | undefined> = async () => undefined,
		private readonly pickMode: (mode: CloudCodeChatMode) => Promise<CloudCodeChatMode | undefined> = async mode => mode === 'ask' ? 'agent' : mode === 'agent' ? 'edit' : 'ask',
	) {
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
		dom.append(this.emptyState, dom.$('p')).textContent = localize('cloudcode.welcomeDetail', "Ask a coding question, paste a snippet, or attach files and selections for context.");
		this.messages = dom.append(this.conversation, dom.$('.cloudcode-chat-messages', {
			role: 'log',
			'aria-label': localize('cloudcode.messages', "Chat messages"),
			'aria-live': 'polite',
			'aria-relevant': 'additions text'
		}));

		this.proposalsNode = dom.append(this.conversation, dom.$('.cloudcode-chat-proposals', {
			role: 'region',
			'aria-label': localize('cloudcode.proposedChanges', "Proposed Changes")
		}));
		this.proposalsNode.hidden = true;
		dom.append(this.proposalsNode, dom.$('h3')).textContent = localize('cloudcode.proposedChanges', "Proposed Changes");
		this.proposalHint = dom.append(this.proposalsNode, dom.$('p.cloudcode-chat-hint', { role: 'status', 'aria-live': 'polite' }));
		this.proposalList = dom.append(this.proposalsNode, dom.$('.cloudcode-chat-proposal-list', { role: 'list' }));

		const composer = dom.append(this.domNode, dom.$('.cloudcode-chat-composer'));
		this.errorLabel = dom.append(composer, dom.$('p.cloudcode-chat-error', { role: 'alert' }));
		this.errorLabel.hidden = true;
		const attachmentToolbar = dom.append(composer, dom.$('.cloudcode-chat-attachment-toolbar'));
		this.attachButton = this._register(new Button(attachmentToolbar, { ...defaultButtonStyles, secondary: true }));
		this.attachButton.label = localize('cloudcode.attach', "Attach…");
		this.attachmentHint = dom.append(attachmentToolbar, dom.$('.cloudcode-chat-hint'));
		this.attachmentsNode = dom.append(composer, dom.$('.cloudcode-chat-attachments', { 'aria-label': localize('cloudcode.attachments', "Attachments"), role: 'list' }));
		this._register(this.attachButton.onDidClick(() => this.requestAttachmentsEmitter.fire()));
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
		this.modeButton = this._register(new Button(this.modelPicker, { ...defaultButtonStyles, secondary: true }));
		this.modeButton.element.classList.add('cloudcode-chat-mode');
		this.modeButton.element.setAttribute('aria-haspopup', 'listbox');
		this._register(this.modeButton.onDidClick(async () => {
			const previous = this.mode;
			const selected = await this.pickMode(previous);
			if (!this._store.isDisposed && this.modeButton.enabled && this.mode === previous && selected) {
				this.changeModeEmitter.fire(selected);
			}
		}));
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
			if (!this._store.isDisposed && selected && models === this.models && this.state.status === 'signedIn' && this.status !== 'running' && !this.editingBusy && !this.hasPendingProposals && this.models.some(model => model.id === selected)) {
				this.selectedModel = selected;
				this.updateModelLabel();
				this.selectModelEmitter.fire(selected);
			}
		}));
		this.setEditMode('ask');
		this.setAttachments([], false);
		this.setSession(this.state);
		this.setModels([], undefined, false);
		this.setStatus('disconnected');
	}

	setEditMode(mode: CloudCodeChatMode): void {
		this.mode = mode;
		this.modeButton.label = mode === 'edit'
			? localize('cloudcode.proposeEdits', "Propose Edits")
			: mode === 'agent' ? localize('cloudcode.agentMode', "Agent") : localize('cloudcode.askMode', "Ask");
		this.modeButton.element.setAttribute('aria-label', localize('cloudcode.chooseMode', "Choose Chat Mode: {0}", this.modeButton.label));
		this.prompt.placeholder = mode === 'edit'
			? localize('cloudcode.editPromptPlaceholder', "Describe changes to attached files…")
			: mode === 'agent' ? localize('cloudcode.agentPromptPlaceholder', "Ask about your project or describe a change…") : localize('cloudcode.promptPlaceholder', "Ask CloudCode…");
		this.updateControls();
	}

	/** Keeps source in the native diff editor; this list shows review actions and outcomes. */
	setEditProposals(proposals: readonly ICloudCodeEditProposal[], busy: boolean): void {
		const wasAtBottom = this.conversation.scrollHeight - this.conversation.scrollTop - this.conversation.clientHeight < 20;
		this.editingBusy = busy;
		this.proposalsNode.hidden = proposals.length === 0;
		this.proposalsNode.setAttribute('aria-busy', String(busy));
		const changed = proposals !== this.proposals;
		this.proposals = proposals;
		this.proposalHint.textContent = busy
			? localize('cloudcode.reviewBusy', "Working on this change…")
			: this.hasPendingProposals
				? localize('cloudcode.reviewHint', "Preview each diff, then accept or reject it before sending another message.")
				: localize('cloudcode.reviewComplete', "Review complete. Accepted changes can be undone in the editor.");
		if (changed) {
			const active = this.proposalsNode.ownerDocument.activeElement;
			const hadFocus = !!active && this.proposalsNode.contains(active);
			const focusedId = hadFocus ? active?.getAttribute('data-proposal-id') : undefined;
			this.proposalDisposables.clear();
			this.proposalButtons = [];
			dom.clearNode(this.proposalList);
			for (const proposal of proposals) {
				const label = proposal.target.attachment.label;
				const row = dom.append(this.proposalList, dom.$('.cloudcode-chat-proposal', { role: 'listitem' }));
				dom.append(row, dom.$('h4')).textContent = label;
				if (proposal.status !== 'pending') {
					dom.append(row, dom.$('p.cloudcode-chat-hint')).textContent = proposal.status === 'accepted'
						? localize('cloudcode.editAccepted', "Accepted")
						: localize('cloudcode.editRejected', "Rejected");
					continue;
				}
				if (proposal.error) {
					dom.append(row, dom.$('p.cloudcode-chat-error', { role: 'alert' })).textContent = proposal.error;
				}
				const actions = dom.append(row, dom.$('.cloudcode-chat-proposal-actions'));
				const preview = this.createProposalButton(actions, proposal.id, 'preview', localize('cloudcode.previewDiff', "Preview Diff"), localize('cloudcode.previewNamedDiff', "Preview diff for {0}", label));
				const accept = this.createProposalButton(actions, proposal.id, 'accept', localize('cloudcode.acceptEdit', "Accept"), localize('cloudcode.acceptNamedEdit', "Accept changes to {0}", label));
				const reject = this.createProposalButton(actions, proposal.id, 'reject', localize('cloudcode.rejectEdit', "Reject"), localize('cloudcode.rejectNamedEdit', "Reject changes to {0}", label));
				this.proposalButtons.push({ proposal, preview, accept, reject });
			}
			this.updateControls();
			if (hadFocus && !busy) {
				const next = this.proposalButtons.find(buttons => buttons.proposal.id === focusedId) ?? this.proposalButtons[0];
				if (next?.preview.enabled) {
					next.preview.focus();
				} else {
					this.conversation.focus();
				}
			}
		} else {
			this.updateControls();
		}
		if (wasAtBottom) {
			this.conversation.scrollTop = this.conversation.scrollHeight;
		}
	}

	private createProposalButton(parent: HTMLElement, id: string, action: 'preview' | 'accept' | 'reject', label: string, ariaLabel: string): Button {
		const button = this.proposalDisposables.add(new Button(parent, { ...defaultButtonStyles, secondary: true }));
		button.label = label;
		button.element.setAttribute('aria-label', ariaLabel);
		button.element.setAttribute('data-proposal-id', id);
		this.proposalDisposables.add(button.onDidClick(() => {
			if (button.enabled) {
				this.reviewEditEmitter.fire({ id, action });
			}
		}));
		return button;
	}

	private get hasPendingProposals(): boolean {
		return this.proposals.some(proposal => proposal.status === 'pending');
	}

	setAttachments(attachments: readonly ICloudCodeAttachment[], loading: boolean): void {
		this.loadingAttachments = loading;
		this.attachmentDisposables.clear();
		dom.clearNode(this.attachmentsNode);
		this.attachmentsNode.hidden = attachments.length === 0;
		this.attachmentHint.textContent = loading
			? localize('cloudcode.readingAttachments', "Reading attachments…")
			: attachments.length ? localize('cloudcode.snapshotHint', "Snapshots for your next message") : '';
		for (const attachment of attachments) {
			const row = dom.append(this.attachmentsNode, dom.$('.cloudcode-chat-attachment', { role: 'listitem' }));
			this.renderAttachment(row, attachment);
			const remove = this.attachmentDisposables.add(new Button(row, { ...defaultButtonStyles, secondary: true }));
			remove.label = localize('cloudcode.removeAttachment', "Remove");
			remove.element.setAttribute('aria-label', localize('cloudcode.removeNamedAttachment', "Remove {0}", attachment.label));
			this.attachmentDisposables.add(remove.onDidClick(() => this.removeAttachmentEmitter.fire(attachment.id)));
		}
		this.updateControls();
	}

	private renderAttachment(parent: HTMLElement, attachment: ICloudCodeAttachment): void {
		const details = dom.append(parent, dom.$('details.cloudcode-chat-attachment-preview'));
		dom.append(details, dom.$('summary')).textContent = localize('cloudcode.attachmentSummary', "{0} ({1} KiB)", attachment.label, (new TextEncoder().encode(attachment.content).byteLength / 1024).toFixed(1));
		dom.append(details, dom.$('pre')).textContent = attachment.content;
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
			for (const attachment of message.attachments ?? []) {
				this.renderAttachment(row, attachment);
			}
			if (message.activity?.length) {
				const activity = dom.append(row, dom.$('details.cloudcode-chat-attachment-preview'));
				dom.append(activity, dom.$('summary')).textContent = localize('cloudcode.agentActivity', "Agent Activity");
				dom.append(activity, dom.$('pre')).textContent = message.activity.join('\n');
			}
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
		const canInteract = this.state.status === 'signedIn' && this.status !== 'running' && !this.editingBusy;
		this.sendButton.enabled = canInteract && !this.loadingAttachments && !this.hasPendingProposals && this.status === 'ready' && this.prompt.value.trim().length > 0;
		this.attachButton.enabled = canInteract && !this.loadingAttachments && !this.hasPendingProposals;
		this.modeButton.enabled = canInteract && !this.loadingAttachments && !this.hasPendingProposals;
		this.stopButton.enabled = this.status === 'running';
		this.modelButton.enabled = canInteract && !this.hasPendingProposals && !this.loadingModels && this.models.length > 0;
		this.stopButton.element.hidden = this.status !== 'running';
		for (const { proposal, preview, accept, reject } of this.proposalButtons) {
			preview.enabled = canInteract;
			accept.enabled = canInteract && proposal.reviewed;
			reject.enabled = canInteract;
		}
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
		if (this.state.status !== 'signedIn' || this.status !== 'ready' || this.loadingAttachments || this.editingBusy || this.hasPendingProposals || !prompt) {
			return;
		}
		this.prompt.value = '';
		this.updateControls();
		this.submitEmitter.fire(prompt);
		this.focus();
	}
}

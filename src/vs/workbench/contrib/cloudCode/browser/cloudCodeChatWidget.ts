/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/cloudCodeChat.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DataTransfers } from '../../../../base/browser/dnd.js';
import { CodeDataTransfers, containsDragType } from '../../../../platform/dnd/browser/dnd.js';
import { cloudCodeImageBytes } from '../../../../platform/cloudCode/common/cloudCodeImages.js';
import { CloudCodeAttachmentInput } from './cloudCodeAttachmentInput.js';
import { CloudCodeComposer } from './cloudCodeComposer.js';
import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICloudCodeModel, ICloudCodeState } from '../../../../platform/cloudCode/common/cloudCode.js';
import { defaultButtonStyles, defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ICloudCodeAttachment } from '../common/cloudCodeChatContext.js';
import { CloudCodeChatStatus, ICloudCodeChatMessage, ICloudCodeChatView, ICloudCodeDraftReference } from '../common/cloudCodeChat.js';
import { CloudCodeChatMode, ICloudCodeEditProposal } from '../common/cloudCodeEdits.js';
import { CloudCodeEditingSessionAction, ICloudCodeEditingSessionView } from '../common/cloudCodeEditingSession.js';

/** Presentation only; browser sign-in and inference run through the controller. */
export class CloudCodeChatWidget extends Disposable implements ICloudCodeChatView {

	readonly domNode: HTMLElement;
	readonly titleControl: HTMLElement;
	private readonly tabList: HTMLElement;
	private readonly tabDisposables = this._register(new DisposableStore());
	private readonly selectConversationEmitter = this._register(new Emitter<string>());
	readonly onDidSelectConversation = this.selectConversationEmitter.event;
	private readonly changeDraftEmitter = this._register(new Emitter<void>());
	readonly onDidChangeDraft = this.changeDraftEmitter.event;
	private readonly changeDraftAttachmentsEmitter = this._register(new Emitter<readonly ICloudCodeAttachment[]>());
	readonly onDidChangeDraftAttachments = this.changeDraftAttachmentsEmitter.event;
	private readonly conversation: HTMLElement;
	private readonly emptyState: HTMLElement;
	private readonly messages: HTMLElement;
	private readonly prompt: CloudCodeComposer;
	private submittedDraft: { text: string; references: readonly ICloudCodeDraftReference[] } | undefined;
	private readonly attachButton: Button;
	private readonly attachmentPreview: HTMLElement;
	private readonly attachmentHint: HTMLElement;
	private loadingAttachments = false;
	private draftRevision = 0;
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
	private mode: CloudCodeChatMode = 'agent';
	private readonly proposalsNode: HTMLElement;
	private readonly proposalHint: HTMLElement;
	private readonly proposalList: HTMLElement;
	private readonly proposalDisposables = this._register(new DisposableStore());
	private proposals: readonly ICloudCodeEditProposal[] = [];
	private proposalButtons: { proposal: ICloudCodeEditProposal; preview: Button; accept: Button; reject: Button }[] = [];
	private proposalBusy = false;
	private readonly editingSessionsNode: HTMLElement;
	private readonly editingSessionDisposables = this._register(new DisposableStore());
	private editingSessions: readonly ICloudCodeEditingSessionView[] = [];
	private editingSessionButtons: { session: ICloudCodeEditingSessionView; action: CloudCodeEditingSessionAction; button: Button }[] = [];
	private editingSessionBusy = false;
	private editingSessionFocus: { id: string | null; action: string | null } | undefined;
	private models: readonly ICloudCodeModel[] = [];
	private selectedModel: string | undefined;
	private readonly retryModelsButton: Button;
	private readonly errorLabel: HTMLElement;
	private responseText: Text | undefined;
	private responseBody: HTMLElement | undefined;
	private thinkingNode: HTMLElement | undefined;
	private state: ICloudCodeState = { status: 'signedOut' };
	private loadingModels = false;
	private status: CloudCodeChatStatus = 'disconnected';

	private readonly changeModeEmitter = this._register(new Emitter<CloudCodeChatMode>());
	readonly onDidChangeMode = this.changeModeEmitter.event;
	private readonly reviewEditEmitter = this._register(new Emitter<{ id: string; action: 'preview' | 'accept' | 'reject' }>());
	readonly onDidReviewEdit = this.reviewEditEmitter.event;
	private readonly reviewEditingSessionEmitter = this._register(new Emitter<{ id: string; action: CloudCodeEditingSessionAction }>());
	readonly onDidReviewEditingSession = this.reviewEditingSessionEmitter.event;
	private readonly requestAttachmentsEmitter = this._register(new Emitter<void | (() => Promise<readonly ICloudCodeAttachment[]>)>());
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
		private readonly attachmentInput?: CloudCodeAttachmentInput,
	) {
		super();

		this.domNode = dom.append(parent, dom.$('.cloudcode-chat'));
		this.titleControl = dom.append(this.domNode, dom.$('.cloudcode-chat-title-control'));
		this.tabList = dom.append(this.titleControl, dom.$('.cloudcode-chat-tabs', { role: 'tablist', 'aria-label': localize('cloudcode.conversations', "Conversations") }));
		const newChat = this._register(new Button(this.titleControl, { ...defaultButtonStyles, secondary: true }));
		newChat.element.classList.add('cloudcode-chat-new');
		newChat.element.appendChild(renderIcon(Codicon.plus));
		newChat.element.setAttribute('aria-label', localize('cloudcode.newChat', "New Chat"));
		this._register(newChat.onDidClick(() => this.newConversation()));
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
		this.editingSessionsNode = dom.append(this.conversation, dom.$('.cloudcode-chat-editing-sessions', {
			role: 'region', 'aria-label': localize('cloudcode.taskChanges', "Task Changes")
		}));
		this.editingSessionsNode.hidden = true;

		const composer = dom.append(this.domNode, dom.$('.cloudcode-chat-composer'));
		this.errorLabel = dom.append(composer, dom.$('p.cloudcode-chat-error', { role: 'alert' }));
		this.errorLabel.hidden = true;
		const input = dom.append(composer, dom.$('.cloudcode-chat-input'));
		const attachmentToolbar = dom.append(composer, dom.$('.cloudcode-chat-attachment-toolbar'));
		this.attachButton = this._register(new Button(attachmentToolbar, { ...defaultButtonStyles, secondary: true }));
		this.attachButton.element.appendChild(renderIcon(Codicon.attach));
		this.attachButton.element.setAttribute('aria-label', localize('cloudcode.attach', "Attach Files…"));
		this.attachmentHint = dom.append(attachmentToolbar, dom.$('.cloudcode-chat-hint'));
		this.attachmentPreview = dom.append(input, dom.$('.cloudcode-chat-chip-preview'));
		this.attachmentPreview.hidden = true;
		this._register(this.attachButton.onDidClick(() => { this.prompt.markInsertionPoint(); this.requestAttachmentsEmitter.fire(); }));
		const progress = dom.append(composer, dom.$('.cloudcode-chat-progress'));
		this.progressBar = this._register(new ProgressBar(progress, {
			...defaultProgressBarStyles,
			ariaLabel: localize('cloudcode.progress', "CloudCode response in progress")
		}));

		this.prompt = this._register(new CloudCodeComposer(input));
		this._register(this.prompt.onDidChange(() => { this.draftRevision++; this.changeDraftEmitter.fire(); this.updateControls(); }));
		this._register(this.prompt.onDidChangeAttachments(attachments => this.changeDraftAttachmentsEmitter.fire(attachments)));
		this._register(this.prompt.onDidPreview(attachment => {
			dom.clearNode(this.attachmentPreview);
			this.renderAttachment(this.attachmentPreview, attachment, true);
			this.attachmentPreview.hidden = false;
		}));

		const footer = dom.append(input, dom.$('.cloudcode-chat-footer'));
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
		footer.appendChild(attachmentToolbar);
		const actions = dom.append(footer, dom.$('.cloudcode-chat-actions'));
		this.stopButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		this.stopButton.label = localize('cloudcode.stop', "Stop");
		this.sendButton = this._register(new Button(actions, defaultButtonStyles));
		this.sendButton.label = localize('cloudcode.send', "Send");

		this.connectionHint = dom.append(composer, dom.$('p.cloudcode-chat-hint'));

		this._register(dom.addDisposableListener(this.prompt.domNode, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (!event.defaultPrevented && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && this.status === 'ready') {
				event.preventDefault();
				this.submit();
			}
		}));
		this._register(dom.addDisposableListener(this.prompt.domNode, 'paste', (event: ClipboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (!this.attachmentInput || !this.attachButton.enabled) {
				this.prompt.insertText(event.clipboardData?.getData('text/plain') ?? '');
				return;
			}
			const files = Array.from(event.clipboardData?.files ?? []);
			const text = event.clipboardData?.getData('text/plain') ?? '';
			this.prompt.markInsertionPoint();
			const revision = this.draftRevision;
			this.requestAttachmentsEmitter.fire(async () => {
				const attachments = await this.attachmentInput!.readPaste(files, text.length > 0);
				if (!attachments.length && text && !this._store.isDisposed && revision === this.draftRevision && this.state.status === 'signedIn') {
					this.prompt.insertText(text);
				}
				return attachments;
			});
		}));
		let dragDepth = 0;
		const isFileDrag = (event: DragEvent) => containsDragType(event, DataTransfers.RESOURCES, DataTransfers.FILES, CodeDataTransfers.EDITORS, CodeDataTransfers.FILES);
		this._register(dom.addDisposableListener(this.domNode, 'dragenter', (event: DragEvent) => {
			if (this.attachmentInput && isFileDrag(event)) {
				event.preventDefault();
				event.stopPropagation();
				dragDepth++;
				input.classList.toggle('cloudcode-chat-drop-target', this.attachButton.enabled);
			}
		}));
		this._register(dom.addDisposableListener(this.domNode, 'dragover', (event: DragEvent) => {
			if (this.attachmentInput && isFileDrag(event)) {
				event.preventDefault();
				event.stopPropagation();
				if (event.dataTransfer) {
					event.dataTransfer.dropEffect = this.attachButton.enabled ? 'copy' : 'none';
				}
			}
		}));
		this._register(dom.addDisposableListener(this.domNode, 'dragleave', () => {
			if (--dragDepth <= 0) {
				dragDepth = 0;
				input.classList.remove('cloudcode-chat-drop-target');
			}
		}));
		this._register(dom.addDisposableListener(this.domNode, 'drop', (event: DragEvent) => {
			dragDepth = 0;
			input.classList.remove('cloudcode-chat-drop-target');
			if (this.attachmentInput && isFileDrag(event)) {
				event.preventDefault();
				event.stopPropagation();
				if (this.attachButton.enabled) {
					this.prompt.setDropPosition(event.clientX, event.clientY);
					this.requestAttachmentsEmitter.fire(this.attachmentInput.captureDrop(event));
					this.focus();
				}
			} else {
				event.preventDefault();
				event.stopPropagation();
				this.prompt.setDropPosition(event.clientX, event.clientY);
				this.prompt.insertText(event.dataTransfer?.getData('text/plain') ?? '');
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
		this.setEditMode(this.mode);
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
		this.proposalBusy = busy;
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
		return this.proposals.some(proposal => proposal.status === 'pending') || this.editingSessions.some(session => session.status === 'pending');
	}

	private get editingBusy(): boolean {
		return this.proposalBusy || this.editingSessionBusy;
	}

	/** One file list and one review decision for each complete Agent task. */
	setEditingSessions(sessions: readonly ICloudCodeEditingSessionView[], busy: boolean): void {
		const wasAtBottom = this.conversation.scrollHeight - this.conversation.scrollTop - this.conversation.clientHeight < 20;
		const active = this.editingSessionsNode.ownerDocument.activeElement;
		const hadFocus = !!active && this.editingSessionsNode.contains(active);
		if (hadFocus) {
			this.editingSessionFocus = { id: active.getAttribute('data-session-id'), action: active.getAttribute('data-session-action') };
		}
		this.editingSessions = sessions;
		this.editingSessionBusy = busy;
		this.editingSessionsNode.hidden = sessions.length === 0;
		this.editingSessionsNode.setAttribute('aria-busy', String(busy));
		this.editingSessionDisposables.clear();
		this.editingSessionButtons = [];
		dom.clearNode(this.editingSessionsNode);
		for (const session of sessions) {
			const row = dom.append(this.editingSessionsNode, dom.$('section.cloudcode-chat-editing-session'));
			dom.append(row, dom.$('h3')).textContent = session.title
				? localize('cloudcode.namedTaskChangeCount', "{0} ({1})", session.title, session.changes.length)
				: localize('cloudcode.taskChangeCount', "Task Changes ({0})", session.changes.length);
			const files = dom.append(row, dom.$('ul.cloudcode-chat-task-files'));
			for (const change of session.changes) {
				const file = dom.append(files, dom.$('li'));
				const kind = change.kind === 'create' ? localize('cloudcode.taskCreate', "Create")
					: change.kind === 'delete' ? localize('cloudcode.taskDelete', "Delete")
						: change.kind === 'rename' ? localize('cloudcode.taskRename', "Rename") : localize('cloudcode.taskEdit', "Edit");
				dom.append(file, dom.$('span.cloudcode-chat-task-kind')).textContent = kind;
				dom.append(file, dom.$('span.cloudcode-chat-task-path')).textContent = change.newPath ? `${change.path} → ${change.newPath}` : change.path;
			}
			const hint = dom.append(row, dom.$('p.cloudcode-chat-hint', { role: 'status' }));
			hint.textContent = session.checkpoint && (session.status === 'applied' || session.status === 'partial')
				? session.status === 'partial'
					? localize('cloudcode.checkpointPartialHint', "This checkpoint was only partly applied. Undo Checkpoint covers these file edits only; command side effects remain. Later changes may prevent undo.")
					: localize('cloudcode.checkpointAppliedHint', "Applied before running a command. Undo Checkpoint covers these file edits only; command side effects remain. Later changes may prevent undo.")
				: session.status === 'pending'
				? localize('cloudcode.taskReviewHint', "Preview the combined diff, then accept or reject all changes before continuing.")
				: session.status === 'partial' ? localize('cloudcode.taskPartialHint', "Some changes were applied. You can undo this task or continue from the current files.")
					: session.status === 'applied' ? localize('cloudcode.taskAppliedHint', "Applied. Undo Task restores this task while preserving your later edits when possible.")
						: session.status === 'undone' ? localize('cloudcode.taskUndoneHint', "Task changes undone.") : localize('cloudcode.taskRejectedHint', "Task changes rejected.");
			if (session.error) {
				dom.append(row, dom.$('p.cloudcode-chat-error', { role: 'alert' })).textContent = session.error;
			}
			const actions = dom.append(row, dom.$('.cloudcode-chat-proposal-actions'));
			if (session.status === 'pending') {
				this.createEditingSessionButton(actions, session, 'preview', localize('cloudcode.previewTask', "Preview Changes"), session.reviewed);
				this.createEditingSessionButton(actions, session, 'accept', localize('cloudcode.acceptTask', "Accept All"), !session.reviewed);
				this.createEditingSessionButton(actions, session, 'reject', localize('cloudcode.rejectTask', "Reject All"), true);
			} else if (session.status === 'applied' || session.status === 'partial') {
				this.createEditingSessionButton(actions, session, 'undo', session.checkpoint ? localize('cloudcode.undoCheckpoint', "Undo Checkpoint") : localize('cloudcode.undoTask', "Undo Task"), true);
			}
		}
		this.updateControls();
		if (this.editingSessionFocus && !busy) {
			const { id, action } = this.editingSessionFocus;
			this.editingSessionFocus = undefined;
			// Do not take focus back from the diff editor opened by Preview Changes.
			if (this.editingSessionsNode.ownerDocument.activeElement === this.editingSessionsNode.ownerDocument.body) {
				const next = this.editingSessionButtons.find(item => item.session.id === id && item.action === action && item.button.enabled)
					?? this.editingSessionButtons.find(item => item.session.id === id && item.button.enabled);
				if (next) { next.button.focus(); } else { this.conversation.focus(); }
			}
		}
		if (wasAtBottom) {
			this.conversation.scrollTop = this.conversation.scrollHeight;
		}
	}

	private createEditingSessionButton(parent: HTMLElement, session: ICloudCodeEditingSessionView, action: CloudCodeEditingSessionAction, label: string, secondary: boolean): void {
		const button = this.editingSessionDisposables.add(new Button(parent, { ...defaultButtonStyles, secondary }));
		button.label = label;
		button.element.setAttribute('data-session-id', session.id);
		button.element.setAttribute('data-session-action', action);
		this.editingSessionButtons.push({ session, action, button });
		this.editingSessionDisposables.add(button.onDidClick(() => {
			if (button.enabled) {
				this.reviewEditingSessionEmitter.fire({ id: session.id, action });
			}
		}));
	}

	setAttachments(attachments: readonly ICloudCodeAttachment[], loading: boolean): void {
		this.loadingAttachments = loading;
		this.attachmentHint.textContent = loading ? localize('cloudcode.readingAttachments', "Reading attachments…") : '';
		this.attachmentPreview.hidden = true;
		dom.clearNode(this.attachmentPreview);
		this.prompt.setAttachments(attachments, loading);
		this.updateControls();
	}

	private renderAttachment(parent: HTMLElement, attachment: ICloudCodeAttachment, expanded = false): void {
		const details = dom.append(parent, dom.$<HTMLDetailsElement>('details.cloudcode-chat-attachment-preview'));
		details.open = expanded;
		dom.append(details, dom.$('summary')).textContent = attachment.reference ? attachment.label : localize('cloudcode.attachmentSummary', "{0} ({1} KiB)", attachment.label, ((attachment.image ? cloudCodeImageBytes(attachment.image.dataUrl) ?? 0 : new TextEncoder().encode(attachment.content).byteLength) / 1024).toFixed(1));
		if (attachment.reference) {
			dom.append(details, dom.$('p')).textContent = localize('cloudcode.referencePreview', "Attached by reference. Agent reads relevant sections as needed.");
		} else if (attachment.image && cloudCodeImageBytes(attachment.image.dataUrl) !== undefined) {
			const image = dom.append(details, dom.$<HTMLImageElement>('img.cloudcode-chat-image'));
			image.src = attachment.image.dataUrl;
			image.alt = attachment.label;
			details.open = true;
		} else {
			dom.append(details, dom.$('pre')).textContent = attachment.content;
		}

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
		this.responseBody = undefined;
		this.thinkingNode = undefined;
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
			if (message.activity && message.activity.length > 1) {
				const activity = dom.append(row, dom.$<HTMLDetailsElement>('details.cloudcode-chat-attachment-preview'));
				dom.append(activity, dom.$('summary')).textContent = localize('cloudcode.agentActivity', "Agent Activity");
				dom.append(activity, dom.$('pre')).textContent = message.activity.join('\n');
			}
			if (message === messages.at(-1) && message.role === 'assistant' && !message.incomplete && (!message.text.trim() || message.progress)) {
				this.thinkingNode = dom.append(row, dom.$('p.cloudcode-chat-thinking', { role: 'status', 'aria-label': message.progress || localize('cloudcode.thinking', "Thinking") }));
				const label = dom.append(this.thinkingNode, dom.$('span.cloudcode-chat-thinking-label', { 'aria-hidden': 'true' }));
				label.textContent = (message.progress || localize('cloudcode.thinking', "Thinking")).replaceAll('…', '');
				const dots = dom.append(this.thinkingNode, dom.$('span.cloudcode-chat-thinking-dots', { 'aria-hidden': 'true' }));
				for (let index = 0; index < 3; index++) {
					dom.append(dots, dom.$('span')).textContent = '.';
				}
			}
			const body = dom.append(row, dom.$('p'));
			const text = body.ownerDocument.createTextNode(message.text);
			body.appendChild(text);
			if (message.role === 'assistant') {
				this.responseText = text;
				this.responseBody = body;
			}
			if (message.incomplete) {
				dom.append(row, dom.$('p.cloudcode-chat-incomplete')).textContent = localize('cloudcode.incomplete', "Response incomplete. This question and response will not be included in the next message.");
			}
		}
		this.updateThinking();
		if (wasAtBottom) {
			this.conversation.scrollTop = this.conversation.scrollHeight;
		}
	}

	/** Adds a delta to the active text node, preserving existing transcript DOM and selection. */
	appendResponse(text: string): void {
		const wasAtBottom = this.conversation.scrollHeight - this.conversation.scrollTop - this.conversation.clientHeight < 20;
		this.responseText?.appendData(text);
		this.updateThinking();
		if (wasAtBottom) {
			this.conversation.scrollTop = this.conversation.scrollHeight;
		}
	}

	private updateThinking(): void {
		const thinking = this.status === 'running' && !!this.thinkingNode && !this.responseText?.data.trim();
		if (this.thinkingNode) {
			this.thinkingNode.hidden = !thinking;
		}
		if (this.responseBody) {
			this.responseBody.hidden = thinking;
		}
	}

	setError(message: string | undefined): void {
		this.errorLabel.textContent = message ?? '';
		this.errorLabel.hidden = !message;
	}

	getDraft(): string { return this.prompt.value; }
	getDraftReferences(): readonly ICloudCodeDraftReference[] { return this.prompt.references; }

	setConversations(chats: readonly { id: string; title: string }[], activeId: string): void {
		const focused = this.tabList.contains(this.tabList.ownerDocument.activeElement);
		this.tabDisposables.clear();
		dom.clearNode(this.tabList);
		for (const [index, chat] of chats.entries()) {
			const tab = dom.append(this.tabList, dom.$<HTMLButtonElement>('button.cloudcode-chat-tab', { type: 'button', role: 'tab', 'aria-selected': String(chat.id === activeId), tabIndex: chat.id === activeId ? 0 : -1 }));
			tab.textContent = chat.title;
			tab.dataset.chatId = chat.id;
			this.tabDisposables.add(dom.addDisposableListener(tab, 'click', () => this.selectConversationEmitter.fire(chat.id)));
			this.tabDisposables.add(dom.addDisposableListener(tab, 'keydown', (event: KeyboardEvent) => {
				const next = event.key === 'ArrowRight' ? (index + 1) % chats.length : event.key === 'ArrowLeft' ? (index + chats.length - 1) % chats.length : event.key === 'Home' ? 0 : event.key === 'End' ? chats.length - 1 : undefined;
				if (next !== undefined) { event.preventDefault(); this.selectConversationEmitter.fire(chats[next].id); }
			}));
			if (chat.id === activeId) {
				if (focused) { tab.focus(); }
				tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			}
		}
	}

	setDraft(value: string, references?: readonly ICloudCodeDraftReference[]): void {
		this.draftRevision++;
		this.prompt.setValue(value, references ?? (this.submittedDraft?.text === value ? this.submittedDraft.references : []));
		if (references) { this.prompt.ensureAttachments(); }
		this.updateControls();
	}

	/** Updates visual state only; this never starts or cancels inference. */
	setStatus(status: CloudCodeChatStatus): void {
		this.status = status;
		this.updateThinking();
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
		for (const { session, action, button } of this.editingSessionButtons) {
			button.enabled = canInteract && (action !== 'accept' || session.reviewed);
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
		const leadingWhitespace = this.prompt.value.length - this.prompt.value.trimStart().length;
		this.submittedDraft = { text: prompt, references: this.prompt.references.map(reference => ({ ...reference, start: reference.start - leadingWhitespace, end: reference.end - leadingWhitespace })) };
		this.prompt.setValue('');
		this.updateControls();
		this.submitEmitter.fire(prompt);
		this.focus();
	}
}

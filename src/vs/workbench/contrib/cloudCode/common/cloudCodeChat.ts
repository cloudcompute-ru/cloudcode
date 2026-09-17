/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { ICloudCodeAttachment } from './cloudCodeChatContext.js';
import { CloudCodeChatMode, ICloudCodeEditProposal } from './cloudCodeEdits.js';
import { ICloudCodeModel, ICloudCodeState } from '../../../../platform/cloudCode/common/cloudCode.js';

export interface ICloudCodeChatMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
	/** Current activity while waiting for an answer; never part of the model response. */
	readonly progress?: string;
	readonly incomplete?: boolean;
	/** Marks an answer as a proposal; applying it requires a separate recorded review outcome. */
	readonly proposedEdits?: boolean;
	readonly attachments?: readonly ICloudCodeAttachment[];
	readonly activity?: readonly string[];
}

export type CloudCodeChatStatus = 'disconnected' | 'loading' | 'ready' | 'running';

/** An inline file token's offsets in the plain-text draft. */
export interface ICloudCodeDraftReference {
	readonly id: string;
	readonly start: number;
	readonly end: number;
}

/** The view receives presentation data, never authentication credentials. */
export interface ICloudCodeChatView {
	readonly onDidSelectConversation: Event<string>;
	readonly onDidChangeDraft: Event<void>;
	readonly onDidChangeDraftAttachments: Event<readonly ICloudCodeAttachment[]>;
	readonly onDidRequestAttachments: Event<void | (() => Promise<readonly ICloudCodeAttachment[]>)>;
	readonly onDidRemoveAttachment: Event<string>;
	readonly onDidSubmit: Event<string>;
	readonly onDidChangeMode: Event<CloudCodeChatMode>;
	readonly onDidReviewEdit: Event<{ id: string; action: 'preview' | 'accept' | 'reject' }>;
	readonly onDidStop: Event<void>;
	readonly onDidSignIn: Event<void>;
	readonly onDidCancelSignIn: Event<void>;
	readonly onDidSignOut: Event<void>;
	readonly onDidNewConversation: Event<void>;
	readonly onDidSelectModel: Event<string>;
	readonly onDidRetryModels: Event<void>;
	setAttachments(attachments: readonly ICloudCodeAttachment[], loading: boolean): void;
	setEditMode(mode: CloudCodeChatMode): void;
	setEditProposals(proposals: readonly ICloudCodeEditProposal[], busy: boolean): void;
	setSession(state: ICloudCodeState): void;
	setModels(models: readonly ICloudCodeModel[], selected: string | undefined, loading: boolean): void;
	setMessages(messages: readonly ICloudCodeChatMessage[]): void;
	appendResponse(text: string): void;
	setStatus(status: CloudCodeChatStatus): void;
	setError(message: string | undefined): void;
	setDraft(value: string, references?: readonly ICloudCodeDraftReference[]): void;
	getDraft(): string;
	getDraftReferences(): readonly ICloudCodeDraftReference[];
	setConversations(chats: readonly { id: string; title: string }[], activeId: string): void;
}

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
	readonly incomplete?: boolean;
	readonly attachments?: readonly ICloudCodeAttachment[];
}

export type CloudCodeChatStatus = 'disconnected' | 'loading' | 'ready' | 'running';

/** The view receives account details and text only, never authentication credentials. */
export interface ICloudCodeChatView {
	readonly onDidRequestAttachments: Event<void>;
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
	setDraft(value: string): void;
}

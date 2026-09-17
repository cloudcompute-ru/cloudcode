/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICloudCodeImage } from './cloudCodeImages.js';
import { ICloudCodeAgentDiagnostic } from './cloudCodeDiagnostics.js';
import { localize } from '../../../nls.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ICloudCodeService = createDecorator<ICloudCodeService>('cloudCodeService');
export const CLOUDCODE_CHANNEL = 'cloudCode';
export const CLOUDCODE_SERVER_SETTING = 'cloudcode.serverUrl';
export const CLOUDCODE_DEFAULT_SERVER = 'https://app.cloudcompute.ru';
export const CLOUDCODE_MAX_MESSAGES = 32;
export const CLOUDCODE_MAX_MESSAGE_LENGTH = 32768;
export const CLOUDCODE_MAX_CONTEXT_BYTES = 65536;

export interface ICloudCodeAccount {
	readonly user: { readonly id: number; readonly name: string; readonly email: string };
	readonly team: { readonly id: number; readonly name: string };
	readonly balance: { readonly amount_minor: number; readonly currency: string } | null;
}

export interface ICloudCodeState {
	readonly status: 'signedOut' | 'signingIn' | 'signedIn';
	readonly account?: ICloudCodeAccount;
	readonly persisted?: boolean;
}

export interface ICloudCodeModel {
	readonly id: string;
	readonly name: string;
	readonly supportsImages?: boolean;
}

export interface ICloudCodeMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly images?: readonly ICloudCodeImage[];
}

export interface ICloudCodeChatDelta {
	readonly requestId: string;
	readonly text: string;
}

/** Desktop-only OAuth and inference transport. Credentials stay in the shared process. */
export interface ICloudCodeService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<ICloudCodeState>;
	readonly onDidReceiveChatDelta: Event<ICloudCodeChatDelta>;
	getState(): Promise<ICloudCodeState>;
	signIn(): Promise<void>;
	cancelSignIn(): Promise<void>;
	signOut(): Promise<void>;
	getModels(): Promise<readonly ICloudCodeModel[]>;
	streamChat(requestId: string, model: string, messages: readonly ICloudCodeMessage[]): Promise<{ cancelled: boolean }>;
	cancelChat(requestId: string): Promise<void>;
	reportAgentError(diagnostic: ICloudCodeAgentDiagnostic): Promise<void>;
}

export function cloudCodeOrigin(value: string): string {
	const url = new URL(value);
	const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
	if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error(localize('cloudcode.serverUrlInvalid', "The CloudCode server must be an HTTPS origin. HTTP is supported only for local development."));
	}
	return url.origin;
}

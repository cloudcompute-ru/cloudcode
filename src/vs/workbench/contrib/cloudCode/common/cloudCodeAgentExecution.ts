/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ICloudCodeCommandResult } from '../../../../platform/cloudCode/common/cloudCodeCommand.js';
import { ICloudCodeEditingSession } from './cloudCodeEditingSession.js';

export const CLOUDCODE_COMMAND_OUTPUT_CHANNEL = 'cloudcode.agentCommands';

/** A locally authored explanation that is safe to show to the user and selected model. */
export class CloudCodeAgentExecutionError extends Error {
	constructor(message: string, readonly fatal = false) {
		super(message);
		this.name = 'CloudCodeAgentExecutionError';
	}
}

export interface ICloudCodeAgentCommand {
	readonly root: string;
	readonly path: string;
	readonly command: string;
	readonly explanation: string;
}

export type CloudCodeAgentCommandResult = ICloudCodeCommandResult | { readonly denied: true };

/** Owns per-task command consent, workspace checks, checkpoint saves and cancellation. */
export interface ICloudCodeAgentExecutionSession extends IDisposable {
	run(command: ICloudCodeAgentCommand, editingSession: ICloudCodeEditingSession, token: CancellationToken): Promise<CloudCodeAgentCommandResult>;
}

export interface ICloudCodeAgentExecutionFactory {
	readonly shell: 'cmd' | 'sh';
	createSession(): ICloudCodeAgentExecutionSession;
}

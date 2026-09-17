/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ICloudCodeCommandService = createDecorator<ICloudCodeCommandService>('cloudCodeCommandService');
export const CLOUDCODE_COMMAND_CHANNEL = 'cloudCodeCommand';
export const CLOUDCODE_MAX_COMMAND_LENGTH = 8192;
export const CLOUDCODE_MAX_COMMAND_TIMEOUT_MS = 120000;
export const CLOUDCODE_MAX_COMMAND_OUTPUT_BYTES = 16384;

export interface ICloudCodeCommandResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	readonly truncated: boolean;
	readonly failure?: 'termination_failed' | 'launch_failed' | 'background_processes';
}

/** Desktop foreground commands. Workspace trust and user approval are checked by the caller. */
export interface ICloudCodeCommandService {
	readonly _serviceBrand: undefined;
	run(requestId: string, command: string, cwd: string, timeoutMs: number): Promise<ICloudCodeCommandResult>;
	/** Resolves after the owned command has stopped; rejects if termination cannot be confirmed. */
	cancel(requestId: string): Promise<void>;
}

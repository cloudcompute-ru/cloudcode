/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const CLOUDCODE_ERROR_REPORTING_SETTING = 'cloudcode.errorReporting.enabled';

export const cloudCodeAgentErrorCodes = ['invalid_json', 'invalid_envelope', 'invalid_root', 'invalid_tool', 'invalid_path', 'invalid_range', 'invalid_result', 'response_too_large', 'response_truncated', 'call_limit', 'timeout', 'operation_failed'] as const;
export type CloudCodeAgentErrorCode = typeof cloudCodeAgentErrorCodes[number];
export const cloudCodeAgentStages = ['workspace', 'context', 'inference', 'parse', 'tool', 'edits'] as const;
export type CloudCodeAgentStage = typeof cloudCodeAgentStages[number];

/** Only structural metadata crosses the diagnostics boundary. Never include error messages or model output. */
export interface ICloudCodeAgentDiagnostic {
	readonly code: CloudCodeAgentErrorCode;
	readonly stage: CloudCodeAgentStage;
	readonly model: string;
	readonly turn: number;
	readonly rootCount: number;
	readonly responseLength: number;
	readonly requestId?: string;
}

/** IPC callers are untrusted; rebuild an allowlisted payload instead of spreading their object. */
export function sanitizeCloudCodeAgentDiagnostic(value: unknown): ICloudCodeAgentDiagnostic | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const input = value as Record<string, unknown>;
	const code = cloudCodeAgentErrorCodes.find(code => code === input.code);
	const stage = cloudCodeAgentStages.find(stage => stage === input.stage);
	if (!code || !stage || typeof input.turn !== 'number' || !Number.isSafeInteger(input.turn) || input.turn < 0 || input.turn > 12
		|| typeof input.rootCount !== 'number' || !Number.isSafeInteger(input.rootCount) || input.rootCount < 0 || input.rootCount > 10000
		|| typeof input.responseLength !== 'number' || !Number.isSafeInteger(input.responseLength) || input.responseLength < 0 || input.responseLength > 65536) {
		return undefined;
	}
	return {
		code, stage, turn: input.turn, rootCount: input.rootCount, responseLength: input.responseLength,
		model: typeof input.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(input.model) ? input.model : 'unknown',
		requestId: typeof input.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId) ? input.requestId : undefined
	};
}

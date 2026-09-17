/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { CLOUDCODE_MAX_AGENT_CONTEXT_BYTES, CLOUDCODE_MAX_AGENT_MESSAGES, CLOUDCODE_MAX_MESSAGE_LENGTH, ICloudCodeAgentMessage, ICloudCodeAgentResponse, ICloudCodeToolDefinition } from '../common/cloudCode.js';
import { ICloudCodeImage, cloudCodeImagesWithinLimit } from '../common/cloudCodeImages.js';

export const CLOUDCODE_REDIRECT_URI = 'http://127.0.0.1:43827/cloudcode/callback';

export { cloudCodeOrigin } from '../common/cloudCode.js';

export interface ICloudCodeAuthConfiguration {
	readonly client_id: string;
	readonly authorization_endpoint: string;
	readonly token_endpoint: string;
	readonly redirect_uri: string;
	readonly scope: string;
	readonly api_base_url: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Preserve signed provider metadata verbatim after bounding its JSON shape. */
function validReasoningDetails(value: unknown): value is Record<string, unknown>[] {
	let nodes = 0;
	const valid = (item: unknown, depth = 0): boolean => {
		if (++nodes > 8192 || depth > 16) { return false; }
		if (item === null || typeof item === 'boolean') { return true; }
		if (typeof item === 'number') { return Number.isFinite(item); }
		if (typeof item === 'string') { return item.length <= 65536; }
		if (Array.isArray(item)) { return item.every(child => valid(child, depth + 1)); }
		return isRecord(item) && Object.entries(item).every(([key, child]) => key.length <= 256 && valid(child, depth + 1));
	};
	return Array.isArray(value) && value.length <= 1024 && value.every(isRecord) && valid(value);
}

/** Validate the shared-process boundary before serializing model control data. */
export function createCloudCodeAgentPayload(model: string, messages: readonly ICloudCodeAgentMessage[], tools: readonly ICloudCodeToolDefinition[], maxOutputTokens = 4096) {
	const invalid = () => new Error(localize('cloudcode.agentRequestInvalid', "This Agent request is invalid or exceeds the CloudCode limit. Start a new chat or use a shorter message."));
	const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
	const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
	if (typeof model !== 'string' || !model || model.length > 200 || !Array.isArray(messages) || !messages.length || messages.length > CLOUDCODE_MAX_AGENT_MESSAGES
		|| !Array.isArray(tools) || !tools.length || tools.length > 16 || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8192) {
		throw invalid();
	}
	let schemaNodes = 0;
	const validSchema = (value: unknown, depth = 0): boolean => {
		if (++schemaNodes > 4096 || depth > 16) { return false; }
		if (value === null || typeof value === 'boolean') { return true; }
		if (typeof value === 'number') { return Number.isFinite(value); }
		if (typeof value === 'string') { return value.length <= CLOUDCODE_MAX_MESSAGE_LENGTH; }
		if (Array.isArray(value)) { return value.every(item => validSchema(item, depth + 1)); }
		return isRecord(value) && Object.entries(value).every(([key, child]) => key.length <= 256 && validSchema(child, depth + 1));
	};
	const names = new Set<string>();
	const payloadTools = tools.map(tool => {
		if (!isRecord(tool) || typeof tool.name !== 'string' || !namePattern.test(tool.name) || names.has(tool.name)
			|| typeof tool.description !== 'string' || tool.description.length > 4096 || !isRecord(tool.parameters) || tool.parameters.type !== 'object' || !validSchema(tool.parameters)) {
			throw invalid();
		}
		names.add(tool.name);
		return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
	});
	let bytes = Buffer.byteLength(JSON.stringify(payloadTools), 'utf8');
	const pending = new Set<string>();
	const seen = new Set<string>();
	const images: ICloudCodeImage[] = [];
	const payloadMessages = messages.map((message, index) => {
		if (!isRecord(message) || typeof message.role !== 'string' || !['system', 'user', 'assistant', 'tool'].includes(message.role)
			|| typeof message.content !== 'string' || message.content.length > CLOUDCODE_MAX_MESSAGE_LENGTH
			|| (message.role === 'system' && index !== 0)
			|| (message.images !== undefined && (message.role !== 'user' || !Array.isArray(message.images) || !cloudCodeImagesWithinLimit(message.images)))
			|| (message.toolCalls !== undefined && (message.role !== 'assistant' || !Array.isArray(message.toolCalls) || !message.toolCalls.length || message.toolCalls.length > 8))
			|| (message.reasoningContent !== undefined && (message.role !== 'assistant' || typeof message.reasoningContent !== 'string' || Buffer.byteLength(message.reasoningContent, 'utf8') > 65536))
			|| (message.reasoningDetails !== undefined && (message.role !== 'assistant' || !validReasoningDetails(message.reasoningDetails)))
			|| (message.toolCallId !== undefined && message.role !== 'tool')) {
			throw invalid();
		}
		if (message.role === 'tool') {
			if (typeof message.toolCallId !== 'string' || !pending.delete(message.toolCallId)) { throw invalid(); }
		} else if (pending.size) {
			throw invalid();
		}
		const toolCalls = message.toolCalls?.map(call => {
			if (!isRecord(call) || typeof call.id !== 'string' || !idPattern.test(call.id) || seen.has(call.id)
				|| typeof call.name !== 'string' || !namePattern.test(call.name) || typeof call.arguments !== 'string' || Buffer.byteLength(call.arguments, 'utf8') > 65536) {
				throw invalid();
			}
			pending.add(call.id);
			seen.add(call.id);
			return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
		});
		const reasoning = {
			...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
			...(message.reasoningDetails !== undefined ? { reasoning_details: message.reasoningDetails } : {})
		};
		if (Buffer.byteLength(message.reasoningContent ?? '', 'utf8') + (message.reasoningDetails ? Buffer.byteLength(JSON.stringify(message.reasoningDetails), 'utf8') : 0) > 65536) { throw invalid(); }
		// Image bytes have their own limit; include all remaining wire fields in the text budget.
		bytes += Buffer.byteLength(JSON.stringify({ role: message.role, content: message.content, tool_calls: toolCalls, tool_call_id: message.toolCallId, ...reasoning }), 'utf8');
		if (bytes > CLOUDCODE_MAX_AGENT_CONTEXT_BYTES) { throw invalid(); }
		images.push(...message.images ?? []);
		return {
			role: message.role,
			content: message.images?.length ? [
				{ type: 'text', text: message.content },
				...message.images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl } }))
			] : message.content,
			...(toolCalls ? { tool_calls: toolCalls } : {}),
			...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}),
			...reasoning
		};
	});
	if (pending.size || !cloudCodeImagesWithinLimit(images)) { throw invalid(); }
	return { model, messages: payloadMessages, tools: payloadTools, tool_choice: 'auto', parallel_tool_calls: false, stream: true, max_tokens: maxOutputTokens, stream_options: { include_usage: true } };
}

export function parseCloudCodeAuthConfiguration(value: unknown, origin: string): ICloudCodeAuthConfiguration {
	if (!isRecord(value) || typeof value.client_id !== 'string' || !value.client_id || value.client_id.length > 256
		|| value.authorization_endpoint !== `${origin}/oauth/authorize`
		|| value.token_endpoint !== `${origin}/cloudcode/oauth/token`
		|| value.redirect_uri !== CLOUDCODE_REDIRECT_URI || value.scope !== 'cloudcode:inference'
		|| value.api_base_url !== `${origin}/cloudcode/api`) {
		throw new Error(localize('cloudcode.authConfigurationInvalid', "This server is not configured for CloudCode sign-in."));
	}
	return {
		client_id: value.client_id,
		authorization_endpoint: value.authorization_endpoint,
		token_endpoint: value.token_endpoint,
		redirect_uri: value.redirect_uri,
		scope: value.scope,
		api_base_url: value.api_base_url
	};
}

export function createCloudCodeAuthorization(config: ICloudCodeAuthConfiguration): { url: string; verifier: string; state: string } {
	const verifier = randomBytes(32).toString('base64url');
	const state = randomBytes(32).toString('base64url');
	const url = new URL(config.authorization_endpoint);
	url.search = new URLSearchParams({
		client_id: config.client_id,
		redirect_uri: config.redirect_uri,
		response_type: 'code',
		scope: config.scope,
		state,
		code_challenge: createHash('sha256').update(verifier).digest('base64url'),
		code_challenge_method: 'S256'
	}).toString();
	return { url: url.toString(), verifier, state };
}

/** One loopback listener per sign-in; never binds a public interface or logs callback URLs. */
export class CloudCodeLoopback extends Disposable {

	private server: Server | undefined;
	private readonly code: Promise<string>;
	private resolveCode!: (code: string) => void;
	private rejectCode!: (error: Error) => void;
	private completed = false;

	constructor(private readonly state: string, token: CancellationToken) {
		super();
		this.code = new Promise<string>((resolve, reject) => {
			this.resolveCode = resolve;
			this.rejectCode = reject;
		});
		// Cancellation may happen while listen() is still acquiring the port.
		void this.code.catch(() => undefined);
		this._register(token.onCancellationRequested(() => this.dispose()));
		if (token.isCancellationRequested) {
			this.dispose();
		}
	}

	private handleRequest(request: IncomingMessage, response: ServerResponse): void {
		response.setHeader('Content-Type', 'text/plain; charset=utf-8');
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('X-Content-Type-Options', 'nosniff');
		if (request.method !== 'GET' || request.headers.host !== '127.0.0.1:43827' || !request.url || request.url.length > 8192) {
			response.writeHead(400).end();
			return;
		}
		const url = new URL(request.url, CLOUDCODE_REDIRECT_URI);
		if (url.pathname !== '/cloudcode/callback' || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== this.state || this.completed) {
			response.writeHead(400).end(localize('cloudcode.invalidCallback', "This sign-in request is invalid or has expired."));
			return;
		}
		if (url.searchParams.has('error')) {
			response.end(localize('cloudcode.declinedCallback', "Sign-in was declined. You can return to CloudCode."));
			this.fail(new Error(localize('cloudcode.signInDeclined', "CloudCode sign-in was declined.")));
			return;
		}
		const code = url.searchParams.get('code');
		if (!code || url.searchParams.getAll('code').length !== 1 || code.length > 4096) {
			response.writeHead(400).end();
			return;
		}
		this.completed = true;
		response.end(localize('cloudcode.returnToApp', "You can return to CloudCode to finish signing in."));
		this.resolveCode(code);
	}

	async listen(): Promise<void> {
		const { createServer } = await import('http');
		if (this._store.isDisposed) {
			throw canceled();
		}
		const server = this.server = createServer((request, response) => this.handleRequest(request, response));
		server.requestTimeout = 10000;
		server.headersTimeout = 10000;
		server.on('error', () => this.fail(new Error(localize('cloudcode.callbackPortBusy', "CloudCode could not open its sign-in callback on port 43827. Close any other CloudCode sign-in attempt and try again."))));
		await new Promise<void>((resolve, reject) => {
			const listeners = this._register(new DisposableStore());
			const onError = () => { reject(new Error(localize('cloudcode.callbackPortBusy', "CloudCode could not open its sign-in callback on port 43827. Close any other CloudCode sign-in attempt and try again."))); listeners.dispose(); };
			server.once('error', onError);
			listeners.add(toDisposable(() => server.removeListener('error', onError)));
			listeners.add(toDisposable(() => reject(canceled())));
			server.listen(43827, '127.0.0.1', () => {
				if (this._store.isDisposed) {
					server.close();
					server.closeAllConnections();
					reject(canceled());
				} else {
					resolve();
				}
				listeners.dispose();
			});
		});
	}

	waitForCode(): Promise<string> {
		return this.code;
	}

	private fail(error: Error): void {
		if (!this.completed) {
			this.completed = true;
			this.rejectCode(error);
		}
	}

	override dispose(): void {
		this.fail(canceled());
		this.server?.close();
		this.server?.closeAllConnections();
		super.dispose();
	}
}

/** Incremental SSE decoding, including UTF-8 and line boundaries split across packets. */
export class CloudCodeEventStream {

	private readonly decoder = new TextDecoder();
	private buffer = '';
	private data: string[] = [];
	private event = '';
	private eventSize = 0;
	private outputSize = 0;
	private done = false;

	constructor(private readonly onText: (text: string) => void, private readonly onValue?: (value: Record<string, unknown>) => void) { }

	accept(bytes: Uint8Array): void {
		if (this.done) {
			return;
		}
		this.buffer += this.decoder.decode(bytes, { stream: true });
		this.consumeLines(false);
	}

	finish(): void {
		this.buffer += this.decoder.decode();
		this.consumeLines(true);
		if (!this.done) {
			throw new Error(localize('cloudcode.incompleteResponse', "The response was interrupted. You can try sending your message again."));
		}
	}

	private consumeLines(final: boolean): void {
		while (!this.done) {
			const index = this.buffer.search(/[\r\n]/);
			if (index < 0 || (!final && this.buffer[index] === '\r' && index === this.buffer.length - 1)) {
				break;
			}
			const line = this.buffer.slice(0, index);
			const length = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
			this.buffer = this.buffer.slice(index + length);
			this.line(line);
		}
		if (this.buffer.length + this.eventSize > 1024 * 1024) {
			throw new Error(localize('cloudcode.responseTooLarge', "The server response exceeded the CloudCode limit."));
		}
	}

	private line(line: string): void {
		if (line === '') {
			this.dispatch();
			return;
		}
		if (line.startsWith('data:')) {
			const data = line.slice(5).replace(/^ /, '');
			this.data.push(data);
			this.eventSize += data.length;
			if (this.eventSize > 1024 * 1024) {
				throw new Error(localize('cloudcode.responseTooLarge', "The server response exceeded the CloudCode limit."));
			}
		} else if (line.startsWith('event:')) {
			this.event = line.slice(6).trim();
		}
	}

	private dispatch(): void {
		const data = this.data.join('\n');
		const event = this.event;
		this.data = [];
		this.event = '';
		this.eventSize = 0;
		if (!data) {
			return;
		}
		if (event === 'error') {
			throw new Error(localize('cloudcode.streamError', "The inference service could not finish this response. Please try again."));
		}
		if (data.trim() === '[DONE]') {
			this.done = true;
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(data);
		} catch {
			throw new Error(localize('cloudcode.invalidStream', "The inference service returned an invalid response."));
		}
		if (!isRecord(value) || value.error) {
			throw new Error(localize('cloudcode.streamError', "The inference service could not finish this response. Please try again."));
		}
		this.onValue?.(value);
		if (Array.isArray(value.choices)) {
			const choice: unknown = value.choices[0];
			if (isRecord(choice) && isRecord(choice.delta) && typeof choice.delta.content === 'string') {
				this.outputSize += choice.delta.content.length;
				if (this.outputSize > 256 * 1024) {
					throw new Error(localize('cloudcode.responseTooLarge', "The server response exceeded the CloudCode limit."));
				}
				this.onText(choice.delta.content);
			}
		}
	}
}

/** Collect native tool-call deltas without ever executing a partial response. */
export class CloudCodeAgentEventStream {
	private readonly stream = new CloudCodeEventStream(() => { }, value => this.acceptValue(value));
	private readonly calls = new Map<number, { id: string; name: string; arguments: string }>();
	private text = '';
	private bytes = 0;
	private finishReason: string | undefined;
	private reasoningContent: string | undefined;
	private reasoningDetails: Record<string, unknown>[] | undefined;

	accept(bytes: Uint8Array): void { this.stream.accept(bytes); }

	finish(): ICloudCodeAgentResponse {
		this.stream.finish();
		if (!this.finishReason) { throw this.invalid(); }
		// Truncation is surfaced to the Agent for a bounded retry. Partial arguments are never returned as executable calls.
		if (this.finishReason === 'length' || this.finishReason === 'content_filter') {
			return { cancelled: false, text: this.text, toolCalls: [], finishReason: this.finishReason };
		}
		const calls = [...this.calls].sort(([left], [right]) => left - right);
		const ids = new Set<string>();
		for (let index = 0; index < calls.length; index++) {
			const [position, call] = calls[index];
			if (position !== index || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) || ids.has(call.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(call.name)) { throw this.invalid(); }
			ids.add(call.id);
		}
		if ((this.finishReason === 'tool_calls') !== (calls.length > 0)) { throw this.invalid(); }
		return {
			cancelled: false, text: this.text, toolCalls: calls.map(([, call]) => call), finishReason: this.finishReason,
			...(this.reasoningContent !== undefined ? { reasoningContent: this.reasoningContent } : {}),
			...(this.reasoningDetails !== undefined ? { reasoningDetails: this.reasoningDetails } : {})
		};
	}

	private invalid(): Error {
		return new Error(localize('cloudcode.invalidStream', "The inference service returned an invalid response."));
	}

	private count(value: string): string {
		this.bytes += Buffer.byteLength(value, 'utf8');
		if (this.bytes > 65536) {
			throw new Error(localize('cloudcode.responseTooLarge', "The server response exceeded the CloudCode limit."));
		}
		return value;
	}

	private acceptValue(value: Record<string, unknown>): void {
		if (!Array.isArray(value.choices) || value.choices.length > 1) { throw this.invalid(); }
		if (!value.choices.length) { return; } // A trailing usage chunk has no choices.
		const choice: unknown = value.choices[0];
		if (!isRecord(choice) || (choice.index !== undefined && choice.index !== 0) || !isRecord(choice.delta) || this.finishReason) { throw this.invalid(); }
		const delta = choice.delta;
		if ((delta.role !== undefined && delta.role !== 'assistant') || delta.function_call !== undefined
			|| (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string')
			|| (delta.reasoning_content !== undefined && delta.reasoning_content !== null && typeof delta.reasoning_content !== 'string')
			|| (delta.reasoning !== undefined && delta.reasoning !== null && typeof delta.reasoning !== 'string')) { throw this.invalid(); }
		if (typeof delta.content === 'string') { this.text += this.count(delta.content); }
		const reasoning = delta.reasoning_content ?? delta.reasoning;
		if (typeof reasoning === 'string') { this.reasoningContent = (this.reasoningContent ?? '') + this.count(reasoning); }
		if (delta.reasoning_details !== undefined && delta.reasoning_details !== null) {
			if (!validReasoningDetails(delta.reasoning_details)) { throw this.invalid(); }
			this.count(JSON.stringify(delta.reasoning_details));
			this.reasoningDetails ??= [];
			this.reasoningDetails.push(...delta.reasoning_details);
			if (!validReasoningDetails(this.reasoningDetails)) { throw this.invalid(); }
		}
		if (delta.tool_calls !== undefined) {
			if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 8) { throw this.invalid(); }
			for (const part of delta.tool_calls) {
				if (!isRecord(part) || typeof part.index !== 'number' || !Number.isInteger(part.index) || part.index < 0 || part.index >= 8
					|| (part.type !== undefined && part.type !== 'function') || (part.id !== undefined && typeof part.id !== 'string')
					|| (part.function !== undefined && !isRecord(part.function))) { throw this.invalid(); }
				const call = this.calls.get(part.index) ?? { id: '', name: '', arguments: '' };
				if (typeof part.id === 'string') { call.id += this.count(part.id); }
				if (isRecord(part.function)) {
					if ((part.function.name !== undefined && typeof part.function.name !== 'string') || (part.function.arguments !== undefined && typeof part.function.arguments !== 'string')) { throw this.invalid(); }
					if (typeof part.function.name === 'string') { call.name += this.count(part.function.name); }
					if (typeof part.function.arguments === 'string') { call.arguments += this.count(part.function.arguments); }
				}
				if (call.id.length > 128 || call.name.length > 64) { throw this.invalid(); }
				this.calls.set(part.index, call);
			}
		}
		if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
			if (typeof choice.finish_reason !== 'string' || !['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason)) { throw this.invalid(); }
			this.finishReason = choice.finish_reason;
		}
	}
}

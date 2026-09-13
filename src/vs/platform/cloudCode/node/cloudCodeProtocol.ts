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

export const CLOUDCODE_REDIRECT_URI = 'http://127.0.0.1:43827/cloudcode/callback';

export function cloudCodeOrigin(value: string): string {
	const url = new URL(value);
	const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
	if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error(localize('cloudcode.serverUrlInvalid', "The CloudCode server must be an HTTPS origin. HTTP is supported only for local development."));
	}
	return url.origin;
}

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

	constructor(private readonly onText: (text: string) => void) { }

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

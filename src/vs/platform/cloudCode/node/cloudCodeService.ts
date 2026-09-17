/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cloudCodeImagesWithinLimit } from '../common/cloudCodeImages.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { raceCancellationError, Sequencer } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { canceled, isCancellationError } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { listenStream } from '../../../base/common/stream.js';
import { IRequestContext } from '../../../base/parts/request/common/request.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { INativeHostService } from '../../native/common/native.js';
import { IRequestService, NO_FETCH_TELEMETRY } from '../../request/common/request.js';
import { ISecretStorageService } from '../../secrets/common/secrets.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { ICloudCodeAgentDiagnostic } from '../common/cloudCodeDiagnostics.js';
import { CloudCodeDiagnostics } from './cloudCodeDiagnostics.js';
import { CLOUDCODE_DEFAULT_SERVER, CLOUDCODE_MAX_CONTEXT_BYTES, CLOUDCODE_MAX_MESSAGES, CLOUDCODE_MAX_MESSAGE_LENGTH, CLOUDCODE_SERVER_SETTING, ICloudCodeAccount, ICloudCodeChatDelta, ICloudCodeMessage, ICloudCodeModel, ICloudCodeService, ICloudCodeState } from '../common/cloudCode.js';
import { CLOUDCODE_REDIRECT_URI, CloudCodeEventStream, CloudCodeLoopback, cloudCodeOrigin, createCloudCodeAuthorization, isRecord, parseCloudCodeAuthConfiguration } from './cloudCodeProtocol.js';

interface IStoredTokens {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly expiresAt: number;
	readonly clientId: string;
}

class CloudCodeHttpError extends Error {
	constructor(readonly status: number) {
		super(status === 401
			? localize('cloudcode.sessionExpired', "Your CloudCode session has expired. Sign in again.")
			: status === 402
				? localize('cloudcode.balanceRequired', "Your CloudCompute balance is insufficient for this request.")
				: status === 403
					? localize('cloudcode.accessDenied', "This account does not have access to CloudCode inference. Check your team permissions.")
					: status === 429
						? localize('cloudcode.rateLimited', "Too many requests. Wait a moment and try again.")
						: status === 422
							? localize('cloudcode.requestInvalid', "This model or conversation is not supported. Choose another model or start a new chat.")
							: localize('cloudcode.serverError', "CloudCompute could not complete the request (HTTP {0}). Please try again.", status));
	}
}

function parseTokens(value: unknown, clientId: string): IStoredTokens {
	if (!isRecord(value) || typeof value.access_token !== 'string' || !value.access_token || typeof value.refresh_token !== 'string' || !value.refresh_token
		|| typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86400
		|| typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer') {
		throw new Error(localize('cloudcode.invalidTokenResponse', "CloudCompute returned an invalid sign-in response."));
	}
	return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: Date.now() + value.expires_in * 1000, clientId };
}

function parseAccount(value: unknown): ICloudCodeAccount {
	if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.team)
		|| typeof value.user.id !== 'number' || typeof value.user.name !== 'string' || typeof value.user.email !== 'string'
		|| typeof value.team.id !== 'number' || typeof value.team.name !== 'string'
		|| (value.balance !== null && (!isRecord(value.balance) || typeof value.balance.amount_minor !== 'number' || typeof value.balance.currency !== 'string'))) {
		throw new Error(localize('cloudcode.invalidSession', "CloudCompute returned an invalid account response."));
	}
	return {
		user: { id: value.user.id, name: value.user.name, email: value.user.email },
		team: { id: value.team.id, name: value.team.name },
		balance: value.balance === null ? null : { amount_minor: value.balance.amount_minor as number, currency: value.balance.currency as string }
	};
}

/** Shared-process transport: OAuth secrets and HTTP bodies never enter workbench storage. */
export class CloudCodeService extends Disposable implements ICloudCodeService {
	declare readonly _serviceBrand: undefined;
	private readonly diagnostics: CloudCodeDiagnostics;

	private readonly stateEmitter = this._register(new Emitter<ICloudCodeState>());
	readonly onDidChangeState = this.stateEmitter.event;
	private readonly deltaEmitter = this._register(new Emitter<ICloudCodeChatDelta>());
	readonly onDidReceiveChatDelta = this.deltaEmitter.event;
	private readonly requests = new Map<string, CancellationTokenSource>();
	private readonly lifetime = this._register(new CancellationTokenSource());
	private readonly storageQueue = new Sequencer();
	private origin: string | undefined;
	private tokens: IStoredTokens | undefined;
	private account: ICloudCodeAccount | undefined;
	private initialization: Promise<void> | undefined;
	private refresh: Promise<IStoredTokens> | undefined;
	private signingIn: CancellationTokenSource | undefined;
	private signInCompletion: Promise<void> | undefined;
	private signInCancelled = false;
	private signingOut: Promise<void> | undefined;
	private isSigningOut = false;
	private generation = 0;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService private readonly secretStorage: ISecretStorageService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IProductService productService: IProductService,
		@ILogService logService: ILogService,
	) {
		super();
		this.diagnostics = this._register(new CloudCodeDiagnostics(configurationService, productService, logService));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLOUDCODE_SERVER_SETTING)) {
				this.cancelOperations();
				this.generation++;
				this.tokens = undefined;
				this.account = undefined;
				this.origin = undefined;
				this.initialization = undefined;
				this.refresh = undefined;
				this.publish();
			}
		}));
	}

	reportAgentError(diagnostic: ICloudCodeAgentDiagnostic): Promise<void> {
		return this.diagnostics.report(diagnostic);
	}

	async getState(): Promise<ICloudCodeState> {
		await this.initialize();
		if (this.tokens && !this.account && !this.signingOut) {
			const generation = this.generation;
			const value = await this.authorizedJson('/session', 'GET', undefined, this.lifetime.token);
			this.assertCurrent(generation);
			this.account = parseAccount(value);
		}
		return this.state();
	}

	signIn(): Promise<void> {
		if (!this.signInCompletion) {
			this.signInCancelled = false;
			this.signInCompletion = this.doSignIn().finally(() => { this.signInCompletion = undefined; });
		}
		return this.signInCompletion;
	}

	private async doSignIn(): Promise<void> {
		if (this.isSigningOut || this.signInCancelled) {
			throw canceled();
		}
		await this.initialize();
		if (this.isSigningOut || this.signInCancelled) {
			throw canceled();
		}
		if (this.signingIn) {
			return;
		}
		if (this.tokens) {
			// Retry session discovery after an offline startup without opening a
			// second browser login or abandoning the remembered credentials.
			await this.getState();
			this.publish();
			return;
		}
		const operation = new DisposableStore();
		const source = operation.add(new CancellationTokenSource(this.lifetime.token));
		this.signingIn = source;
		const generation = ++this.generation;
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; source.cancel(); }, 5 * 60 * 1000);
		operation.add(toDisposable(() => clearTimeout(timer)));
		this.publish();
		const origin = this.origin!;
		let issuedTokens: IStoredTokens | undefined;
		try {
			const config = parseCloudCodeAuthConfiguration(await this.json(origin, '/cloudcode/auth/config', 'GET', undefined, source.token), origin);
			const authorization = createCloudCodeAuthorization(config);
			const callback = operation.add(new CloudCodeLoopback(authorization.state, source.token));
			await callback.listen();
			const [code] = await Promise.all([
				callback.waitForCode(),
				this.nativeHostService.openExternal(authorization.url).then(opened => {
					if (!opened) {
						throw new Error(localize('cloudcode.browserFailed', "CloudCode could not open your browser. Please try signing in again."));
					}
				})
			]);
			const tokens = parseTokens(await this.json(origin, '/cloudcode/oauth/token', 'POST', {
				grant_type: 'authorization_code', client_id: config.client_id, redirect_uri: CLOUDCODE_REDIRECT_URI, code, code_verifier: authorization.verifier
			}, source.token), config.client_id);
			issuedTokens = tokens;
			this.assertCurrent(generation, source.token);
			// Save immediately so a temporary session-info failure can be retried without losing the refresh token.
			await this.saveTokens(tokens, generation);
			const account = parseAccount(await this.json(origin, '/cloudcode/api/session', 'GET', undefined, source.token, tokens.accessToken));
			this.assertCurrent(generation, source.token);
			this.account = account;
		} catch (error) {
			if (source.token.isCancellationRequested && issuedTokens) {
				if (this.tokens === issuedTokens) {
					this.tokens = undefined;
					this.account = undefined;
				}
				await this.storageQueue.queue(() => this.secretStorage.delete(this.secretKey(origin)));
				try {
					const response = await this.request(origin, '/cloudcode/api/session', 'DELETE', undefined, this.lifetime.token, issuedTokens.accessToken);
					response.stream.destroy();
				} catch {
					// Cancellation must still clear local credentials when the server is offline.
				}
			}
			if (timedOut) {
				throw new Error(localize('cloudcode.signInTimeout', "Sign-in timed out. Please try again."));
			}
			throw error;
		} finally {
			if (this.signingIn === source) {
				this.signingIn = undefined;
			}
			operation.dispose();
			this.publish();
		}
	}

	async cancelSignIn(): Promise<void> {
		this.signInCancelled = true;
		this.signingIn?.cancel();
		await this.signInCompletion?.catch(() => undefined);
	}

	signOut(): Promise<void> {
		if (!this.signingOut) {
			this.isSigningOut = true;
			this.signingOut = this.doSignOut(this.signInCompletion).finally(() => { this.signingOut = undefined; this.isSigningOut = false; });
		}
		return this.signingOut;
	}

	private async doSignOut(pendingSignIn: Promise<void> | undefined): Promise<void> {
		this.cancelOperations();
		await pendingSignIn?.catch(() => undefined);
		await this.initialize();
		const origin = this.origin!;
		let failure: Error | undefined;
		try {
			// A refresh rotates credentials. Revoke its successor, never the obsolete access token.
			await this.refresh;
			if (this.tokens) {
				const tokens = await this.accessTokens();
				const response = await this.request(origin, '/cloudcode/api/session', 'DELETE', undefined, this.lifetime.token, tokens.accessToken);
				response.stream.destroy();
			}
		} catch {
			failure = new Error(localize('cloudcode.revokeFailed', "Signed out on this device. CloudCompute could not confirm revocation of the server session."));
		} finally {
			this.generation++;
			if (this.origin === origin) {
				this.tokens = undefined;
				this.account = undefined;
			}
			await this.storageQueue.queue(() => this.secretStorage.delete(this.secretKey(origin)));
			this.publish();
		}
		if (failure) {
			throw failure;
		}
	}

	async getModels(): Promise<readonly ICloudCodeModel[]> {
		await this.initialize();
		const value = await this.authorizedJson('/models', 'GET', undefined, this.lifetime.token);
		if (!isRecord(value) || !Array.isArray(value.data)) {
			throw new Error(localize('cloudcode.invalidModels', "CloudCompute could not load the available models."));
		}
		return value.data.filter((model: unknown): model is { id: string; name?: string; architecture?: { input_modalities?: string[] } } => isRecord(model) && typeof model.id === 'string' && model.id.length > 0 && model.id.length <= 200)
			.map(model => ({
				id: model.id,
				name: typeof model.name === 'string' ? model.name : model.id,
				...(Array.isArray(model.architecture?.input_modalities) ? { supportsImages: model.architecture.input_modalities.includes('image') } : {})
			}));
	}

	async streamChat(requestId: string, model: string, messages: readonly ICloudCodeMessage[]): Promise<{ cancelled: boolean }> {
		if (!requestId || this.requests.has(requestId) || this.signingOut) {
			throw new Error(localize('cloudcode.requestBusy', "Wait for the current operation to finish."));
		}
		if (!model || model.length > 200 || messages.length === 0 || messages.length > CLOUDCODE_MAX_MESSAGES
			|| messages.some(message => !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > CLOUDCODE_MAX_MESSAGE_LENGTH)
			|| messages.reduce((size, message) => size + Buffer.byteLength(message.content, 'utf8'), 0) > CLOUDCODE_MAX_CONTEXT_BYTES) {
			throw new Error(localize('cloudcode.conversationLimit', "This conversation exceeds the CloudCode limit. Start a new chat or use a shorter message."));
		}
		const images = messages.flatMap(message => message.images ?? []);
		if (messages.some(message => message.images !== undefined && (!Array.isArray(message.images) || message.role !== 'user'))
			|| !cloudCodeImagesWithinLimit(images)) {
			throw new Error(localize('cloudcode.imageLimit', "Use up to 5 PNG, JPEG, GIF, or WebP images, 4 MiB each and 8 MiB per conversation. Start a New Chat to clear earlier images."));
		}
		const payloadMessages = messages.map(message => ({
			role: message.role,
			content: message.images?.length ? [
				{ type: 'text', text: message.content },
				...message.images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl } }))
			] : message.content
		}));
		const source = new CancellationTokenSource(this.lifetime.token);
		this.requests.set(requestId, source);
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; source.cancel(); }, 5 * 60 * 1000);
		try {
			await raceCancellationError(this.initialize(), source.token);
			const context = await this.authorizedRequest('/chat/completions', 'POST', {
				model, messages: payloadMessages, stream: true, max_tokens: 2048, stream_options: { include_usage: true }
			}, source.token);
			const contentType = context.res.headers['content-type'];
			if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('text/event-stream')) {
				context.stream.destroy();
				throw new Error(localize('cloudcode.invalidStream', "The inference service returned an invalid response."));
			}
			const stream = new CloudCodeEventStream(text => this.deltaEmitter.fire({ requestId, text }));
			await this.readStream(context, data => stream.accept(data.buffer), source.token);
			stream.finish();
			return { cancelled: false };
		} catch (error) {
			if (timedOut) {
				throw new Error(localize('cloudcode.chatTimeout', "The response timed out. Please try again."));
			}
			if (source.token.isCancellationRequested || isCancellationError(error)) {
				return { cancelled: true };
			}
			throw error;
		} finally {
			clearTimeout(timer);
			source.dispose();
			this.requests.delete(requestId);
		}
	}

	async cancelChat(requestId: string): Promise<void> {
		this.requests.get(requestId)?.cancel();
	}

	private initialize(): Promise<void> {
		if (!this.initialization) {
			this.origin = cloudCodeOrigin(this.configurationService.getValue<string>(CLOUDCODE_SERVER_SETTING) || CLOUDCODE_DEFAULT_SERVER);
			const origin = this.origin;
			const generation = this.generation;
			this.initialization = (async () => {
				const stored = await this.secretStorage.get(this.secretKey(origin));
				this.assertCurrent(generation);
				if (stored) {
					try {
						const value: unknown = JSON.parse(stored);
						if (isRecord(value) && typeof value.accessToken === 'string' && typeof value.refreshToken === 'string' && typeof value.expiresAt === 'number' && typeof value.clientId === 'string') {
							this.tokens = { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt, clientId: value.clientId };
						}
					} catch {
						await this.secretStorage.delete(this.secretKey(origin));
					}
				}
			})();
		}
		return this.initialization;
	}

	private async accessTokens(force = false): Promise<IStoredTokens> {
		const current = this.tokens;
		if (!current) {
			throw new CloudCodeHttpError(401);
		}
		if (this.refresh) {
			return this.refresh;
		}
		if (!force && current.expiresAt > Date.now() + 60000) {
			return current;
		}
		const generation = this.generation;
		const origin = this.origin!;
		const refresh = (async () => {
			try {
				const value = await this.json(origin, '/cloudcode/oauth/token', 'POST', {
					grant_type: 'refresh_token', client_id: current.clientId, refresh_token: current.refreshToken, scope: 'cloudcode:inference'
				}, this.lifetime.token);
				const tokens = parseTokens(value, current.clientId);
				await this.saveTokens(tokens, generation);
				return tokens;
			} catch (error) {
				if (generation === this.generation && error instanceof CloudCodeHttpError && [400, 401, 403].includes(error.status)) {
					this.tokens = undefined;
					this.account = undefined;
					await this.secretStorage.delete(this.secretKey(origin));
					this.publish();
					throw new CloudCodeHttpError(401);
				}
				throw error;
			}
		})();
		this.refresh = refresh;
		try {
			return await refresh;
		} finally {
			if (this.refresh === refresh) {
				this.refresh = undefined;
			}
		}
	}

	private async saveTokens(tokens: IStoredTokens, generation: number): Promise<void> {
		this.assertCurrent(generation);
		const origin = this.origin!;
		await this.storageQueue.queue(async () => {
			this.assertCurrent(generation);
			await this.secretStorage.set(this.secretKey(origin), JSON.stringify(tokens));
		});
		this.assertCurrent(generation);
		this.tokens = tokens;
	}

	private async authorizedRequest(path: string, method: string, body: object | undefined, token: CancellationToken): Promise<IRequestContext> {
		const generation = this.generation;
		let tokens = await raceCancellationError(this.accessTokens(), token);
		this.assertCurrent(generation, token);
		try {
			return await this.request(this.origin!, `/cloudcode/api${path}`, method, body, token, tokens.accessToken);
		} catch (error) {
			if (!(error instanceof CloudCodeHttpError) || error.status !== 401) {
				throw error;
			}
			tokens = this.tokens !== tokens && this.tokens ? this.tokens : await raceCancellationError(this.accessTokens(true), token);
			this.assertCurrent(generation, token);
			return this.request(this.origin!, `/cloudcode/api${path}`, method, body, token, tokens.accessToken);
		}
	}

	private async authorizedJson(path: string, method: string, body: object | undefined, token: CancellationToken): Promise<unknown> {
		return this.readJson(await this.authorizedRequest(path, method, body, token), token);
	}

	private async json(origin: string, path: string, method: string, body: object | undefined, token: CancellationToken, bearer?: string): Promise<unknown> {
		return this.readJson(await this.request(origin, path, method, body, token, bearer), token);
	}

	private async request(origin: string, path: string, method: string, body: object | undefined, token: CancellationToken, bearer?: string): Promise<IRequestContext> {
		if (token.isCancellationRequested) {
			throw canceled();
		}
		const response = this.requestService.request({
			url: `${origin}${path}`, type: method, data: body ? JSON.stringify(body) : undefined,
			headers: { Accept: path.endsWith('/chat/completions') ? 'text/event-stream' : 'application/json', 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
			followRedirects: 0, timeout: path.endsWith('/chat/completions') ? 120000 : 30000, disableCache: true, callSite: NO_FETCH_TELEMETRY
		}, token).then(context => {
			if (token.isCancellationRequested) {
				context.stream.destroy();
				throw canceled();
			}
			return context;
		});
		const context = await raceCancellationError(response, token);
		if (!context.res.statusCode || context.res.statusCode < 200 || context.res.statusCode >= 300) {
			context.stream.destroy();
			throw new CloudCodeHttpError(context.res.statusCode ?? 0);
		}
		return context;
	}

	private async readJson(context: IRequestContext, token: CancellationToken): Promise<unknown> {
		const chunks: VSBuffer[] = [];
		let bytes = 0;
		await this.readStream(context, data => {
			bytes += data.byteLength;
			if (bytes > 1024 * 1024) {
				throw new Error(localize('cloudcode.responseTooLarge', "The server response exceeded the CloudCode limit."));
			}
			chunks.push(data);
		}, token);
		try {
			return JSON.parse(VSBuffer.concat(chunks).toString());
		} catch {
			throw new Error(localize('cloudcode.invalidServerResponse', "CloudCompute returned an invalid response. Please try again."));
		}
	}

	private readStream(context: IRequestContext, onData: (data: VSBuffer) => void, token: CancellationToken): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const listeners = new DisposableStore();
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) { return; }
				settled = true;
				listeners.dispose();
				context.stream.destroy();
				if (error) { reject(error); } else { resolve(); }
			};
			listeners.add(token.onCancellationRequested(() => finish(canceled())));
			if (token.isCancellationRequested) {
				finish(canceled());
				return;
			}
			listenStream(context.stream, {
				onData: data => { if (!settled) { try { onData(data); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); } } },
				onError: error => finish(error),
				onEnd: () => finish()
			});
		});
	}

	private secretKey(origin: string): string {
		return `cloudcode.oauth:${origin}`;
	}

	private assertCurrent(generation: number, token = this.lifetime.token): void {
		if (generation !== this.generation || token.isCancellationRequested || this._store.isDisposed) {
			throw canceled();
		}
	}

	private state(): ICloudCodeState {
		return { status: this.signingIn ? 'signingIn' : this.tokens ? 'signedIn' : 'signedOut', account: this.account, persisted: this.secretStorage.type === 'persisted' };
	}

	private publish(): void {
		this.stateEmitter.fire(this.state());
	}

	private cancelOperations(): void {
		this.signInCancelled = true;
		this.signingIn?.cancel();
		for (const request of this.requests.values()) {
			request.cancel();
		}
	}

	override dispose(): void {
		this.cancelOperations();
		this.lifetime.cancel();
		super.dispose();
	}
}

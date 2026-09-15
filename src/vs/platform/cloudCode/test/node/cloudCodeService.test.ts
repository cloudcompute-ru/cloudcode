/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { restore, useFakeTimers } from 'sinon';
import { DeferredPromise } from '../../../../base/common/async.js';
import { bufferToStream, newWriteableBufferStream, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { IRequestContext, IRequestOptions } from '../../../../base/parts/request/common/request.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { INativeHostService } from '../../../native/common/native.js';
import { IRequestService } from '../../../request/common/request.js';
import { TestSecretStorageService } from '../../../secrets/test/common/testSecretStorageService.js';
import { CLOUDCODE_SERVER_SETTING } from '../../common/cloudCode.js';
import { CLOUDCODE_REDIRECT_URI } from '../../node/cloudCodeProtocol.js';
import { CloudCodeService } from '../../node/cloudCodeService.js';

suite('CloudCode service', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => restore());
	const origin = 'https://app.cloudcompute.ru';
	const secretKey = `cloudcode.oauth:${origin}`;
	const account = { user: { id: 1, name: 'CloudCode User', email: 'test@example.com' }, team: { id: 2, name: 'Test Team' }, balance: null };
	const grant = { access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 };
	const configuration = {
		client_id: 'desktop-client', authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/cloudcode/oauth/token`,
		redirect_uri: CLOUDCODE_REDIRECT_URI, scope: 'cloudcode:inference', api_base_url: `${origin}/cloudcode/api`
	};

	function json(value: object, statusCode = 200): IRequestContext {
		return { res: { statusCode, headers: { 'content-type': 'application/json' } }, stream: bufferToStream(VSBuffer.fromString(JSON.stringify(value))) };
	}

	type Handler = (options: IRequestOptions, token: CancellationToken) => Promise<IRequestContext>;

	function setupService(handler: Handler, secrets = store.add(new TestSecretStorageService()), openExternal: (url: string) => Promise<boolean> = async () => true, server = origin) {
		const requests: IRequestOptions[] = [];
		const configurationService = new TestConfigurationService({ [CLOUDCODE_SERVER_SETTING]: server });
		store.add(configurationService.onDidChangeConfigurationEmitter);
		const requestService = new class extends mock<IRequestService>() {
			override request(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> {
				requests.push(options);
				return handler(options, token);
			}
		};
		const nativeHost = new class extends mock<INativeHostService>() {
			override openExternal(url: string): Promise<boolean> {
				return openExternal(url);
			}
		};
		return { service: store.add(new CloudCodeService(configurationService, requestService, secrets, nativeHost)), secrets, requests };
	}

	async function savedSession(expired = false): Promise<TestSecretStorageService> {
		const secrets = store.add(new TestSecretStorageService());
		await secrets.set(secretKey, JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: expired ? 0 : Date.now() + 3600000, clientId: 'desktop-client' }));
		return secrets;
	}

	async function authorize(url: string): Promise<boolean> {
		const browserUrl = new URL(url);
		const callback = new URL(CLOUDCODE_REDIRECT_URI);
		callback.search = new URLSearchParams({ state: browserUrl.searchParams.get('state')!, code: 'test-code' }).toString();
		const response = await fetch(callback);
		await response.text();
		assert.strictEqual(response.status, 200);
		return true;
	}

	test('serializes image references as standard content parts while retaining plain text turns', async () => {
		const { service, requests } = setupService(async options => options.url?.endsWith('/chat/completions') ? {
			res: { statusCode: 200, headers: { 'content-type': 'text/event-stream' } },
			stream: bufferToStream(VSBuffer.fromString('data: [DONE]\n\n')),
		} : json(account), await savedSession());
		const image = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=' };
		await service.streamChat('image', 'test-model', [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }, { role: 'user', content: 'Describe', images: [image] }]);
		const request = requests.find(request => request.url?.endsWith('/chat/completions'))!;
		assert.deepStrictEqual(JSON.parse(request.data!).messages, [
			{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' },
			{ role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image_url', image_url: { url: image.dataUrl } }] }
		]);
	});

	test('rejects external image URLs and assistant images before any network request', async () => {
		const { service, requests } = setupService(async () => { throw new Error('Unexpected request'); });
		await assert.rejects(service.streamChat('external', 'test-model', [{ role: 'user', content: 'Image', images: [{ dataUrl: 'https://example.com/private.png' }] }]));
		await assert.rejects(service.streamChat('assistant', 'test-model', [{ role: 'assistant', content: 'Image', images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=' }] }]));
		assert.strictEqual(requests.length, 0);
	});

	test('restores an expired session with one shared refresh and accepts a hidden balance', async () => {
		const refreshStarted = new DeferredPromise<void>();
		const refreshResult = new DeferredPromise<IRequestContext>();
		const { service, secrets, requests } = setupService(async options => {
			if (options.url?.endsWith('/oauth/token')) {
				void refreshStarted.complete();
				return refreshResult.p;
			}
			return options.url?.endsWith('/models') ? json({ data: [{ id: 'test-model', name: 'Test Model' }] }) : json(account);
		}, await savedSession(true));
		const state = service.getState();
		const models = service.getModels();
		await refreshStarted.p;
		await refreshResult.complete(json(grant));
		assert.deepStrictEqual({ state: await state, models: await models, refreshes: requests.filter(item => item.url?.endsWith('/oauth/token')).length, bearers: requests.filter(item => item.url?.includes('/api/')).map(item => item.headers?.Authorization) }, {
			state: { status: 'signedIn', account, persisted: false }, models: [{ id: 'test-model', name: 'Test Model' }], refreshes: 1, bearers: ['Bearer new-access', 'Bearer new-access']
		});
		assert.strictEqual(JSON.parse((await secrets.get(secretKey))!).refreshToken, 'new-refresh');
	});

	test('Sign In retries session loading after offline startup with saved credentials', async () => {
		let attempts = 0;
		let browsers = 0;
		const { service, requests } = setupService(async () => {
			if (++attempts === 1) {
				throw new Error('offline');
			}
			return json(account);
		}, await savedSession(), async () => { browsers++; return true; });
		const statuses: string[] = [];
		store.add(service.onDidChangeState(state => statuses.push(state.status)));
		await assert.rejects(service.getState(), /offline/);
		await service.signIn();
		assert.deepStrictEqual({ account: (await service.getState()).account, browsers, statuses, bearers: requests.map(item => item.headers?.Authorization) }, {
			account, browsers: 0, statuses: ['signedIn'], bearers: ['Bearer old-access', 'Bearer old-access']
		});
	});

	test('concurrent unauthorized reads share refresh and retry with the rotated access token', async () => {
		const refreshStarted = new DeferredPromise<void>();
		const refreshResult = new DeferredPromise<IRequestContext>();
		const { service, requests } = setupService(async options => {
			if (options.url?.endsWith('/oauth/token')) {
				void refreshStarted.complete();
				return refreshResult.p;
			}
			return options.headers?.Authorization === 'Bearer old-access' ? json({}, 401) : json({ data: [] });
		}, await savedSession());
		const first = service.getModels();
		const second = service.getModels();
		await refreshStarted.p;
		await refreshResult.complete(json(grant));
		await Promise.all([first, second]);
		assert.deepStrictEqual(requests.map(item => item.url?.endsWith('/oauth/token') ? 'refresh' : item.headers?.Authorization), ['Bearer old-access', 'Bearer old-access', 'refresh', 'Bearer new-access', 'Bearer new-access']);
	});

	test('logout waits for refresh and revokes the successor before clearing local credentials', async () => {
		const refreshStarted = new DeferredPromise<void>();
		const refreshResult = new DeferredPromise<IRequestContext>();
		const { service, secrets, requests } = setupService(async options => {
			if (options.url?.endsWith('/oauth/token')) {
				void refreshStarted.complete();
				return refreshResult.p;
			}
			return json({ data: [] });
		}, await savedSession(true));
		const models = service.getModels().catch(error => { assert.ok(isCancellationError(error)); });
		await refreshStarted.p;
		const logout = service.signOut();
		await refreshResult.complete(json(grant));
		await Promise.all([models, logout]);
		assert.deepStrictEqual({ revocations: requests.filter(item => item.type === 'DELETE').map(item => item.headers?.Authorization), saved: await secrets.get(secretKey), state: (await service.getState()).status }, { revocations: ['Bearer new-access'], saved: undefined, state: 'signedOut' });
	});

	test('a rejected refresh removes the expired session without exposing server error details', async () => {
		const { service, secrets } = setupService(async () => json({ error: 'invalid_grant', error_description: 'private server details' }, 400), await savedSession(true));
		await assert.rejects(service.getModels(), /session has expired/);
		assert.deepStrictEqual({ saved: await secrets.get(secretKey), state: (await service.getState()).status }, { saved: undefined, state: 'signedOut' });
	});

	test('Stop cancels an open stream, preserves received text and ignores late chunks', async () => {
		const response = newWriteableBufferStream();
		const started = new DeferredPromise<void>();
		const received = new DeferredPromise<void>();
		const { service, requests } = setupService(async () => {
			void started.complete();
			return { res: { statusCode: 200, headers: { 'content-type': 'text/event-stream' } }, stream: response };
		}, await savedSession());
		const text: string[] = [];
		store.add(service.onDidReceiveChatDelta(delta => { text.push(delta.text); void received.complete(); }));
		const result = service.streamChat('first', 'test-model', [{ role: 'user', content: 'Hello' }]);
		await started.p;
		response.write(VSBuffer.fromString('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
		await received.p;
		await service.cancelChat('first');
		assert.deepStrictEqual(await result, { cancelled: true });
		response.write(VSBuffer.fromString('data: {"choices":[{"delta":{"content":"late"}}]}\n\ndata: [DONE]\n\n'));
		response.end();
		assert.deepStrictEqual({ text, redirects: requests[0].followRedirects }, { text: ['partial'], redirects: 0 });
	});

	test('a stopped request does not start inference after a pending refresh finishes', async () => {
		const refreshStarted = new DeferredPromise<void>();
		const refreshResult = new DeferredPromise<IRequestContext>();
		const { service, requests } = setupService(async options => {
			if (options.url?.endsWith('/oauth/token')) {
				void refreshStarted.complete();
				return refreshResult.p;
			}
			return json({ data: [] });
		}, await savedSession(true));
		const result = service.streamChat('first', 'test-model', [{ role: 'user', content: 'Hello' }]);
		await refreshStarted.p;
		await service.cancelChat('first');
		assert.deepStrictEqual(await result, { cancelled: true });
		await refreshResult.complete(json(grant));
		await service.getModels();
		assert.deepStrictEqual({ result: await result, inferenceRequests: requests.filter(item => item.url?.endsWith('/chat/completions')).length }, { result: { cancelled: true }, inferenceRequests: 0 });
	});

	test('rejects insecure origin and substituted auth endpoints before opening a browser', async () => {
		const insecure = setupService(async () => assert.fail('Insecure origin must not be requested'), undefined, undefined, 'http://app.cloudcompute.ru');
		await assert.rejects(insecure.service.signIn(), /HTTPS origin/);
		let browsers = 0;
		const substituted = setupService(async () => json({ ...configuration, token_endpoint: 'https://another.example/token' }), undefined, async () => { browsers++; return true; });
		await assert.rejects(substituted.service.signIn(), /not configured/);
		assert.strictEqual(browsers, 0);
	});

	test('an abandoned browser sign-in times out and releases its callback listener', async () => {
		const clock = useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const browserOpened = new DeferredPromise<void>();
		const { service } = setupService(async () => json(configuration), undefined, async () => { void browserOpened.complete(); return true; });
		const login = assert.rejects(service.signIn(), /timed out/);
		await browserOpened.p;
		await clock.tickAsync(5 * 60 * 1000);
		await login;
		assert.strictEqual((await service.getState()).status, 'signedOut');
		clock.restore();
	});

	test('a late authorization response after cancellation cannot restore the session', async () => {
		const exchangeStarted = new DeferredPromise<void>();
		const exchangeResult = new DeferredPromise<IRequestContext>();
		const { service, secrets } = setupService(async options => {
			if (options.url?.endsWith('/auth/config')) {
				return json(configuration);
			}
			void exchangeStarted.complete();
			return exchangeResult.p;
		}, undefined, authorize);
		const login = service.signIn();
		await exchangeStarted.p;
		const cancel = service.cancelSignIn();
		await exchangeResult.complete(json(grant));
		await assert.rejects(login, isCancellationError);
		await cancel;
		assert.deepStrictEqual({ state: (await service.getState()).status, saved: await secrets.get(secretKey) }, { state: 'signedOut', saved: undefined });
	});

	test('cancelling sign-in during credential persistence clears and revokes the acquired session', async () => {
		const saveStarted = new DeferredPromise<void>();
		const finishSave = new DeferredPromise<void>();
		const secrets = store.add(new class extends TestSecretStorageService {
			override async set(key: string, value: string): Promise<void> {
				void saveStarted.complete();
				await finishSave.p;
				await super.set(key, value);
			}
		});
		const { service, requests } = setupService(async options => options.url?.endsWith('/auth/config') ? json(configuration) : options.url?.endsWith('/oauth/token') ? json(grant) : json(account), secrets, authorize);
		const login = assert.rejects(service.signIn(), isCancellationError);
		await saveStarted.p;
		const cancel = service.cancelSignIn();
		await finishSave.complete();
		await Promise.all([cancel, login]);
		assert.deepStrictEqual({ state: (await service.getState()).status, saved: await secrets.get(secretKey), revocations: requests.filter(item => item.type === 'DELETE').map(item => item.headers?.Authorization) }, { state: 'signedOut', saved: undefined, revocations: ['Bearer new-access'] });
	});

	test('logout during a pending credential write cannot leave a restorable session', async () => {
		const saveStarted = new DeferredPromise<void>();
		const finishSave = new DeferredPromise<void>();
		const secrets = store.add(new class extends TestSecretStorageService {
			override async set(key: string, value: string): Promise<void> {
				void saveStarted.complete();
				await finishSave.p;
				await super.set(key, value);
			}
		});
		const { service } = setupService(async options => options.url?.endsWith('/auth/config') ? json(configuration) : options.url?.endsWith('/oauth/token') ? json(grant) : json(account), secrets, authorize);
		const login = service.signIn();
		const cancelledLogin = assert.rejects(login, isCancellationError);
		await saveStarted.p;
		const logout = service.signOut();
		// Let logout and the pending write race; logout must serialize final cleanup with the write.
		await new Promise<void>(resolve => setImmediate(resolve));
		await finishSave.complete();
		await Promise.all([logout, cancelledLogin]);
		assert.deepStrictEqual({ state: (await service.getState()).status, saved: await secrets.get(secretKey) }, { state: 'signedOut', saved: undefined });
	});
});

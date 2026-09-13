/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLOUDCODE_REDIRECT_URI, CloudCodeEventStream, CloudCodeLoopback, cloudCodeOrigin, createCloudCodeAuthorization, parseCloudCodeAuthConfiguration } from '../../node/cloudCodeProtocol.js';

suite('CloudCode protocol', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const origin = 'https://app.cloudcompute.ru';
	const configuration = {
		client_id: 'desktop-client',
		authorization_endpoint: `${origin}/oauth/authorize`,
		token_endpoint: `${origin}/cloudcode/oauth/token`,
		redirect_uri: CLOUDCODE_REDIRECT_URI,
		scope: 'cloudcode:inference',
		api_base_url: `${origin}/cloudcode/api`
	};

	test('requires a secure server origin and allows explicit local development', () => {
		assert.deepStrictEqual([
			cloudCodeOrigin('https://app.cloudcompute.ru/'),
			cloudCodeOrigin('http://127.0.0.1:8000'),
			cloudCodeOrigin('http://[::1]:8000'),
		], [origin, 'http://127.0.0.1:8000', 'http://[::1]:8000']);
		for (const value of ['http://app.cloudcompute.ru', 'https://user:secret@app.cloudcompute.ru', `${origin}/path`, `${origin}?token=secret`, `${origin}#token`, 'file:///tmp', 'http://localhost.example.com']) {
			assert.throws(() => cloudCodeOrigin(value), Error, value);
		}
	});

	test('binds discovered OAuth endpoints and scope to the configured server', () => {
		assert.deepStrictEqual(parseCloudCodeAuthConfiguration(configuration, origin), configuration);
		for (const replacement of [
			{ authorization_endpoint: 'https://another.example/oauth/authorize' },
			{ token_endpoint: 'https://another.example/cloudcode/oauth/token' },
			{ api_base_url: 'https://another.example/cloudcode/api' },
			{ redirect_uri: 'http://localhost:43827/cloudcode/callback' },
			{ scope: '*' },
			{ client_id: '' }
		]) {
			assert.throws(() => parseCloudCodeAuthConfiguration({ ...configuration, ...replacement }, origin));
		}
	});

	test('creates fresh state and an S256 challenge without exposing the verifier', () => {
		const first = createCloudCodeAuthorization(configuration);
		const second = createCloudCodeAuthorization(configuration);
		const parameters = new URL(first.url).searchParams;
		assert.deepStrictEqual({
			method: parameters.get('code_challenge_method'),
			challenge: parameters.get('code_challenge'),
			redirect: parameters.get('redirect_uri'),
			response: parameters.get('response_type'),
			state: parameters.get('state'),
			verifierInUrl: first.url.includes(first.verifier),
			freshState: first.state !== second.state,
			freshVerifier: first.verifier !== second.verifier,
		}, {
			method: 'S256',
			challenge: createHash('sha256').update(first.verifier).digest('base64url'),
			redirect: CLOUDCODE_REDIRECT_URI,
			response: 'code',
			state: first.state,
			verifierInUrl: false,
			freshState: true,
			freshVerifier: true,
		});
		assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/);
	});

	async function callback(path: string, host = '127.0.0.1:43827'): Promise<number | undefined> {
		const { request } = await import('http');
		return new Promise((resolve, reject) => {
			const req = request({ hostname: '127.0.0.1', port: 43827, path, headers: { Host: host }, agent: false }, response => {
				response.resume();
				response.on('end', () => resolve(response.statusCode));
			});
			req.on('error', reject);
			req.end();
		});
	}

	test('rejects callback state, path, host and duplicate parameters without consuming sign-in', async () => {
		const listener = store.add(new CloudCodeLoopback('expected-state', CancellationToken.None));
		await listener.listen();
		const statuses = [];
		for (const path of [
			'/cloudcode/callback?state=wrong-state&code=test-code',
			'/elsewhere?state=expected-state&code=test-code',
			'/cloudcode/callback?state=expected-state&state=expected-state&code=test-code',
			'/cloudcode/callback?state=expected-state&code=first&code=second',
		]) {
			statuses.push(await callback(path));
		}
		statuses.push(await callback('/cloudcode/callback?state=expected-state&code=test-code', 'malicious.example'));
		statuses.push(await callback('/cloudcode/callback?state=expected-state&code=test-code'));
		assert.deepStrictEqual({ statuses, code: await listener.waitForCode() }, { statuses: [400, 400, 400, 400, 400, 200], code: 'test-code' });
	});

	test('reports declined authorization only after matching state', async () => {
		const listener = store.add(new CloudCodeLoopback('expected-state', CancellationToken.None));
		await listener.listen();
		const rejected = assert.rejects(listener.waitForCode(), /declined/);
		assert.strictEqual(await callback('/cloudcode/callback?state=expected-state&error=access_denied'), 200);
		await rejected;
	});

	test('reports a busy callback port instead of leaving sign-in pending', async () => {
		const first = store.add(new CloudCodeLoopback('first', CancellationToken.None));
		const second = store.add(new CloudCodeLoopback('second', CancellationToken.None));
		await first.listen();
		await assert.rejects(second.listen(), /43827/);
		await assert.rejects(second.waitForCode(), /43827/);
	});

	test('cancellation closes an active callback listener and rejects the pending code', async () => {
		const cancellation = store.add(new CancellationTokenSource());
		const listener = store.add(new CloudCodeLoopback('expected-state', cancellation.token));
		await listener.listen();
		cancellation.cancel();
		await assert.rejects(listener.waitForCode(), isCancellationError);
		await assert.rejects(callback('/cloudcode/callback?state=expected-state&code=test-code'));
	});

	test('cancellation while acquiring the callback port settles listen', async () => {
		const cancellation = store.add(new CancellationTokenSource());
		const listener = store.add(new CloudCodeLoopback('expected-state', cancellation.token));
		const listening = listener.listen();
		cancellation.cancel();
		await assert.rejects(listening, isCancellationError);
		await assert.rejects(listener.waitForCode(), isCancellationError);
	});

	test('already cancelled sign-in never opens the callback port', async () => {
		const listener = store.add(new CloudCodeLoopback('expected-state', CancellationToken.Cancelled));
		await assert.rejects(listener.listen(), isCancellationError);
		await assert.rejects(listener.waitForCode(), isCancellationError);
	});

	test('decodes UTF-8, CRLF and multiline JSON split at every byte', () => {
		const output: string[] = [];
		const stream = new CloudCodeEventStream(text => output.push(text));
		const bytes = new TextEncoder().encode(': keepalive\r\ndata: {"choices":[\r\ndata: {"delta":{"content":"Привет 👋"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"!"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
		for (const byte of bytes) {
			stream.accept(Uint8Array.of(byte));
		}
		stream.finish();
		assert.deepStrictEqual(output, ['Привет 👋', '!']);
	});

	test('preserves partial output while reporting a truncated response', () => {
		const output: string[] = [];
		const stream = new CloudCodeEventStream(text => output.push(text));
		stream.accept(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
		assert.throws(() => stream.finish(), /interrupted/);
		assert.deepStrictEqual(output, ['partial']);
	});

	test('rejects malformed JSON and both forms of in-band error', () => {
		for (const body of ['data: invalid\n\n', 'data: {"error":{"message":"private upstream details"}}\n\n', 'event: error\ndata: private upstream details\n\n']) {
			const stream = new CloudCodeEventStream(() => assert.fail('Errors must not become assistant text'));
			assert.throws(() => stream.accept(new TextEncoder().encode(body)), error => error instanceof Error && !error.message.includes('private upstream details'));
		}
	});

	test('limits unfinished events and accumulated assistant output', () => {
		const encoder = new TextEncoder();
		assert.throws(() => new CloudCodeEventStream(() => { }).accept(encoder.encode(`data: ${'x'.repeat(1024 * 1024)}`)), /limit/);
		assert.throws(() => new CloudCodeEventStream(() => { }).accept(encoder.encode(`data: ${JSON.stringify({ metadata: 'x'.repeat(1024 * 1024) })}\n\n`)), /limit/);
		const stream = new CloudCodeEventStream(() => { });
		const delta = encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(128 * 1024) } }] })}\n\n`);
		stream.accept(delta);
		stream.accept(delta);
		assert.throws(() => stream.accept(delta), /limit/);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLOUDCODE_REDIRECT_URI, CloudCodeAgentEventStream, CloudCodeEventStream, CloudCodeLoopback, cloudCodeOrigin, createCloudCodeAgentPayload, createCloudCodeAuthorization, parseCloudCodeAuthConfiguration } from '../../node/cloudCodeProtocol.js';
import { ICloudCodeAgentMessage, ICloudCodeToolDefinition } from '../../common/cloudCode.js';

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

	const tools: readonly ICloudCodeToolDefinition[] = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }];
	const user: ICloudCodeAgentMessage = { role: 'user', content: 'Read the project' };
	const call = { id: 'call_1', name: 'read', arguments: '{"path":"README.md"}' };

	function agentEvent(delta: object, finishReason: string | null = null): string {
		return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
	}

	test('collects fragmented UTF-8 tool names, IDs, arguments and the finish reason', () => {
		const stream = new CloudCodeAgentEventStream();
		const body = agentEvent({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_', type: 'function', function: { name: 're', arguments: '{"path":' } }] })
			+ agentEvent({ tool_calls: [{ index: 0, id: '1', function: { name: 'ad', arguments: '"Привет.md"}' } }] })
			+ agentEvent({}, 'tool_calls') + 'data: {"choices":[],"usage":{"total_tokens":10}}\n\ndata: [DONE]\n\n';
		for (const byte of new TextEncoder().encode(body)) { stream.accept(Uint8Array.of(byte)); }
		assert.deepStrictEqual(stream.finish(), { cancelled: false, text: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"Привет.md"}' }], finishReason: 'tool_calls' });
	});

	test('returns ordinary text and suppresses truncated control data', () => {
		const text = new CloudCodeAgentEventStream();
		text.accept(new TextEncoder().encode(agentEvent({ content: 'Done' }) + agentEvent({}, 'stop') + 'data: [DONE]\n\n'));
		const truncated = new CloudCodeAgentEventStream();
		truncated.accept(new TextEncoder().encode(agentEvent({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, 'length') + 'data: [DONE]\n\n'));
		assert.deepStrictEqual([text.finish(), truncated.finish()], [
			{ cancelled: false, text: 'Done', toolCalls: [], finishReason: 'stop' },
			{ cancelled: false, text: '', toolCalls: [], finishReason: 'length' }
		]);
	});

	test('replays DeepSeek reasoning and ordered signed OpenRouter blocks unchanged across a tool result', () => {
		const details = [
			{ type: 'reasoning.text', text: 'private prefix', index: 0, signature: null },
			{ type: 'reasoning.text', text: 'private suffix', index: 0, signature: 'signed-value' },
			{ type: 'reasoning.encrypted', data: 'encrypted-value', index: 1, id: 'r1', format: 'openai-responses-v1' }
		];
		const stream = new CloudCodeAgentEventStream();
		stream.accept(new TextEncoder().encode(agentEvent({ reasoning_content: 'private ', reasoning_details: [details[0]] })
			+ agentEvent({ reasoning_content: 'continuation', reasoning_details: details.slice(1) })
			+ agentEvent({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] }, 'tool_calls') + 'data: [DONE]\n\n'));
		const response = stream.finish();
		const payload = createCloudCodeAgentPayload('model', [user,
			{ role: 'assistant', content: response.text, toolCalls: response.toolCalls, reasoningContent: response.reasoningContent, reasoningDetails: response.reasoningDetails },
			{ role: 'tool', content: '{}', toolCallId: call.id }
		], tools);
		assert.deepStrictEqual({ text: response.text, reasoning: payload.messages[1].reasoning_content, details: payload.messages[1].reasoning_details }, {
			text: '', reasoning: 'private continuation', details
		});
	});

	test('supports the OpenRouter reasoning alias and omits truncated reasoning from executable responses', () => {
		const complete = new CloudCodeAgentEventStream();
		complete.accept(new TextEncoder().encode(agentEvent({ reasoning: 'opaque continuation', content: 'Done' }, 'stop') + 'data: [DONE]\n\n'));
		const truncated = new CloudCodeAgentEventStream();
		truncated.accept(new TextEncoder().encode(agentEvent({ reasoning_content: 'partial', reasoning_details: [{ data: 'partial' }] }, 'length') + 'data: [DONE]\n\n'));
		assert.deepStrictEqual([complete.finish(), truncated.finish()], [
			{ cancelled: false, text: 'Done', toolCalls: [], finishReason: 'stop', reasoningContent: 'opaque continuation' },
			{ cancelled: false, text: '', toolCalls: [], finishReason: 'length' }
		]);
	});

	test('rejects misplaced, malformed and oversized hidden reasoning without leaking it in errors', () => {
		for (const message of [
			{ ...user, reasoningContent: 'private-data' },
			{ ...user, reasoningDetails: [{ data: 'private-data' }] },
			{ role: 'assistant', content: '', reasoningContent: '界'.repeat(22000) },
			{ role: 'assistant', content: '', reasoningDetails: [{ data: '界'.repeat(22000) }] },
			{ role: 'assistant', content: '', reasoningDetails: [{ data: () => 'private-data' }] }
		] as ICloudCodeAgentMessage[]) {
			assert.throws(() => createCloudCodeAgentPayload('model', [user, message], tools), error => error instanceof Error && !error.message.includes('private-data'));
		}
		for (const delta of [{ reasoning_content: {} }, { reasoning_details: ['private-data'] }, { reasoning_content: 'x'.repeat(65000), content: 'x'.repeat(537) }]) {
			const stream = new CloudCodeAgentEventStream();
			assert.throws(() => stream.accept(new TextEncoder().encode(agentEvent(delta))), error => error instanceof Error && !error.message.includes('private-data'));
		}
	});

	test('rejects unfinished and malformed Agent control streams without forwarding their content', () => {
		const part = { index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } };
		for (const body of [
			agentEvent({ tool_calls: [part] }, 'tool_calls'),
			agentEvent({ tool_calls: [part] }) + 'data: [DONE]\n\n',
			agentEvent({ tool_calls: [{ ...part, id: '' }] }, 'tool_calls') + 'data: [DONE]\n\n',
			agentEvent({ tool_calls: [{ ...part, index: 8 }] }, 'tool_calls') + 'data: [DONE]\n\n',
			agentEvent({ tool_calls: [{ ...part, index: 1 }] }, 'tool_calls') + 'data: [DONE]\n\n',
			agentEvent({ tool_calls: [part, { ...part, index: 1 }] }, 'tool_calls') + 'data: [DONE]\n\n',
			agentEvent({ tool_calls: [{ ...part, function: { name: 'read', arguments: {} } }] }, 'tool_calls') + 'data: [DONE]\n\n',
			agentEvent({ tool_calls: [part] }, 'stop') + 'data: [DONE]\n\n',
			agentEvent({}, 'stop') + agentEvent({ tool_calls: [part] }) + 'data: [DONE]\n\n',
			'data: {"choices":"private upstream data"}\n\ndata: [DONE]\n\n',
		]) {
			const stream = new CloudCodeAgentEventStream();
			assert.throws(() => { stream.accept(new TextEncoder().encode(body)); stream.finish(); }, error => error instanceof Error && !error.message.includes('private upstream data'));
		}
	});

	test('returns complete empty arguments for bounded model correction', () => {
		const stream = new CloudCodeAgentEventStream();
		stream.accept(new TextEncoder().encode(agentEvent({ tool_calls: [{ index: 0, id: 'call_empty', type: 'function', function: { name: 'read', arguments: '' } }] }, 'tool_calls') + 'data: [DONE]\n\n'));
		assert.deepStrictEqual(stream.finish().toolCalls, [{ id: 'call_empty', name: 'read', arguments: '' }]);
	});

	test('bounds Agent output by UTF-8 bytes across multiple tool calls', () => {
		const stream = new CloudCodeAgentEventStream();
		stream.accept(new TextEncoder().encode(agentEvent({ tool_calls: [{ index: 0, id: 'a', function: { name: 'read', arguments: '界'.repeat(10000) } }] })));
		assert.throws(() => stream.accept(new TextEncoder().encode(agentEvent({ tool_calls: [{ index: 1, id: 'b', function: { name: 'read', arguments: '界'.repeat(12000) } }] }))), /limit/);
	});

	test('serializes native tool definitions, paired results and Agent output limits', () => {
		const payload = createCloudCodeAgentPayload('model', [{ role: 'system', content: 'Instructions' }, user, { role: 'assistant', content: '', toolCalls: [call] }, { role: 'tool', content: 'File contents', toolCallId: call.id }], tools);
		assert.deepStrictEqual(payload, {
			model: 'model', messages: [
				{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Read the project' },
				{ role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
				{ role: 'tool', content: 'File contents', tool_call_id: call.id },
			], tools: [{ type: 'function', function: tools[0] }], tool_choice: 'auto', parallel_tool_calls: false, stream: true, max_tokens: 4096, stream_options: { include_usage: true }
		});
		assert.strictEqual(createCloudCodeAgentPayload('model', [user], tools, 8192).max_tokens, 8192);
	});

	test('rejects orphan, duplicate, interleaved or incomplete tool messages at the IPC boundary', () => {
		const assistant: ICloudCodeAgentMessage = { role: 'assistant', content: '', toolCalls: [call] };
		const result: ICloudCodeAgentMessage = { role: 'tool', content: '{}', toolCallId: call.id };
		for (const messages of [
			[user, result], [user, assistant], [user, assistant, user, result], [user, assistant, result, result],
			[user, assistant, result, assistant, result], [user, { ...assistant, toolCalls: [{ ...call, name: 'invalid name' }] }, result],
			[user, { ...user, toolCalls: [call] }], [user, { ...user, toolCallId: call.id }],
			[user, { role: 'system', content: 'Late instructions' }], [user, { ...assistant, images: [] }],
		] as ICloudCodeAgentMessage[][]) {
			assert.throws(() => createCloudCodeAgentPayload('model', messages, tools), /Agent request/);
		}
	});

	test('allows error feedback for an unsupported historical function without advertising it as a tool', () => {
		const payload = createCloudCodeAgentPayload('model', [user, { role: 'assistant', content: '', toolCalls: [{ ...call, name: 'unknown_tool' }] }, { role: 'tool', content: '{"error":"Unsupported tool"}', toolCallId: call.id }], tools);
		assert.deepStrictEqual({ calls: payload.messages[1].tool_calls, definitions: payload.tools.map(tool => tool.function.name) }, {
			calls: [{ id: call.id, type: 'function', function: { name: 'unknown_tool', arguments: call.arguments } }], definitions: ['read']
		});
	});

	test('checks request counts, schema bounds and UTF-8 budgets without truncating payloads', () => {
		const input = Array.from({ length: 128 }, () => user);
		assert.strictEqual(createCloudCodeAgentPayload('model', input, tools).messages.length, 128);
		for (const execute of [
			() => createCloudCodeAgentPayload('model', [...input, user], tools),
			() => createCloudCodeAgentPayload('model', Array.from({ length: 4 }, () => ({ ...user, content: '界'.repeat(25000) })), tools),
			() => createCloudCodeAgentPayload('model', [{ ...user, content: 'x'.repeat(32769) }], tools),
			() => createCloudCodeAgentPayload('model', [user], [...tools, ...tools]),
			() => createCloudCodeAgentPayload('model', [user], [{ ...tools[0], parameters: { type: 'object', properties: { tooLarge: 'x'.repeat(32769) } } }]),
			() => createCloudCodeAgentPayload('model', [user], tools, 8193),
		]) { assert.throws(execute, /Agent request/); }
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLOUDCODE_MAX_CONTEXT_BYTES, CLOUDCODE_MAX_MESSAGE_LENGTH, ICloudCodeAgentMessage, ICloudCodeAgentResponse, ICloudCodeChatDelta, ICloudCodeMessage, ICloudCodeService, ICloudCodeToolDefinition } from '../../../../../platform/cloudCode/common/cloudCode.js';
import { ICloudCodeAgentDiagnostic } from '../../../../../platform/cloudCode/common/cloudCodeDiagnostics.js';
import { CloudCodeAgent, CloudCodeAgentToolCall, ICloudCodeAgentToolResult, ICloudCodeAgentWorkspaceSession } from '../../common/cloudCodeAgent.js';
import { ICloudCodeAttachment } from '../../common/cloudCodeChatContext.js';
import { ICloudCodeEditProvider, ICloudCodeEditTarget } from '../../common/cloudCodeEdits.js';

class TestService extends Disposable implements ICloudCodeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly deltas = this._register(new Emitter<ICloudCodeChatDelta>());
	readonly onDidReceiveChatDelta = this.deltas.event;
	readonly requests: { id: string; messages: readonly ICloudCodeAgentMessage[]; tools: readonly ICloudCodeToolDefinition[]; maxOutputTokens?: number }[] = [];
	readonly cancelled: string[] = [];
	responses: ICloudCodeAgentResponse[] = [];
	readonly diagnostics: ICloudCodeAgentDiagnostic[] = [];
	async reportAgentError(diagnostic: ICloudCodeAgentDiagnostic): Promise<void> { this.diagnostics.push(diagnostic); }
	onRequest: ((id: string) => Promise<ICloudCodeAgentResponse>) | undefined;
	async getState() { return { status: 'signedIn' as const }; }
	async signIn() { }
	async cancelSignIn() { }
	async signOut() { }
	async getModels() { return []; }
	async cancelChat(id: string) { this.cancelled.push(id); }
	async streamChat(): Promise<{ cancelled: boolean }> { throw new Error('Agent must use the native tool transport'); }
	async streamAgent(id: string, _model: string, messages: readonly ICloudCodeAgentMessage[], tools: readonly ICloudCodeToolDefinition[], maxOutputTokens?: number) {
		this.requests.push({ id, messages, tools, maxOutputTokens });
		return this.onRequest ? this.onRequest(id) : this.responses.shift() ?? answer('Done');
	}
}

function answer(text: string): ICloudCodeAgentResponse {
	return { cancelled: false, text, toolCalls: [], finishReason: 'stop' };
}

function tool(name: string, args: object | string, id = 'call-1'): ICloudCodeAgentResponse {
	return { cancelled: false, text: '', toolCalls: [{ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }], finishReason: 'tool_calls' };
}

function repeated(response: ICloudCodeAgentResponse): ICloudCodeAgentResponse[] {
	return [response, response, response];
}

class TestSession implements ICloudCodeAgentWorkspaceSession {
	readonly roots = [{ id: 'root-1', name: 'project' }];
	readonly calls: CloudCodeAgentToolCall[] = [];
	valid = true;
	disposed = false;
	onExecute: (call: CloudCodeAgentToolCall, token: CancellationToken) => Promise<ICloudCodeAgentToolResult> = async () => ({ text: '[]' });
	assertValid(): void {
		if (!this.valid || this.disposed) {
			throw new Error('Workspace trust or roots changed');
		}
	}
	async execute(call: CloudCodeAgentToolCall, token: CancellationToken): Promise<ICloudCodeAgentToolResult> {
		this.calls.push(call);
		return this.onExecute(call, token);
	}
	resolveReference(resource: string): { root: string; path: string } | undefined {
		const prefix = 'file:///private/project/';
		return resource.startsWith(prefix) ? { root: 'root-1', path: resource.slice(prefix.length) } : undefined;
	}
	dispose(): void { this.disposed = true; }
}

class TestEdits implements ICloudCodeEditProvider {
	readonly prepared: (readonly ICloudCodeAttachment[])[] = [];
	cleared = 0;
	onPrepare: ((attachments: readonly ICloudCodeAttachment[]) => Promise<readonly ICloudCodeEditTarget[]>) | undefined;
	async prepare(attachments: readonly ICloudCodeAttachment[]): Promise<readonly ICloudCodeEditTarget[]> {
		this.prepared.push(attachments);
		return this.onPrepare ? this.onPrepare(attachments) : attachments.map((attachment, index) => ({ token: 'private-target-' + index, attachment }));
	}
	async preview() { }
	async apply() { throw new Error('Agent must never write files'); }
	clear() { this.cleared++; }
}

suite('CloudCodeAgent', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function attachment(name = 'main.ts', content = 'original', range?: ICloudCodeAttachment['range']): ICloudCodeAttachment {
		return { id: 'private-id-' + name + (range?.startLineNumber ?? ''), resource: 'file:///private/project/' + name, label: name, content, languageId: 'typescript', range };
	}

	function setup(responses: readonly ICloudCodeAgentResponse[] = []) {
		const service = disposables.add(new TestService());
		service.responses = [...responses];
		const session = new TestSession();
		const edits = new TestEdits();
		const agent = new CloudCodeAgent(service, { createSession: () => session }, edits);
		const progress: string[] = [];
		const run = (attachments: readonly ICloudCodeAttachment[] = [], token = CancellationToken.None, prompt = 'Find and fix the bug', history: readonly ICloudCodeMessage[] = []) => agent.run(prompt, attachments, 'model-1', token, message => progress.push(message), history);
		return { service, session, edits, agent, progress, run };
	}

	function requestData(service: TestService, index: number): { snapshots: { attachment: number; content: string; path: string }[]; referencedFiles: { root: string; path: string }[]; previousConversation: ICloudCodeMessage[]; remainingCalls: number } {
		return JSON.parse(service.requests[index].messages.find(message => message.role === 'user' && message.content.startsWith('{"task":'))!.content);
	}

	test('uses native function definitions and accepts plain text without interpreting it as an action', async () => {
		const text = '{"action":"tool","tool":"shell","command":"rm file"}';
		const test = setup([answer(text)]);
		const result = await test.run();
		assert.deepStrictEqual({
			text: result.text,
			roles: test.service.requests[0].messages.map(message => message.role),
			tools: test.service.requests[0].tools.map(definition => definition.name),
			calls: test.session.calls,
			diagnostics: test.service.diagnostics
		}, { text, roles: ['system', 'user'], tools: ['list', 'findFiles', 'search', 'read', 'propose'], calls: [], diagnostics: [] });
	});

	test('recovers malformed arguments with paired fixed feedback and reports no terminal failure', async () => {
		const test = setup([
			{ ...tool('read', 'private invalid arguments', 'bad-read'), reasoningContent: 'opaque-provider-thought' },
			tool('read', { root: 'root-1', path: 'main.ts' }, 'good-read'),
			answer('The problem is in main.ts.')
		]);
		test.session.onExecute = async () => ({ text: '', attachment: attachment() });
		const result = await test.run();
		const correction = test.service.requests[1].messages.slice(-2);
		assert.deepStrictEqual({
			text: result.text,
			calls: test.session.calls.map(call => call.tool),
			feedback: correction.map(message => ({ role: message.role, id: message.toolCallId ?? message.toolCalls?.[0].id })),
			code: JSON.parse(correction[1].content).code,
			reasoning: correction[0].reasoningContent,
			feedbackLeaksArguments: correction[1].content.includes('private'),
			diagnostics: test.service.diagnostics
		}, { text: 'The problem is in main.ts.', calls: ['read'], feedback: [{ role: 'assistant', id: 'bad-read' }, { role: 'tool', id: 'bad-read' }], code: 'invalid_json', reasoning: 'opaque-provider-thought', feedbackLeaksArguments: false, diagnostics: [] });
	});

	test('invalid edit proposals can be corrected before acquiring edit capabilities', async () => {
		const source = attachment();
		const test = setup([
			tool('propose', { edits: [{ attachment: 2, replacement: 'invalid' }] }, 'bad-proposal'),
			tool('propose', { edits: [{ attachment: 1, replacement: 'fixed' }] }, 'good-proposal')
		]);
		const result = await test.run([source]);
		assert.deepStrictEqual({
			prepared: test.edits.prepared, replacement: result.edits[0].replacement,
			code: JSON.parse(test.service.requests[1].messages.at(-1)!.content).code,
			diagnostics: test.service.diagnostics
		}, { prepared: [[source]], replacement: 'fixed', code: 'invalid_result', diagnostics: [] });
	});

	test('replays opaque provider reasoning with a tool turn without exposing it in the result or progress', async () => {
		const reasoningContent = 'private provider reasoning';
		const reasoningDetails = [{ type: 'reasoning.encrypted', data: 'opaque-provider-value' }];
		const test = setup([
			{ ...tool('read', { root: 'root-1', path: 'main.ts' }, 'read-with-reasoning'), reasoningContent, reasoningDetails },
			answer('Done')
		]);
		const result = await test.run();
		const assistant = test.service.requests[1].messages.find(message => message.toolCalls?.[0].id === 'read-with-reasoning');
		assert.deepStrictEqual({
			reasoningContent: assistant?.reasoningContent,
			reasoningDetails: assistant?.reasoningDetails,
			exposed: ['private provider reasoning', 'opaque-provider-value'].some(value => JSON.stringify({ result, progress: test.progress, diagnostics: test.service.diagnostics }).includes(value))
		}, { reasoningContent, reasoningDetails, exposed: false });
	});

	test('truncated output is discarded and retried with more output room without executing partial tools', async () => {
		const test = setup([
			{ ...tool('read', { root: 'root-1', path: 'never-read.ts' }, 'truncated'), text: 'partial answer', finishReason: 'length' },
			tool('read', { root: 'root-1', path: 'main.ts' }, 'complete'),
			answer('Done')
		]);
		await test.run();
		assert.deepStrictEqual({
			calls: test.session.calls,
			limits: test.service.requests.map(request => request.maxOutputTokens),
			replayedPartial: JSON.stringify(test.service.requests[1].messages).includes('never-read.ts'),
			diagnostics: test.service.diagnostics
		}, { calls: [{ tool: 'read', root: 'root-1', path: 'main.ts', startLine: undefined, endLine: undefined }], limits: [4096, 8192, 8192], replayedPartial: false, diagnostics: [] });
	});

	test('repeated truncation stops after the recovery budget and reports once', async () => {
		const test = setup(repeated({ ...answer('partial'), finishReason: 'length' }));
		await assert.rejects(test.run(), /response limit/);
		assert.deepStrictEqual({
			requests: test.service.requests.length, calls: test.session.calls,
			diagnostics: test.service.diagnostics.map(({ code, turn }) => ({ code, turn }))
		}, { requests: 3, calls: [], diagnostics: [{ code: 'response_truncated', turn: 3 }] });
	});

	test('rejects multiple calls atomically and gives every call a matching result', async () => {
		const first = tool('list', { root: 'root-1', path: '' }, 'list-1');
		const second = tool('read', { root: 'root-1', path: 'main.ts' }, 'read-2');
		const test = setup([{ ...first, toolCalls: [...first.toolCalls, ...second.toolCalls] }, answer('Done')]);
		await test.run();
		assert.deepStrictEqual({
			calls: test.session.calls,
			feedback: test.service.requests[1].messages.filter(message => message.role === 'tool').map(message => ({ id: message.toolCallId, code: JSON.parse(message.content).code })),
			diagnostics: test.service.diagnostics
		}, { calls: [], feedback: [{ id: 'list-1', code: 'invalid_envelope' }, { id: 'read-2', code: 'invalid_envelope' }], diagnostics: [] });
	});

	test('recovers empty output and unsupported finish reasons without executing their calls', async () => {
		for (const response of [answer('  '), { ...answer('Looks finished'), finishReason: undefined }, { ...tool('list', { root: 'root-1', path: '' }), finishReason: 'unknown' }]) {
			const test = setup([response, answer('Recovered')]);
			const result = await test.run();
			assert.deepStrictEqual({ text: result.text, requests: test.service.requests.length, calls: test.session.calls, diagnostics: test.service.diagnostics }, { text: 'Recovered', requests: 2, calls: [], diagnostics: [] });
		}
	});

	test('does not retry a failed transport request', async () => {
		const test = setup();
		test.service.onRequest = async () => { throw new Error('Gateway unavailable'); };
		await assert.rejects(test.run(), /Gateway unavailable/);
		assert.deepStrictEqual({
			requests: test.service.requests.length,
			diagnostics: test.service.diagnostics.map(({ code, stage, turn }) => ({ code, stage, turn }))
		}, { requests: 1, diagnostics: [{ code: 'operation_failed', stage: 'inference', turn: 1 }] });
	});

	test('does not retry or execute output blocked by provider content filtering', async () => {
		const test = setup([{ ...tool('list', { root: 'root-1', path: '' }), finishReason: 'content_filter' }]);
		await assert.rejects(test.run(), /declined/);
		assert.deepStrictEqual({ requests: test.service.requests.length, calls: test.session.calls }, { requests: 1, calls: [] });
	});

	test('a cancelled native response is not retried or reported as a failure', async () => {
		const test = setup([{ ...answer(''), cancelled: true }]);
		await assert.rejects(test.run(), isCancellationError);
		assert.deepStrictEqual({ requests: test.service.requests.length, diagnostics: test.service.diagnostics }, { requests: 1, diagnostics: [] });
	});

	test('recoveries share the twelve-call budget with successful tool operations', async () => {
		const test = setup([
			...Array.from({ length: 11 }, (_, index) => tool('list', { root: 'root-1', path: '' }, `list-${index}`)),
			tool('read', '{')
		]);
		await assert.rejects(test.run(), /unsupported Agent action/);
		assert.deepStrictEqual({
			requests: test.service.requests.length, calls: test.session.calls.length,
			diagnostics: test.service.diagnostics.map(({ code, turn }) => ({ code, turn }))
		}, { requests: 12, calls: 11, diagnostics: [{ code: 'invalid_json', turn: 12 }] });
	});

	test('keeps recent complete conversation pairs without replaying historical images', async () => {
		const history: ICloudCodeMessage[] = Array.from({ length: 6 }, (_, index) => [
			{ role: 'user' as const, content: `task-${index}`, images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] },
			{ role: 'assistant' as const, content: `answer-${index}` }
		]).flat();
		const test = setup();
		await test.run([attachment('current.ts', 'fresh contents')], CancellationToken.None, 'Follow-up', history);
		assert.deepStrictEqual({
			history: requestData(test.service, 0).previousConversation,
			roles: test.service.requests[0].messages.map(message => message.role),
			snapshots: requestData(test.service, 0).snapshots.map(({ path, content }) => ({ path, content }))
		}, {
			history: history.slice(4).map(({ role, content }) => ({ role, content })),
			roles: ['system', 'user'],
			snapshots: [{ path: 'current.ts', content: 'fresh contents' }]
		});
	});

	test('history byte limits discard whole older pairs and retain the current task', async () => {
		const test = setup();
		const history: ICloudCodeMessage[] = [
			{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'é'.repeat(8192) },
			{ role: 'user', content: 'recent question' }, { role: 'assistant', content: 'recent answer' }
		];
		await test.run([], CancellationToken.None, 'Continue', history);
		assert.deepStrictEqual(requestData(test.service, 0).previousConversation, history.slice(2));
	});

	test('prunes complete older conversation pairs when current snapshots need the message budget', async () => {
		const test = setup();
		const history: ICloudCodeMessage[] = [
			{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'x'.repeat(8 * 1024) },
			{ role: 'user', content: 'recent question' }, { role: 'assistant', content: 'recent answer' }
		];
		await test.run([attachment('first.ts', 'a'.repeat(16 * 1024)), attachment('second.ts', 'b'.repeat(8 * 1024))], CancellationToken.None, 'Continue', history);
		const data = requestData(test.service, 0);
		assert.deepStrictEqual({ history: data.previousConversation, snapshots: data.snapshots.map(snapshot => snapshot.content.length) }, { history: history.slice(2), snapshots: [16 * 1024, 8 * 1024] });
	});

	test('historical source text does not grant edit targets in a new task', async () => {
		const test = setup(repeated(tool('propose', { edits: [{ attachment: 1, replacement: 'changed' }] })));
		await assert.rejects(test.run([], CancellationToken.None, 'Change it again', [
			{ role: 'user', content: 'Attached source: old main.ts contents' },
			{ role: 'assistant', content: 'Proposed an edit to attachment 1.' }
		]), /valid proposed changes/);
		assert.deepStrictEqual({ snapshots: requestData(test.service, 0).snapshots, prepared: test.edits.prepared }, { snapshots: [], prepared: [] });
	});

	test('reports a handled model failure without sending prompt, source or response', async () => {
		const test = setup();
		test.service.responses = repeated({ ...tool('read', 'private model output'), reasoningContent: 'private reasoning', reasoningDetails: [{ type: 'reasoning.encrypted', data: 'opaque-provider-value' }] });
		await assert.rejects(test.run([attachment('private.ts', 'private source')], CancellationToken.None, 'private prompt'), /unsupported Agent action/);
		assert.deepStrictEqual(test.service.diagnostics, [{
			code: 'invalid_json', stage: 'parse', model: 'model-1', turn: 3, rootCount: 1,
			responseLength: 20, requestId: test.service.requests[2].id
		}]);
	});

	test('distinguishes an unavailable root and unsupported tool', async () => {
		for (const [response, code] of [
			[tool('read', { root: 'missing', path: 'private.ts' }), 'invalid_root'],
			[tool('shell', { root: 'root-1', path: '' }), 'invalid_tool']
		] as const) {
			const test = setup(repeated(response));
			await assert.rejects(test.run());
			assert.strictEqual(test.service.diagnostics[0].code, code);
		}
	});

	test('does not report a user cancellation or a successful answer', async () => {
		const test = setup();
		await test.run();
		const source = disposables.add(new CancellationTokenSource());
		source.cancel();
		await assert.rejects(test.run([], source.token), isCancellationError);
		assert.deepStrictEqual(test.service.diagnostics, []);
	});

	test('a reporting failure cannot replace the original error', async () => {
		const test = setup();
		test.service.responses = repeated(tool('read', 'not JSON'));
		test.service.reportAgentError = async () => { throw new Error('Reporter unavailable'); };
		await assert.rejects(test.run(), /unsupported Agent action/);
	});

	test('resolves large file references and replaces them with bounded source after a read', async () => {
		const reference: ICloudCodeAttachment = { ...attachment('package-lock.json', ''), reference: true };
		const excerpt = attachment('package-lock.json', '"lockfileVersion": 3', { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 21 });
		const test = setup([
			tool('read', { root: 'root-1', path: 'package-lock.json', startLine: 1, endLine: 50 }),
			answer('This lockfile uses version 3.')
		]);
		test.session.onExecute = async () => ({ text: '', attachment: excerpt });
		const result = await test.run([reference]);
		assert.deepStrictEqual({
			initialReferences: requestData(test.service, 0).referencedFiles,
			initialSnapshots: requestData(test.service, 0).snapshots,
			remainingReferences: requestData(test.service, 1).referencedFiles,
			readContents: requestData(test.service, 1).snapshots.map(item => item.content),
			attachments: result.attachments,
			leaksLocalPaths: test.service.requests.some(request => JSON.stringify(request.messages).includes('file:///private'))
		}, {
			initialReferences: [{ root: 'root-1', path: 'package-lock.json' }], initialSnapshots: [], remainingReferences: [],
			readContents: [excerpt.content], attachments: [excerpt], leaksLocalPaths: false
		});
	});

	test('unread references cannot be used as empty edit targets', async () => {
		const test = setup(repeated(tool('propose', { edits: [{ attachment: 1, replacement: 'overwrite file' }] })));
		await assert.rejects(test.run([{ ...attachment('package-lock.json', ''), reference: true }]), /valid proposed changes/);
		assert.deepStrictEqual(test.edits.prepared, []);
	});

	test('references outside the current workspace stop before inference', async () => {
		const test = setup();
		await assert.rejects(test.run([{ ...attachment('lock.json', ''), reference: true, resource: 'file:///another-project/lock.json' }]), /outside this project/);
		assert.deepStrictEqual(test.service.requests, []);
	});

	test('progressively discovers and reads code before answering without writing', async () => {
		const current = attachment();
		const test = setup([
			tool('list', { root: 'root-1', path: '' }),
			tool('findFiles', { root: 'root-1', query: '.ts' }),
			tool('search', { root: 'root-1', query: 'redirect' }),
			tool('read', { root: 'root-1', path: 'main.ts' }),
			answer('The redirect is in main.ts.')
		]);
		test.session.onExecute = async call => call.tool === 'read' ? { text: 'Do not duplicate this source', attachment: current } : { text: 'main.ts' };
		const result = await test.run();
		assert.deepStrictEqual({
			result, tools: test.session.calls.map(call => call.tool),
			prepared: test.edits.prepared.length, disposed: test.session.disposed,
			lastSnapshot: requestData(test.service, 4).snapshots[0].content,
			leaksLocalData: test.service.requests.some(request => /private-id|file:\/\/\/private|Do not duplicate/.test(JSON.stringify(request.messages))),
			progress: test.progress.filter(message => !message.startsWith('Thinking'))
		}, {
			result: { text: 'The redirect is in main.ts.', attachments: [current], edits: [] },
			tools: ['list', 'findFiles', 'search', 'read'], prepared: 0, disposed: true,
			lastSnapshot: 'original', leaksLocalData: false,
			progress: ['Listing root-1…', 'Finding files: .ts…', 'Searching code: redirect…', 'Reading main.ts…']
		});
	});

	test('rereading a file replaces its snapshot at the same ordinal even when the range changes', async () => {
		const first = attachment('main.ts', 'old snapshot');
		const second = attachment('main.ts', 'new snapshot', { startLineNumber: 5, startColumn: 1, endLineNumber: 8, endColumn: 1 });
		const test = setup([
			tool('read', { root: 'root-1', path: 'main.ts', startLine: 5, endLine: 8 }),
			answer('Done')
		]);
		test.session.onExecute = async () => ({ text: 'old snapshot', attachment: second });
		const result = await test.run([first, attachment('other.ts')]);
		assert.deepStrictEqual({
			content: result.attachments.map(item => item.content),
			ordinals: requestData(test.service, 1).snapshots.map(item => item.attachment),
			containsStaleRead: JSON.stringify(test.service.requests[1].messages).includes('old snapshot')
		}, { content: ['new snapshot', 'original'], ordinals: [1, 2], containsStaleRead: false });
	});

	test('prepares only referenced snapshots and binds proposals to fresh local capabilities', async () => {
		const current = attachment('second.ts');
		const test = setup([tool('propose', { edits: [{ attachment: 2, replacement: 'changed' }] })]);
		const result = await test.run([attachment('first.ts'), current]);
		assert.deepStrictEqual({
			prepared: test.edits.prepared, cleared: test.edits.cleared,
			edits: result.edits, sessionDisposed: test.session.disposed
		}, {
			prepared: [[current]], cleared: 0,
			edits: [{ target: { token: 'private-target-0', attachment: current }, replacement: 'changed' }], sessionDisposed: true
		});
	});

	test('search results cannot become edit targets without a read', async () => {
		const test = setup([
			tool('search', { root: 'root-1', query: 'redirect' }),
			...repeated(tool('propose', { edits: [{ attachment: 1, replacement: 'changed' }] }))
		]);
		test.session.onExecute = async () => ({ text: 'main.ts:1: original' });
		await assert.rejects(test.run(), /valid proposed changes/);
		assert.deepStrictEqual({ prepared: test.edits.prepared, disposed: test.session.disposed }, { prepared: [], disposed: true });
	});

	test('validates every control field before invoking tools', async () => {
		const responses = [
			tool('shell', { root: 'root-1', query: 'rm file' }),
			tool('read', { root: 'unknown', path: 'main.ts' }),
			tool('read', { root: 'root-1', path: '../main.ts' }),
			tool('read', { root: 'root-1', path: 'file:///main.ts' }),
			tool('read', { root: 'root-1', path: '/main.ts' }),
			tool('read', { root: 'root-1', path: 'a\\b.ts' }),
			tool('read', { root: 'root-1', path: 'a.ts', startLine: 0, endLine: 2 }),
			tool('read', { root: 'root-1', path: 'a.ts', startLine: 2 }),
			tool('read', { root: 'root-1', path: 'a.ts', endLine: 2 }),
			tool('read', { root: 'root-1', path: 'a.ts', startLine: 4, endLine: 2 }),
			tool('list', { root: 'root-1', path: '', command: 'pwd' }),
			tool('search', { root: 'root-1', query: '' }),
			tool('findFiles', { root: 'root-1', query: 'a'.repeat(201) }),
			tool('search', { root: 'root-1', query: 'a\0b' })
		];
		for (const response of responses) {
			const test = setup(repeated(response));
			await assert.rejects(test.run(), /unsupported Agent action/);
			assert.deepStrictEqual({ tools: test.session.calls, prepared: test.edits.prepared }, { tools: [], prepared: [] });
		}
	});

	test('rejects malformed function arguments and extra control or proposal fields', async () => {
		for (const args of ['null', '[]', '{', '```json\n{"edits":[]}\n```', '{"action":"answer","text":"ok"}', '{"tool":"shell","edits":[]}', '{"edits":[],"text":"ok"}']) {
			const test = setup(repeated(tool('propose', args)));
			await assert.rejects(test.run(), /unsupported Agent action/);
			assert.strictEqual(test.session.calls.length, 0);
		}
	});

	test('rejects an invalid edit anywhere in the batch before preparing resources', async () => {
		for (const edits of [
			[{ attachment: 1, replacement: 'valid' }, { attachment: 2, replacement: 'outside' }],
			[{ attachment: 1, replacement: 'valid' }, { attachment: 1, replacement: 'duplicate' }],
			[{ attachment: 1, replacement: 'changed', path: '../../outside' }],
			[{ attachment: 1, replacement: 'x'.repeat(32 * 1024 + 1) }]
		]) {
			const test = setup(repeated(tool('propose', { edits })));
			await assert.rejects(test.run([attachment()]));
			assert.strictEqual(test.edits.prepared.length, 0);
		}
	});

	test('failed and oversized reads preserve snapshots and sanitize provider errors', async () => {
		const test = setup([
			tool('read', { root: 'root-1', path: 'missing.ts' }),
			tool('read', { root: 'root-1', path: 'large.ts' }),
			answer('Only original context was available.')
		]);
		test.session.onExecute = async call => {
			if (call.tool === 'read' && call.path === 'missing.ts') {
				throw new Error('secret credentials in /private/outside');
			}
			return { text: 'oversized', attachment: attachment('large.ts', 'x'.repeat(16 * 1024 + 1)) };
		};
		const original = attachment();
		const result = await test.run([original]);
		assert.deepStrictEqual({
			attachments: result.attachments,
			leaksError: test.service.requests.some(request => JSON.stringify(request.messages).includes('secret credentials')),
			failures: test.service.requests[2].messages.filter(message => message.role === 'tool' && JSON.parse(message.content).ok === false).length
		}, { attachments: [original], leaksError: false, failures: 2 });
	});

	test('caps active snapshots at five and preserves the accepted set after a sixth read', async () => {
		const initial = Array.from({ length: 5 }, (_, index) => attachment(index + '.ts'));
		const test = setup([
			tool('read', { root: 'root-1', path: 'sixth.ts' }),
			answer('Done')
		]);
		test.session.onExecute = async () => ({ text: '', attachment: attachment('sixth.ts') });
		const result = await test.run(initial);
		assert.deepStrictEqual(result.attachments, initial);
	});

	test('enforces native context and snapshot byte limits before calling inference', async () => {
		for (const [prompt, attachments] of [
			['x'.repeat(CLOUDCODE_MAX_MESSAGE_LENGTH), []],
			['question', [attachment('a.ts', '\u00e9'.repeat(8193))]],
			['question', [attachment('a.ts', 'x'.repeat(16 * 1024)), attachment('b.ts', 'x'.repeat(9 * 1024))]],
			['question', [attachment('a.ts', '\t'.repeat(16 * 1024))]]
		] as const) {
			const test = setup();
			await assert.rejects(test.run(attachments, CancellationToken.None, prompt));
			assert.strictEqual(test.service.requests.length, 0);
		}
	});

	test('prunes old bounded tool logs while every request remains inside transport limits', async () => {
		const test = setup([
			...Array.from({ length: 10 }, (_, index) => tool('search', { root: 'root-1', query: 'value' }, `search-${index}`)),
			answer('Done')
		]);
		test.session.onExecute = async () => ({ text: 'é\\"'.repeat(2000) });
		await test.run([attachment('a.ts', 'x'.repeat(16 * 1024))]);
		assert.deepStrictEqual({
			allWithinLimit: test.service.requests.every(request => request.messages.every(message => message.content.length <= CLOUDCODE_MAX_MESSAGE_LENGTH) && new TextEncoder().encode(JSON.stringify(request.messages)).byteLength <= CLOUDCODE_MAX_CONTEXT_BYTES),
			pruned: test.service.requests[10].messages.filter(message => message.role === 'tool').length < 10,
			completePairs: test.service.requests.every(request => request.messages.every((message, index) => !message.toolCalls || (request.messages[index + 1]?.role === 'tool' && request.messages[index + 1]?.toolCallId === message.toolCalls[0].id))),
			remainingCalls: requestData(test.service, 10).remainingCalls
		}, { allWithinLimit: true, pruned: true, completePairs: true, remainingCalls: 2 });
	});

	test('stops after twelve model calls even when the model keeps requesting tools', async () => {
		const test = setup(Array.from({ length: 13 }, (_, index) => tool('list', { root: 'root-1', path: '' }, `list-${index}`)));
		await assert.rejects(test.run(), /12-call limit/);
		assert.deepStrictEqual({ requests: test.service.requests.length, calls: test.session.calls.length, disposed: test.session.disposed }, { requests: 12, calls: 12, disposed: true });
	});

	test('response byte overflow cancels transport once and never executes its partial action', async () => {
		const test = setup([{ ...tool('list', { root: 'root-1', path: '' }), text: '\u00e9'.repeat(32769) }]);
		await assert.rejects(test.run(), /size limit/);
		assert.deepStrictEqual({ cancelled: test.service.cancelled.length, tools: test.session.calls.length, disposed: test.session.disposed }, { cancelled: 1, tools: 0, disposed: true });
	});

	test('Stop settles while native inference hangs and ignores a late tool response', async () => {
		const test = setup();
		const cancellation = disposables.add(new CancellationTokenSource());
		const response = new DeferredPromise<ICloudCodeAgentResponse>();
		test.service.onRequest = () => response.p;
		const running = test.run([], cancellation.token);
		cancellation.cancel();
		await assert.rejects(running, isCancellationError);
		await response.complete(tool('list', { root: 'root-1', path: '' }));
		assert.deepStrictEqual({ cancelled: test.service.cancelled.length, requests: test.service.requests.length, tools: test.session.calls.length, disposed: test.session.disposed, diagnostics: test.service.diagnostics }, { cancelled: 1, requests: 1, tools: 0, disposed: true, diagnostics: [] });
	});

	test('Stop interrupts a pending tool and prevents another model call after its late result', async () => {
		const test = setup([tool('read', { root: 'root-1', path: 'main.ts' })]);
		const cancellation = disposables.add(new CancellationTokenSource());
		const started = new DeferredPromise<void>();
		const result = new DeferredPromise<ICloudCodeAgentToolResult>();
		let toolToken = CancellationToken.None;
		test.session.onExecute = async (_call, token) => {
			toolToken = token;
			await started.complete();
			return result.p;
		};
		const running = test.run([], cancellation.token);
		await started.p;
		cancellation.cancel();
		await assert.rejects(running, isCancellationError);
		await result.complete({ text: '', attachment: attachment() });
		assert.deepStrictEqual({ cancelled: toolToken.isCancellationRequested, requests: test.service.requests.length, disposed: test.session.disposed }, { cancelled: true, requests: 1, disposed: true });
	});

	test('trust and workspace invalidation stop before initial inference and after tools', async () => {
		const initial = setup();
		initial.session.valid = false;
		await assert.rejects(initial.run([attachment()]), /trust or roots changed/);
		const later = setup([tool('read', { root: 'root-1', path: 'main.ts' })]);
		later.session.onExecute = async () => {
			later.session.valid = false;
			return { text: '', attachment: attachment() };
		};
		await assert.rejects(later.run(), /trust or roots changed/);
		assert.deepStrictEqual([initial.service.requests.length, later.service.requests.length], [0, 1]);
	});

	test('trust invalidation during inference prevents the returned tool action', async () => {
		const test = setup();
		test.service.onRequest = async () => {
			test.session.valid = false;
			return tool('list', { root: 'root-1', path: '' });
		};
		await assert.rejects(test.run(), /trust or roots changed/);
		assert.strictEqual(test.session.calls.length, 0);
	});

	test('changed-source prepare failures clear retained edit capabilities', async () => {
		const test = setup([tool('propose', { edits: [{ attachment: 1, replacement: 'changed' }] })]);
		test.edits.onPrepare = async () => { throw new Error('Source changed after reading'); };
		await assert.rejects(test.run([attachment()]), /Source changed/);
		assert.deepStrictEqual({ cleared: test.edits.cleared, disposed: test.session.disposed }, { cleared: 1, disposed: true });
	});

	test('Stop during target preparation clears the pending capability generation', async () => {
		const test = setup([tool('propose', { edits: [{ attachment: 1, replacement: 'changed' }] })]);
		const cancellation = disposables.add(new CancellationTokenSource());
		const started = new DeferredPromise<void>();
		const result = new DeferredPromise<readonly ICloudCodeEditTarget[]>();
		test.edits.onPrepare = async () => {
			await started.complete();
			return result.p;
		};
		const running = test.run([attachment()], cancellation.token);
		await started.p;
		cancellation.cancel();
		await assert.rejects(running, isCancellationError);
		await result.complete([]);
		assert.deepStrictEqual({ cleared: test.edits.cleared, disposed: test.session.disposed }, { cleared: 1, disposed: true });
	});

	test('the three-minute deadline cancels a stuck request and disposes its timer', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const test = setup();
			test.service.onRequest = () => new Promise(() => { });
			const running = assert.rejects(test.run(), /three-minute limit/);
			await clock.tickAsync(3 * 60 * 1000);
			await running;
			assert.deepStrictEqual({ cancelled: test.service.cancelled.length, timers: clock.countTimers(), disposed: test.session.disposed, code: test.service.diagnostics[0]?.code }, { cancelled: 1, timers: 0, disposed: true, code: 'timeout' });
		} finally {
			clock.restore();
		}
	});

	test('successful completion clears its deadline timer', async () => {
		const clock = sinon.useFakeTimers();
		try {
			await setup().run();
			assert.strictEqual(clock.countTimers(), 0);
		} finally {
			clock.restore();
		}
	});

	test('foreign deltas are ignored and concurrent runs are rejected', async () => {
		const test = setup();
		const response = new DeferredPromise<ICloudCodeAgentResponse>();
		test.service.onRequest = async id => {
			test.service.deltas.fire({ requestId: 'foreign-request', text: 'not JSON' });
			test.service.deltas.fire({ requestId: id, text: '{"action":"answer","text":"Done"}' });
			return response.p;
		};
		const first = test.run();
		await assert.rejects(test.run(), /current Agent task/);
		await response.complete(answer('Done'));
		assert.deepStrictEqual({ text: (await first).text, requests: test.service.requests.length }, { text: 'Done', requests: 1 });
	});
});

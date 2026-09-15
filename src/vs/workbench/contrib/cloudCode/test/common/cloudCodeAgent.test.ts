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
import { CLOUDCODE_MAX_CONTEXT_BYTES, CLOUDCODE_MAX_MESSAGE_LENGTH, ICloudCodeChatDelta, ICloudCodeMessage, ICloudCodeService } from '../../../../../platform/cloudCode/common/cloudCode.js';
import { CloudCodeAgent, CloudCodeAgentToolCall, ICloudCodeAgentToolResult, ICloudCodeAgentWorkspaceSession } from '../../common/cloudCodeAgent.js';
import { ICloudCodeAttachment } from '../../common/cloudCodeChatContext.js';
import { ICloudCodeEditProvider, ICloudCodeEditTarget } from '../../common/cloudCodeEdits.js';

class TestService extends Disposable implements ICloudCodeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly deltas = this._register(new Emitter<ICloudCodeChatDelta>());
	readonly onDidReceiveChatDelta = this.deltas.event;
	readonly requests: { id: string; messages: readonly ICloudCodeMessage[] }[] = [];
	readonly cancelled: string[] = [];
	responses: string[] = [];
	onRequest: ((id: string) => Promise<{ cancelled: boolean }>) | undefined;
	async getState() { return { status: 'signedIn' as const }; }
	async signIn() { }
	async cancelSignIn() { }
	async signOut() { }
	async getModels() { return []; }
	async cancelChat(id: string) { this.cancelled.push(id); }
	async streamChat(id: string, _model: string, messages: readonly ICloudCodeMessage[]) {
		this.requests.push({ id, messages });
		if (this.onRequest) {
			return this.onRequest(id);
		}
		this.deltas.fire({ requestId: id, text: this.responses.shift() ?? '{"action":"answer","text":"Done"}' });
		return { cancelled: false };
	}
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

	function setup(responses: readonly object[] = []) {
		const service = disposables.add(new TestService());
		service.responses = responses.map(value => JSON.stringify(value));
		const session = new TestSession();
		const edits = new TestEdits();
		const agent = new CloudCodeAgent(service, { createSession: () => session }, edits);
		const progress: string[] = [];
		const run = (attachments: readonly ICloudCodeAttachment[] = [], token = CancellationToken.None, prompt = 'Find and fix the bug') => agent.run(prompt, attachments, 'model-1', token, message => progress.push(message));
		return { service, session, edits, agent, progress, run };
	}

	function requestData(service: TestService, index: number): { snapshots: { attachment: number; content: string; path: string }[]; referencedFiles: { root: string; path: string }[]; toolResults: { result: string }[]; remainingCalls: number } {
		return JSON.parse(service.requests[index].messages[0].content.split('\n').at(-1)!);
	}

	test('resolves large file references and replaces them with bounded source after a read', async () => {
		const reference: ICloudCodeAttachment = { ...attachment('package-lock.json', ''), reference: true };
		const excerpt = attachment('package-lock.json', '"lockfileVersion": 3', { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 21 });
		const test = setup([
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'package-lock.json', startLine: 1, endLine: 50 },
			{ action: 'answer', text: 'This lockfile uses version 3.' }
		]);
		test.session.onExecute = async () => ({ text: '', attachment: excerpt });
		const result = await test.run([reference]);
		assert.deepStrictEqual({
			initialReferences: requestData(test.service, 0).referencedFiles,
			initialSnapshots: requestData(test.service, 0).snapshots,
			remainingReferences: requestData(test.service, 1).referencedFiles,
			readContents: requestData(test.service, 1).snapshots.map(item => item.content),
			attachments: result.attachments,
			leaksLocalPaths: test.service.requests.some(request => request.messages[0].content.includes('file:///private'))
		}, {
			initialReferences: [{ root: 'root-1', path: 'package-lock.json' }], initialSnapshots: [], remainingReferences: [],
			readContents: [excerpt.content], attachments: [excerpt], leaksLocalPaths: false
		});
	});

	test('unread references cannot be used as empty edit targets', async () => {
		const test = setup([{ action: 'propose', edits: [{ attachment: 1, replacement: 'overwrite file' }] }]);
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
			{ action: 'tool', tool: 'list', root: 'root-1', path: '' },
			{ action: 'tool', tool: 'findFiles', root: 'root-1', query: '.ts' },
			{ action: 'tool', tool: 'search', root: 'root-1', query: 'redirect' },
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'main.ts' },
			{ action: 'answer', text: 'The redirect is in main.ts.' }
		]);
		test.session.onExecute = async call => call.tool === 'read' ? { text: 'Do not duplicate this source', attachment: current } : { text: 'main.ts' };
		const result = await test.run();
		assert.deepStrictEqual({
			result, tools: test.session.calls.map(call => call.tool),
			prepared: test.edits.prepared.length, disposed: test.session.disposed,
			lastSnapshot: requestData(test.service, 4).snapshots[0].content,
			leaksLocalData: test.service.requests.some(request => /private-id|file:\/\/\/private|Do not duplicate/.test(request.messages[0].content)),
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
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'main.ts', startLine: 5, endLine: 8 },
			{ action: 'answer', text: 'Done' }
		]);
		test.session.onExecute = async () => ({ text: 'old snapshot', attachment: second });
		const result = await test.run([first, attachment('other.ts')]);
		assert.deepStrictEqual({
			content: result.attachments.map(item => item.content),
			ordinals: requestData(test.service, 1).snapshots.map(item => item.attachment),
			containsStaleRead: test.service.requests[1].messages[0].content.includes('old snapshot')
		}, { content: ['new snapshot', 'original'], ordinals: [1, 2], containsStaleRead: false });
	});

	test('prepares only referenced snapshots and binds proposals to fresh local capabilities', async () => {
		const current = attachment('second.ts');
		const test = setup([{ action: 'propose', edits: [{ attachment: 2, replacement: 'changed' }] }]);
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
			{ action: 'tool', tool: 'search', root: 'root-1', query: 'redirect' },
			{ action: 'propose', edits: [{ attachment: 1, replacement: 'changed' }] }
		]);
		test.session.onExecute = async () => ({ text: 'main.ts:1: original' });
		await assert.rejects(test.run(), /valid proposed changes/);
		assert.deepStrictEqual({ prepared: test.edits.prepared, disposed: test.session.disposed }, { prepared: [], disposed: true });
	});

	test('validates every control field before invoking tools', async () => {
		const responses = [
			{ action: 'tool', tool: 'shell', root: 'root-1', query: 'rm file' },
			{ action: 'tool', tool: 'read', root: 'unknown', path: 'main.ts' },
			{ action: 'tool', tool: 'read', root: 'root-1', path: '../main.ts' },
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'file:///main.ts' },
			{ action: 'tool', tool: 'read', root: 'root-1', path: '/main.ts' },
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'a\\b.ts' },
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'a.ts', startLine: 0, endLine: 2 },
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'a.ts', startLine: 2 },
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'a.ts', endLine: 2 },
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'a.ts', startLine: 4, endLine: 2 },
			{ action: 'tool', tool: 'list', root: 'root-1', path: '', command: 'pwd' },
			{ action: 'tool', tool: 'search', root: 'root-1', query: '' },
			{ action: 'tool', tool: 'findFiles', root: 'root-1', query: 'a'.repeat(201) },
			{ action: 'tool', tool: 'search', root: 'root-1', query: 'a\0b' }
		];
		for (const response of responses) {
			const test = setup([response]);
			await assert.rejects(test.run(), /unsupported Agent action/);
			assert.deepStrictEqual({ tools: test.session.calls, prepared: test.edits.prepared }, { tools: [], prepared: [] });
		}
	});

	test('rejects malformed model output and extra answer or proposal fields', async () => {
		for (const response of ['null', '[]', '{', '```json\n{"action":"answer","text":"ok"}\n```', '{"action":"answer","text":"ok","command":"pwd"}', '{"action":"propose","edits":[],"text":"ok"}']) {
			const test = setup();
			test.service.responses = [response];
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
			const test = setup([{ action: 'propose', edits }]);
			await assert.rejects(test.run([attachment()]));
			assert.strictEqual(test.edits.prepared.length, 0);
		}
	});

	test('failed and oversized reads preserve snapshots and sanitize provider errors', async () => {
		const test = setup([
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'missing.ts' },
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'large.ts' },
			{ action: 'answer', text: 'Only original context was available.' }
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
			leaksError: test.service.requests.some(request => request.messages[0].content.includes('secret credentials')),
			failures: requestData(test.service, 2).toolResults.length
		}, { attachments: [original], leaksError: false, failures: 2 });
	});

	test('caps active snapshots at five and preserves the accepted set after a sixth read', async () => {
		const initial = Array.from({ length: 5 }, (_, index) => attachment(index + '.ts'));
		const test = setup([
			{ action: 'tool', tool: 'read', root: 'root-1', path: 'sixth.ts' },
			{ action: 'answer', text: 'Done' }
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
			...Array.from({ length: 10 }, () => ({ action: 'tool', tool: 'search', root: 'root-1', query: 'value' })),
			{ action: 'answer', text: 'Done' }
		]);
		test.session.onExecute = async () => ({ text: 'result'.repeat(2000) });
		await test.run([attachment('a.ts', 'x'.repeat(16 * 1024))]);
		assert.deepStrictEqual({
			allWithinLimit: test.service.requests.every(request => request.messages.length === 1 && request.messages[0].content.length <= CLOUDCODE_MAX_MESSAGE_LENGTH && new TextEncoder().encode(request.messages[0].content).byteLength <= CLOUDCODE_MAX_CONTEXT_BYTES),
			pruned: requestData(test.service, 10).toolResults.length < 10,
			remainingCalls: requestData(test.service, 10).remainingCalls
		}, { allWithinLimit: true, pruned: true, remainingCalls: 2 });
	});

	test('stops after twelve model calls even when the model keeps requesting tools', async () => {
		const test = setup(Array.from({ length: 13 }, () => ({ action: 'tool', tool: 'list', root: 'root-1', path: '' })));
		await assert.rejects(test.run(), /12-call limit/);
		assert.deepStrictEqual({ requests: test.service.requests.length, calls: test.session.calls.length, disposed: test.session.disposed }, { requests: 12, calls: 12, disposed: true });
	});

	test('response byte overflow cancels transport once and never executes its partial action', async () => {
		const test = setup();
		test.service.onRequest = async id => {
			test.service.deltas.fire({ requestId: id, text: '\u00e9'.repeat(32769) });
			test.service.deltas.fire({ requestId: id, text: '{"action":"tool","tool":"list","root":"root-1","path":""}' });
			return { cancelled: false };
		};
		await assert.rejects(test.run(), /size limit/);
		assert.deepStrictEqual({ cancelled: test.service.cancelled.length, tools: test.session.calls.length, disposed: test.session.disposed }, { cancelled: 1, tools: 0, disposed: true });
	});

	test('Stop settles while native inference hangs and ignores late response deltas', async () => {
		const test = setup();
		const cancellation = disposables.add(new CancellationTokenSource());
		const response = new DeferredPromise<{ cancelled: boolean }>();
		test.service.onRequest = () => response.p;
		const running = test.run([], cancellation.token);
		cancellation.cancel();
		await assert.rejects(running, isCancellationError);
		test.service.deltas.fire({ requestId: test.service.requests[0].id, text: '{"action":"tool","tool":"list","root":"root-1","path":""}' });
		await response.complete({ cancelled: false });
		assert.deepStrictEqual({ cancelled: test.service.cancelled.length, requests: test.service.requests.length, tools: test.session.calls.length, disposed: test.session.disposed }, { cancelled: 1, requests: 1, tools: 0, disposed: true });
	});

	test('Stop interrupts a pending tool and prevents another model call after its late result', async () => {
		const test = setup([{ action: 'tool', tool: 'read', root: 'root-1', path: 'main.ts' }]);
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
		const later = setup([{ action: 'tool', tool: 'read', root: 'root-1', path: 'main.ts' }]);
		later.session.onExecute = async () => {
			later.session.valid = false;
			return { text: '', attachment: attachment() };
		};
		await assert.rejects(later.run(), /trust or roots changed/);
		assert.deepStrictEqual([initial.service.requests.length, later.service.requests.length], [0, 1]);
	});

	test('trust invalidation during inference prevents the returned tool action', async () => {
		const test = setup();
		test.service.onRequest = async id => {
			test.service.deltas.fire({ requestId: id, text: '{"action":"tool","tool":"list","root":"root-1","path":""}' });
			test.session.valid = false;
			return { cancelled: false };
		};
		await assert.rejects(test.run(), /trust or roots changed/);
		assert.strictEqual(test.session.calls.length, 0);
	});

	test('changed-source prepare failures clear retained edit capabilities', async () => {
		const test = setup([{ action: 'propose', edits: [{ attachment: 1, replacement: 'changed' }] }]);
		test.edits.onPrepare = async () => { throw new Error('Source changed after reading'); };
		await assert.rejects(test.run([attachment()]), /Source changed/);
		assert.deepStrictEqual({ cleared: test.edits.cleared, disposed: test.session.disposed }, { cleared: 1, disposed: true });
	});

	test('Stop during target preparation clears the pending capability generation', async () => {
		const test = setup([{ action: 'propose', edits: [{ attachment: 1, replacement: 'changed' }] }]);
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
			assert.deepStrictEqual({ cancelled: test.service.cancelled.length, timers: clock.countTimers(), disposed: test.session.disposed }, { cancelled: 1, timers: 0, disposed: true });
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
		const response = new DeferredPromise<{ cancelled: boolean }>();
		test.service.onRequest = async id => {
			test.service.deltas.fire({ requestId: 'foreign-request', text: 'not JSON' });
			test.service.deltas.fire({ requestId: id, text: '{"action":"answer","text":"Done"}' });
			return response.p;
		};
		const first = test.run();
		await assert.rejects(test.run(), /current Agent task/);
		await response.complete({ cancelled: false });
		assert.deepStrictEqual({ text: (await first).text, requests: test.service.requests.length }, { text: 'Done', requests: 1 });
	});
});

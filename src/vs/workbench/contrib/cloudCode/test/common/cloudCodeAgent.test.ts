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
import { CloudCodeAgentCommandResult, CloudCodeAgentExecutionError, ICloudCodeAgentCommand, ICloudCodeAgentExecutionFactory } from '../../common/cloudCodeAgentExecution.js';
import { CloudCodeAgent, CloudCodeAgentToolCall, ICloudCodeAgentToolResult, ICloudCodeAgentWorkspaceSession } from '../../common/cloudCodeAgent.js';
import { ICloudCodeAttachment } from '../../common/cloudCodeChatContext.js';
import { ICloudCodeEditProvider, ICloudCodeEditTarget } from '../../common/cloudCodeEdits.js';
import { CloudCodeEditingReadOnlyError, CloudCodeEditingSession, ICloudCodeEditingSession, ICloudCodeEditingSessionFactory, ICloudCodeEditingWorkspace, ICloudCodeSessionFile } from '../../common/cloudCodeEditingSession.js';

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

class TestEditingWorkspace implements ICloudCodeEditingWorkspace {
	constructor(readonly files = new Map<string, string>()) { }
	readonly reads: string[] = [];
	disposed = false;
	assertValid(): void { if (this.disposed) { throw new Error('Disposed workspace'); } }
	key(root: string, path: string): string { return root + '/' + path; }
	async read(root: string, path: string): Promise<ICloudCodeSessionFile> {
		this.assertValid();
		this.reads.push(path);
		const content = this.files.get(path);
		if (content && content.length > 1024 * 1024) { throw new CloudCodeEditingReadOnlyError(); }
		return { root, path, resource: 'file:///private/project/' + path, content, languageId: 'typescript' };
	}
	async preview(): Promise<void> { throw new Error('Agent must not open a review without user action'); }
	async apply(): Promise<boolean> { throw new Error('Agent must never write files'); }
	async undo(): Promise<void> { throw new Error('Agent must never write files'); }
	dispose(): void { this.disposed = true; }
}

suite('CloudCodeAgent', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function attachment(name = 'main.ts', content = 'original', range?: ICloudCodeAttachment['range']): ICloudCodeAttachment {
		return { id: 'private-id-' + name + (range?.startLineNumber ?? ''), resource: 'file:///private/project/' + name, label: name, content, languageId: 'typescript', range };
	}

	function setup(responses: readonly ICloudCodeAgentResponse[] = [], editingFactory?: ICloudCodeEditingSessionFactory, executionFactory?: ICloudCodeAgentExecutionFactory) {
		const service = disposables.add(new TestService());
		service.responses = [...responses];
		const session = new TestSession();
		const edits = new TestEdits();
		const agent = new CloudCodeAgent(service, { createSession: () => session }, edits, editingFactory, executionFactory);
		const progress: string[] = [];
		const run = (attachments: readonly ICloudCodeAttachment[] = [], token = CancellationToken.None, prompt = 'Find and fix the bug', history: readonly ICloudCodeMessage[] = []) => agent.run(prompt, attachments, 'model-1', token, message => progress.push(message), history);
		return { service, session, edits, agent, progress, run };
	}

	function setupEditing(responses: readonly ICloudCodeAgentResponse[] = [], files: Readonly<Record<string, string>> = {}) {
		const workspace = new TestEditingWorkspace();
		for (const [path, content] of Object.entries(files)) { workspace.files.set(path, content); }
		const editingSession = disposables.add(new CloudCodeEditingSession(workspace));
		return { ...setup(responses, { createSession: () => editingSession }), editingSession, editingWorkspace: workspace };
	}

	function setupExecution(responses: readonly ICloudCodeAgentResponse[] = [], initialFiles: Readonly<Record<string, string>> = {}) {
		const files = new Map(Object.entries(initialFiles));
		const sessions: CloudCodeEditingSession[] = [];
		const workspaces: TestEditingWorkspace[] = [];
		const execution = {
			disposed: false,
			calls: [] as ICloudCodeAgentCommand[],
			onRun: async (_command: ICloudCodeAgentCommand, session: ICloudCodeEditingSession, _token: CancellationToken): Promise<CloudCodeAgentCommandResult> => {
				if (session.changes.length) { await session.preview(); await session.apply(); }
				return { exitCode: 0, stdout: 'Tests passed', stderr: '', timedOut: false, cancelled: false, truncated: false };
			},
			async run(command: ICloudCodeAgentCommand, session: ICloudCodeEditingSession, token: CancellationToken) {
				this.calls.push(command);
				return this.onRun(command, session, token);
			},
			dispose() { this.disposed = true; }
		};
		const factory: ICloudCodeEditingSessionFactory = { createSession: () => {
			const workspace = new TestEditingWorkspace(files);
			const session = disposables.add(new CloudCodeEditingSession(workspace));
			workspace.preview = async () => { };
			workspace.apply = async () => {
				for (const change of session.changes) {
					files.delete(change.before.path);
					if (change.after.content !== undefined) { files.set(change.after.path, change.after.content); }
				}
				return true;
			};
			sessions.push(session);
			workspaces.push(workspace);
			return session;
		} };
		return { ...setup(responses, factory, { shell: 'sh', createSession: () => execution }), files, sessions, workspaces, execution };
	}

	function command(command = 'npm test'): ICloudCodeAgentResponse {
		return tool('run_command', { root: 'root-1', path: '', command, explanation: 'Run the relevant tests' });
	}

	function requestData(service: TestService, index: number): { snapshots: { attachment: number; content: string; path: string }[]; referencedFiles: { root: string; path: string }[]; previousConversation: ICloudCodeMessage[]; remainingCalls: number } {
		return JSON.parse(service.requests[index].messages.find(message => message.role === 'user' && message.content.startsWith('{"task":'))!.content);
	}

	test('runs the edit, failing check, fix and passing check loop with distinct applied checkpoints and final pending changes', async () => {
		const test = setupExecution([
			tool('read', { root: 'root-1', path: 'main.ts' }),
			tool('apply_patch', { root: 'root-1', path: 'main.ts', oldText: 'original', newText: 'broken' }),
			command(),
			tool('read', { root: 'root-1', path: 'main.ts' }),
			tool('apply_patch', { root: 'root-1', path: 'main.ts', oldText: 'broken', newText: 'fixed' }),
			command(),
			tool('read', { root: 'root-1', path: 'main.ts' }),
			tool('apply_patch', { root: 'root-1', path: 'main.ts', oldText: 'fixed', newText: 'final pending change' }),
			answer('The checked fix is applied; the final pending change has not been verified.')
		], { 'main.ts': 'original' });
		const execute = test.execution.onRun;
		test.execution.onRun = async (command, session, token) => {
			const result = await execute(command, session, token);
			return { ...result, exitCode: test.execution.calls.length === 1 ? 1 : 0, stdout: '', stderr: test.execution.calls.length === 1 ? 'Expected fixed, received broken' : '' };
		};
		const result = await test.run();
		assert.deepStrictEqual({
			disk: test.files.get('main.ts'), pending: result.editingSession?.changes[0].after.content,
			checkpoints: result.checkpoints?.map(session => [session.status, session.changes[0].after.content]),
			remainingCalls: requestData(test.service, 0).remainingCalls,
			commandTool: test.service.requests[0].tools.at(-1)?.name,
			postCommandSnapshots: [requestData(test.service, 3).snapshots, requestData(test.service, 6).snapshots],
			feedback: test.service.requests[6].messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content)).filter(message => 'exitCode' in message).map(message => [message.ok, message.exitCode]),
			disposed: test.workspaces.map(workspace => workspace.disposed), executorDisposed: test.execution.disposed, count: result.commandCount
		}, { disk: 'fixed', pending: 'final pending change', checkpoints: [['applied', 'broken'], ['applied', 'fixed']], remainingCalls: 40, commandTool: 'run_command', postCommandSnapshots: [[], []], feedback: [[false, 1], [true, 0]], disposed: [false, false, false], executorDisposed: true, count: 2 });
		assert.ok(test.service.requests[0].messages[0].content.includes('those final changes have not been verified'));
	});

	test('validates command root, cwd, exact arguments and bounded text before execution', async () => {
		const valid = { root: 'root-1', path: '', command: 'npm test', explanation: 'Run tests' };
		for (const patch of [
			{ root: 'missing' }, { path: '../outside' }, { path: 'C:\\outside' }, { path: '/outside' },
			{ command: '' }, { command: 'x'.repeat(8193) }, { command: 'echo \0' }, { command: 5 },
			{ explanation: '' }, { explanation: 'x'.repeat(501) }, { explanation: 'hidden\ntext' }, { dangerous: true }
		]) {
			const test = setupExecution(repeated(tool('run_command', { ...valid, ...patch })));
			await assert.rejects(test.run(), /unsupported Agent action/);
			assert.deepStrictEqual({ calls: test.execution.calls, disposed: test.execution.disposed }, { calls: [], disposed: true });
		}
	});

	test('requires both editing and command factories before advertising or executing commands', async () => {
		const factory: ICloudCodeAgentExecutionFactory = { shell: 'cmd', createSession: () => { throw new Error('Must not create'); } };
		const test = setup(repeated(command()), undefined, factory);
		await assert.rejects(test.run(), /unsupported Agent action/);
		assert.strictEqual(test.service.requests[0].tools.some(tool => tool.name === 'run_command'), false);
	});

	test('denied command keeps staged changes pending and provides no successful check result', async () => {
		const test = setupExecution([
			tool('create_file', { root: 'root-1', path: 'new.ts', content: 'pending' }), command(), answer('Pending changes are ready; the check was declined.')
		]);
		test.execution.onRun = async () => ({ denied: true });
		const result = await test.run();
		const feedback = test.service.requests[2].messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content)).at(-1);
		assert.deepStrictEqual({ status: result.editingSession?.status, disk: [...test.files], checkpoints: result.checkpoints, feedback: [feedback.ok, feedback.code], count: result.commandCount }, { status: 'pending', disk: [], checkpoints: undefined, feedback: [false, 'command_denied'], count: 1 });
	});

	test('command-only execution resets file observations and reads command changes from disk', async () => {
		const test = setupExecution([
			tool('read', { root: 'root-1', path: 'main.ts' }), command(),
			tool('apply_patch', { root: 'root-1', path: 'main.ts', oldText: 'original', newText: 'stale edit' }),
			tool('read', { root: 'root-1', path: 'main.ts' }),
			tool('apply_patch', { root: 'root-1', path: 'main.ts', oldText: 'command changed', newText: 'correct edit' }), answer('Ready')
		], { 'main.ts': 'original' });
		const execute = test.execution.onRun;
		test.execution.onRun = async (command, session, token) => {
			const result = await execute(command, session, token);
			test.files.set('main.ts', 'command changed');
			return result;
		};
		const result = await test.run();
		assert.deepStrictEqual({ original: result.editingSession?.changes[0].before.content, final: result.editingSession?.changes[0].after.content, disposed: test.workspaces[0].disposed, checkpoints: result.checkpoints, staleSnapshots: requestData(test.service, 2).snapshots, corrected: test.progress.includes('Checking the file before retrying the change…') }, { original: 'command changed', final: 'correct edit', disposed: true, checkpoints: undefined, staleSnapshots: [], corrected: true });
	});

	test('Stop waits for command cleanup and transfers checkpoints applied before cancellation', async () => {
		const test = setupExecution([tool('create_file', { root: 'root-1', path: 'new.ts', content: 'applied' }), command()]);
		const cancellation = disposables.add(new CancellationTokenSource());
		const started = new DeferredPromise<void>();
		const finished = new DeferredPromise<CloudCodeAgentCommandResult>();
		const execute = test.execution.onRun;
		test.execution.onRun = async (command, session, token) => {
			await execute(command, session, token);
			await started.complete();
			return finished.p;
		};
		let settled = false;
		const running = test.run([], cancellation.token).then(result => { settled = true; return result; });
		await started.p;
		cancellation.cancel();
		await Promise.resolve();
		assert.strictEqual(settled, false);
		await finished.complete({ exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true, truncated: false });
		const result = await running;
		assert.deepStrictEqual({ incomplete: result.incomplete, checkpoint: result.checkpoints?.[0].status, disposed: test.workspaces[0].disposed, executorDisposed: test.execution.disposed, requests: test.service.requests.length, count: result.commandCount, error: result.error }, { incomplete: true, checkpoint: 'applied', disposed: false, executorDisposed: true, requests: 2, count: 1, error: undefined });
	});

	test('failure after checkpoint application reports fixed feedback without losing undo or exposing raw errors', async () => {
		const test = setupExecution([tool('create_file', { root: 'root-1', path: 'new.ts', content: 'applied' }), command(), answer('The checkpoint was applied but the check failed to launch.')]);
		const execute = test.execution.onRun;
		test.execution.onRun = async (command, session, token) => { await execute(command, session, token); throw new Error('Secret /private/path credential'); };
		const result = await test.run();
		assert.deepStrictEqual({ checkpoint: result.checkpoints?.[0].status, pending: result.editingSession, disposed: test.workspaces.map(workspace => workspace.disposed), leaked: JSON.stringify([test.service.requests, test.service.diagnostics]).includes('Secret /private/path credential'), diagnostics: test.service.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.stage]) }, { checkpoint: 'applied', pending: undefined, disposed: [false, true], leaked: false, diagnostics: [['operation_failed', 'command']] });
	});

	test('locally authored setup failures explain the blocked command to the model and user', async () => {
		const test = setupExecution([command(), answer('Save your open files before running this check.')]);
		const reason = 'Save all open files before running an Agent command.';
		test.execution.onRun = async () => { throw new CloudCodeAgentExecutionError(reason); };
		const result = await test.run();
		const feedback = JSON.parse(test.service.requests[1].messages.find(message => message.role === 'tool')!.content);
		assert.deepStrictEqual({ feedback: [feedback.ok, feedback.code, feedback.reason], visibleReason: test.progress.includes('Command could not complete: ' + reason), incomplete: result.incomplete, diagnostics: test.service.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.stage]) }, { feedback: [false, 'command_failed', reason], visibleReason: true, incomplete: undefined, diagnostics: [['operation_failed', 'command']] });
	});

	test('fatal command failures stop the loop and retain their explanation and applied checkpoint even after Stop', async () => {
		for (const cancelled of [false, true]) {
			const test = setupExecution([tool('create_file', { root: 'root-1', path: 'new.ts', content: 'applied' }), command(), answer('Must not continue')]);
			const cancellation = disposables.add(new CancellationTokenSource());
			const reason = 'The command may still be running. Stop it before continuing.';
			const execute = test.execution.onRun;
			test.execution.onRun = async (command, session, token) => {
				await execute(command, session, token);
				if (cancelled) { cancellation.cancel(); }
				throw new CloudCodeAgentExecutionError(reason, true);
			};
			const result = await test.run([], cancellation.token);
			assert.deepStrictEqual({ incomplete: result.incomplete, error: result.error, checkpoint: result.checkpoints?.[0].status, disposed: test.workspaces[0].disposed, executorDisposed: test.execution.disposed, requests: test.service.requests.length, diagnostics: test.service.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.stage]) }, { incomplete: true, error: reason, checkpoint: 'applied', disposed: false, executorDisposed: true, requests: 2, diagnostics: [['operation_failed', 'command']] });
		}
	});

	test('partial checkpoint application stops and retains its recovery handle', async () => {
		const test = setupExecution([tool('create_file', { root: 'root-1', path: 'new.ts', content: 'partial' }), command(), answer('Must not continue')]);
		test.execution.onRun = async (_command, session) => { test.workspaces[0].apply = async () => false; await session.preview(); await session.apply(); throw new Error('Unreachable'); };
		const result = await test.run();
		assert.deepStrictEqual({ incomplete: result.incomplete, status: result.checkpoints?.[0].status, disposed: test.workspaces[0].disposed, requests: test.service.requests.length }, { incomplete: true, status: 'partial', disposed: false, requests: 2 });
	});

	test('late model failure preserves applied checkpoints and discards the later pending overlay', async () => {
		const test = setupExecution([tool('create_file', { root: 'root-1', path: 'first.ts', content: 'applied' }), command(), tool('create_file', { root: 'root-1', path: 'second.ts', content: 'pending' }), ...repeated(tool('unsupported', {}))]);
		const result = await test.run();
		assert.deepStrictEqual({ incomplete: result.incomplete, count: result.checkpoints?.length, pending: result.editingSession, disk: [...test.files], disposed: test.workspaces.map(workspace => workspace.disposed) }, { incomplete: true, count: 1, pending: undefined, disk: [['first.ts', 'applied']], disposed: [false, true] });
	});

	test('caps command attempts at four and marks a denied or timed-out check as unsuccessful', async () => {
		const test = setupExecution([command(), command(), command(), command(), command(), answer('Must not continue')]);
		test.execution.onRun = async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: true, cancelled: false, truncated: false });
		const result = await test.run();
		assert.deepStrictEqual({ incomplete: result.incomplete, count: result.commandCount, calls: test.execution.calls.length, timedOutSuccess: test.service.requests[1].messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content).ok) }, { incomplete: true, count: 4, calls: 4, timedOutSuccess: [false] });
	});

	test('bounds command output including JSON escaping and never puts raw output in diagnostics or progress', async () => {
		const test = setupExecution([command(), ...repeated(tool('unsupported', {}))]);
		test.execution.onRun = async () => ({ exitCode: 1, stdout: 'private-output' + '\t'.repeat(8192), stderr: 'x'.repeat(20000), timedOut: false, cancelled: false, truncated: false });
		const result = await test.run();
		const feedback = JSON.parse(test.service.requests[1].messages.find(message => message.role === 'tool')!.content);
		assert.deepStrictEqual({ incomplete: result.incomplete, truncated: feedback.truncated, withinLimits: test.service.requests.every(request => request.messages.every(message => message.content.length <= CLOUDCODE_MAX_MESSAGE_LENGTH)), leaked: JSON.stringify([test.service.diagnostics, test.progress, result]).includes('private-output') }, { incomplete: true, truncated: true, withinLimits: true, leaked: false });
	});

	test('execution-enabled tasks enforce forty model calls', async () => {
		const test = setupExecution([command(), ...Array.from({ length: 40 }, () => tool('list', { root: 'root-1', path: '' }))]);
		const result = await test.run();
		assert.deepStrictEqual({ incomplete: result.incomplete, requests: test.service.requests.length, error: result.error?.includes('40-call limit') }, { incomplete: true, requests: 40, error: true });
	});

	test('execution-enabled deadline preserves applied checkpoints after fifteen minutes', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const test = setupExecution([tool('create_file', { root: 'root-1', path: 'new.ts', content: 'applied' }), command()]);
			const started = new DeferredPromise<void>();
			test.service.onRequest = async () => {
				const next = test.service.responses.shift();
				if (next) { return next; }
				await started.complete();
				return new Promise(() => { });
			};
			const running = test.run();
			await started.p;
			await clock.tickAsync(15 * 60 * 1000);
			const result = await running;
			assert.deepStrictEqual({ incomplete: result.incomplete, status: result.checkpoints?.[0].status, timers: clock.countTimers(), error: result.error, diagnostic: test.service.diagnostics[0]?.code }, { incomplete: true, status: 'applied', timers: 0, error: 'Agent reached its fifteen-minute limit.', diagnostic: 'timeout' });
		} finally { clock.restore(); }
	});

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

	test('stages a complete multi-file task across repeated patches, rename, create and delete without disk writes', async () => {
		const test = setupEditing([
			tool('read', { root: 'root-1', path: 'main.ts' }),
			tool('apply_patch', { root: 'root-1', path: 'main.ts', oldText: 'original', newText: 'first edit' }),
			tool('rename_file', { root: 'root-1', path: 'main.ts', newPath: 'renamed.ts' }),
			tool('read', { root: 'root-1', path: 'renamed.ts' }),
			tool('apply_patch', { root: 'root-1', path: 'renamed.ts', oldText: 'first edit', newText: 'final edit' }),
			tool('create_file', { root: 'root-1', path: 'temporary.ts', content: 'temporary' }),
			tool('delete_file', { root: 'root-1', path: 'temporary.ts' }),
			tool('create_file', { root: 'root-1', path: 'new.ts', content: 'new file' }),
			tool('read', { root: 'root-1', path: 'remove.ts' }),
			tool('delete_file', { root: 'root-1', path: 'remove.ts' }),
			tool('list', { root: 'root-1', path: '' }),
			tool('read', { root: 'root-1', path: 'renamed.ts' }),
			answer('The three-file change is ready for review.')
		], { 'main.ts': 'original', 'remove.ts': 'remove me' });
		const result = await test.run();
		assert.deepStrictEqual({
			sessionTransferred: result.editingSession === test.editingSession,
			sessionDisposed: test.editingWorkspace.disposed,
			legacyEdits: result.edits,
			legacyPrepared: test.edits.prepared,
			diskCalls: test.session.calls.map(call => call.tool),
			diskFiles: [...test.editingWorkspace.files],
			changes: result.editingSession?.changes.map(change => ({ kind: change.kind, before: change.before.path, after: change.after.path, content: change.after.content })),
			lastRead: requestData(test.service, 12).snapshots.map(snapshot => snapshot.content),
			remaining: requestData(test.service, 0).remainingCalls,
			tools: test.service.requests[0].tools.map(definition => definition.name)
		}, {
			sessionTransferred: true, sessionDisposed: false, legacyEdits: [], legacyPrepared: [], diskCalls: ['list'],
			diskFiles: [['main.ts', 'original'], ['remove.ts', 'remove me']],
			changes: [
				{ kind: 'rename', before: 'main.ts', after: 'renamed.ts', content: 'final edit' },
				{ kind: 'create', before: 'new.ts', after: 'new.ts', content: 'new file' },
				{ kind: 'delete', before: 'remove.ts', after: 'remove.ts', content: undefined }
			],
			lastRead: ['final edit'], remaining: 24,
			tools: ['list', 'findFiles', 'search', 'read', 'apply_patch', 'create_file', 'rename_file', 'delete_file']
		});
		const task = JSON.parse(test.service.requests[12].messages[1].content);
		assert.deepStrictEqual(task.stagedChanges, test.editingSession.summary());
		assert.ok(test.service.requests[12].messages[0].content.includes('describe disk files only'));
	});

	test('validates every staging argument before granting editing capabilities', async () => {
		for (const response of [
			tool('apply_patch', { root: 'root-1', path: 'main.ts', oldText: '', newText: 'replace' }),
			tool('apply_patch', { root: 'root-1', path: 'main.ts', oldText: 'old', newText: 'new', command: 'shell' }),
			tool('create_file', { root: 'root-1', path: 'new.ts', content: 'é'.repeat(16385) }),
			tool('create_file', { root: 'root-1', path: 'new.ts', content: '\0' }),
			tool('create_file', { root: 'missing', path: 'new.ts', content: 'value' }),
			tool('rename_file', { root: 'root-1', path: 'main.ts', newPath: '../outside.ts' }),
			tool('rename_file', { root: 'root-1', path: 'main.ts', newPath: 'file:///outside.ts' }),
			tool('delete_file', { root: 'root-1', path: 'main.ts', force: true }),
			tool('propose', { edits: [] })
		]) {
			const test = setupEditing(repeated(response), { 'main.ts': 'original' });
			await assert.rejects(test.run(), /unsupported Agent action/);
			assert.deepStrictEqual({ reads: test.editingWorkspace.reads, prepared: test.edits.prepared, disposed: test.editingWorkspace.disposed }, { reads: [], prepared: [], disposed: true });
		}
	});

	test('keeps a rolling source cache and preserves observations after eviction', async () => {
		const files = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [index + '.ts', `${index}:` + 'x'.repeat(5 * 1024)]));
		const test = setupEditing([
			...Object.keys(files).map(path => tool('read', { root: 'root-1', path })),
			tool('apply_patch', { root: 'root-1', path: '0.ts', oldText: '0:', newText: 'changed:' }),
			answer('Done')
		], files);
		const result = await test.run();
		assert.deepStrictEqual({
			paths: result.attachments.map(attachment => attachment.label),
			change: result.editingSession?.changes[0].after.content,
			failures: test.service.requests.at(-1)!.messages.filter(message => message.role === 'tool' && JSON.parse(message.content).ok === false)
		}, { paths: ['3.ts', '4.ts', '5.ts', '6.ts'], change: 'changed:' + 'x'.repeat(5 * 1024), failures: [] });
	});

	test('an overlay read that cannot fit in the model context terminates before its observations can authorize changes', async () => {
		const original = '\t'.repeat(16 * 1024);
		const test = setupEditing([
			tool('read', { root: 'root-1', path: 'escaped.ts' }),
			tool('delete_file', { root: 'root-1', path: 'escaped.ts' }),
			answer('Deleted')
		], { 'escaped.ts': original });
		await assert.rejects(test.run(), /context limit/);
		assert.deepStrictEqual({ requests: test.service.requests.length, disposed: test.editingWorkspace.disposed, disk: [...test.editingWorkspace.files] }, { requests: 1, disposed: true, disk: [['escaped.ts', original]] });
	});

	test('recovers a staging conflict with fixed feedback and a fresh read', async () => {
		const test = setupEditing([
			tool('apply_patch', { root: 'root-1', path: 'main.ts', oldText: 'original', newText: 'new' }),
			tool('read', { root: 'root-1', path: 'main.ts' }),
			tool('apply_patch', { root: 'root-1', path: 'main.ts', oldText: 'original', newText: 'new' }),
			answer('Ready')
		], { 'main.ts': 'original' });
		const result = await test.run();
		assert.deepStrictEqual({
			code: JSON.parse(test.service.requests[1].messages.at(-1)!.content).code,
			change: result.editingSession?.changes[0].after.content,
			leaksPaths: test.service.requests.some(request => JSON.stringify(request.messages).includes('file:///private')),
			diagnostics: test.service.diagnostics
		}, { code: 'edit_conflict', change: 'new', leaksPaths: false, diagnostics: [] });
	});

	test('exhausted staging recovery disposes all pending changes', async () => {
		const test = setupEditing([
			tool('create_file', { root: 'root-1', path: 'new.ts', content: 'pending' }),
			...repeated(tool('apply_patch', { root: 'root-1', path: 'missing.ts', oldText: 'old', newText: 'new' }))
		]);
		await assert.rejects(test.run(), /consistent set of changes/);
		assert.deepStrictEqual({ disposed: test.editingWorkspace.disposed, disk: [...test.editingWorkspace.files], calls: test.service.requests.length, diagnostics: test.service.diagnostics.map(diagnostic => diagnostic.code) }, { disposed: true, disk: [], calls: 4, diagnostics: ['invalid_result'] });
	});

	test('deleted overlay files never fall back to a stale disk read', async () => {
		const test = setupEditing([
			tool('read', { root: 'root-1', path: 'main.ts' }),
			tool('delete_file', { root: 'root-1', path: 'main.ts' }),
			tool('read', { root: 'root-1', path: 'main.ts' }),
			answer('Ready')
		], { 'main.ts': 'original' });
		const result = await test.run();
		assert.deepStrictEqual({ diskReads: test.session.calls, snapshots: result.attachments, code: JSON.parse(test.service.requests[3].messages.at(-1)!.content).code, change: result.editingSession?.changes[0].kind }, { diskReads: [], snapshots: [], code: 'context_unavailable', change: 'delete' });
	});

	test('preserves bounded read-only access to files above the editing size limit', async () => {
		const test = setupEditing([
			tool('read', { root: 'root-1', path: 'large.ts', startLine: 1, endLine: 5 }), answer('Read only')
		], { 'large.ts': 'x'.repeat(1024 * 1024 + 1) });
		test.session.onExecute = async () => ({ text: '', attachment: attachment('large.ts', 'excerpt') });
		const result = await test.run();
		assert.deepStrictEqual({ diskCalls: test.session.calls.length, content: result.attachments[0].content, editingSession: result.editingSession, disposed: test.editingWorkspace.disposed }, { diskCalls: 1, content: 'excerpt', editingSession: undefined, disposed: true });
		assert.ok(test.service.requests[1].messages.at(-1)!.content.includes('Read-only'));
	});

	test('cancellation after staging disposes the overlay without touching files', async () => {
		const test = setupEditing([tool('create_file', { root: 'root-1', path: 'new.ts', content: 'pending' })]);
		const cancellation = disposables.add(new CancellationTokenSource());
		const waiting = new DeferredPromise<void>();
		test.service.onRequest = async () => {
			if (test.service.requests.length === 1) { return test.service.responses.shift()!; }
			await waiting.complete();
			return new Promise(() => { });
		};
		const running = test.run([], cancellation.token);
		await waiting.p;
		cancellation.cancel();
		await assert.rejects(running, isCancellationError);
		assert.deepStrictEqual({ disposed: test.editingWorkspace.disposed, disk: [...test.editingWorkspace.files], diagnostics: test.service.diagnostics }, { disposed: true, disk: [], diagnostics: [] });
	});

	test('editing tasks have a five-minute deadline and dispose a timed-out overlay', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const test = setupEditing();
			test.service.onRequest = async () => new Promise(() => { });
			const running = assert.rejects(test.run(), /five-minute limit/);
			await clock.tickAsync(5 * 60 * 1000);
			await running;
			assert.deepStrictEqual({ disposed: test.editingWorkspace.disposed, timers: clock.countTimers(), code: test.service.diagnostics[0]?.code }, { disposed: true, timers: 0, code: 'timeout' });
		} finally { clock.restore(); }
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

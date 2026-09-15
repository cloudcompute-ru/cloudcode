/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLOUDCODE_MAX_MESSAGE_LENGTH, ICloudCodeChatDelta, ICloudCodeMessage, ICloudCodeModel, ICloudCodeService, ICloudCodeState } from '../../../../../platform/cloudCode/common/cloudCode.js';
import { CloudCodeChatStatus, ICloudCodeChatMessage, ICloudCodeChatView } from '../../common/cloudCodeChat.js';
import { CloudCodeChatController } from '../../common/cloudCodeChatController.js';
import { formatCloudCodePrompt, ICloudCodeAttachment, ICloudCodeContextProvider } from '../../common/cloudCodeChatContext.js';
import { CloudCodeChatMode, ICloudCodeEditProposal, ICloudCodeEditProvider, ICloudCodeEditTarget, ICloudCodeProposedEdit } from '../../common/cloudCodeEdits.js';
import { ICloudCodeConversationStorage } from '../../common/cloudCodeConversations.js';
import { ICloudCodeAgent } from '../../common/cloudCodeAgent.js';

class TestView extends Disposable implements ICloudCodeChatView {
	readonly selectConversation = this._register(new Emitter<string>());
	readonly onDidSelectConversation = this.selectConversation.event;
	readonly changeDraft = this._register(new Emitter<void>());
	readonly onDidChangeDraft = this.changeDraft.event;
	chats: readonly { id: string; title: string }[] = [];
	activeChat = '';
	getDraft(): string { return this.draft; }
	setConversations(chats: readonly { id: string; title: string }[], activeId: string): void { this.chats = chats; this.activeChat = activeId; }
	readonly changeMode = this._register(new Emitter<CloudCodeChatMode>());
	readonly onDidChangeMode = this.changeMode.event;
	readonly reviewEdit = this._register(new Emitter<{ id: string; action: 'preview' | 'accept' | 'reject' }>());
	readonly onDidReviewEdit = this.reviewEdit.event;
	readonly requestAttachments = this._register(new Emitter<void | (() => Promise<readonly ICloudCodeAttachment[]>)>());
	readonly onDidRequestAttachments = this.requestAttachments.event;
	readonly removeAttachment = this._register(new Emitter<string>());
	readonly onDidRemoveAttachment = this.removeAttachment.event;
	readonly submit = this._register(new Emitter<string>());
	readonly onDidSubmit = this.submit.event;
	readonly stop = this._register(new Emitter<void>());
	readonly onDidStop = this.stop.event;
	readonly signIn = this._register(new Emitter<void>());
	readonly onDidSignIn = this.signIn.event;
	readonly cancelSignIn = this._register(new Emitter<void>());
	readonly onDidCancelSignIn = this.cancelSignIn.event;
	readonly signOut = this._register(new Emitter<void>());
	readonly onDidSignOut = this.signOut.event;
	readonly newConversation = this._register(new Emitter<void>());
	readonly onDidNewConversation = this.newConversation.event;
	readonly selectModel = this._register(new Emitter<string>());
	readonly onDidSelectModel = this.selectModel.event;
	readonly retryModels = this._register(new Emitter<void>());
	readonly onDidRetryModels = this.retryModels.event;
	state: ICloudCodeState = { status: 'signedOut' };
	models: readonly ICloudCodeModel[] = [];
	messages: ICloudCodeChatMessage[] = [];
	status: CloudCodeChatStatus = 'disconnected';
	error: string | undefined;
	draft = '';
	attachments: readonly ICloudCodeAttachment[] = [];
	loadingAttachments = false;
	mode: CloudCodeChatMode = 'ask';
	proposals: readonly ICloudCodeEditProposal[] = [];
	busyEdits = false;
	setEditMode(mode: CloudCodeChatMode): void { this.mode = mode; }
	setEditProposals(proposals: readonly ICloudCodeEditProposal[], busy: boolean): void {
		this.proposals = proposals;
		this.busyEdits = busy;
	}
	setAttachments(attachments: readonly ICloudCodeAttachment[], loading: boolean): void {
		this.attachments = attachments;
		this.loadingAttachments = loading;
	}
	setSession(state: ICloudCodeState): void { this.state = state; }
	setModels(models: readonly ICloudCodeModel[]): void { this.models = models; }
	setMessages(messages: readonly ICloudCodeChatMessage[]): void { this.messages = [...messages]; }
	appendResponse(text: string): void {
		const last = this.messages.length - 1;
		this.messages[last] = { ...this.messages[last], text: this.messages[last].text + text };
	}
	setStatus(status: CloudCodeChatStatus): void { this.status = status; }
	setError(message: string | undefined): void { this.error = message; }
	setDraft(value: string): void { this.draft = value; }
}

class TestContextProvider implements ICloudCodeContextProvider {
	result: Promise<readonly ICloudCodeAttachment[]> = Promise.resolve([]);
	trusted = true;
	pickAttachments(): Promise<readonly ICloudCodeAttachment[]> { return this.result; }
	assertWorkspaceTrusted(): void {
		if (!this.trusted) {
			throw new Error('Workspace is not trusted');
		}
	}
}

class TestEditProvider implements ICloudCodeEditProvider {
	prepareResult: Promise<readonly ICloudCodeEditTarget[]> | undefined;
	previewResult: Promise<void> = Promise.resolve();
	applyResult: Promise<void> = Promise.resolve();
	readonly prepared: (readonly ICloudCodeAttachment[])[] = [];
	readonly previews: ICloudCodeProposedEdit[] = [];
	readonly applications: ICloudCodeProposedEdit[] = [];
	clearCount = 0;
	async prepare(attachments: readonly ICloudCodeAttachment[]): Promise<readonly ICloudCodeEditTarget[]> {
		this.prepared.push(attachments);
		return this.prepareResult ?? attachments.map((attachment, index) => ({ token: String(index + 1), attachment }));
	}
	async preview(edit: ICloudCodeProposedEdit): Promise<void> {
		this.previews.push(edit);
		await this.previewResult;
	}
	async apply(edit: ICloudCodeProposedEdit): Promise<void> {
		this.applications.push(edit);
		await this.applyResult;
	}
	clear(): void { this.clearCount++; }
}

class TestAgent implements ICloudCodeAgent {
	readonly requests: {
		prompt: string;
		attachments: readonly ICloudCodeAttachment[];
		model: string;
		token: CancellationToken;
		onProgress: Parameters<ICloudCodeAgent['run']>[4];
		result: DeferredPromise<Awaited<ReturnType<ICloudCodeAgent['run']>>>;
	}[] = [];
	run(prompt: string, attachments: readonly ICloudCodeAttachment[], model: string, token: CancellationToken, onProgress: Parameters<ICloudCodeAgent['run']>[4]): ReturnType<ICloudCodeAgent['run']> {
		const result = new DeferredPromise<Awaited<ReturnType<ICloudCodeAgent['run']>>>();
		this.requests.push({ prompt, attachments, model, token, onProgress, result });
		return result.p;
	}
}

const signedIn: ICloudCodeState = {
	status: 'signedIn',
	account: {
		user: { id: 1, name: 'Alex', email: 'alex@example.com' },
		team: { id: 1, name: 'Team', },
		balance: null
	},
	persisted: true
};

class TestService extends Disposable implements ICloudCodeService {
	declare readonly _serviceBrand: undefined;
	readonly stateEmitter = this._register(new Emitter<ICloudCodeState>());
	readonly onDidChangeState = this.stateEmitter.event;
	readonly deltas = this._register(new Emitter<ICloudCodeChatDelta>());
	readonly onDidReceiveChatDelta = this.deltas.event;
	state = signedIn;
	modelResult: Promise<readonly ICloudCodeModel[]> = Promise.resolve([{ id: 'model', name: 'Model' }]);
	readonly requests: { id: string; model: string; messages: readonly ICloudCodeMessage[]; result: DeferredPromise<{ cancelled: boolean }> }[] = [];
	readonly cancelled: string[] = [];
	async getState(): Promise<ICloudCodeState> { return this.state; }
	async signIn(): Promise<void> { this.stateEmitter.fire({ status: 'signingIn' }); }
	async cancelSignIn(): Promise<void> { this.stateEmitter.fire({ status: 'signedOut' }); }
	async signOut(): Promise<void> { this.stateEmitter.fire({ status: 'signedOut' }); }
	getModels(): Promise<readonly ICloudCodeModel[]> { return this.modelResult; }
	streamChat(id: string, model: string, messages: readonly ICloudCodeMessage[]): Promise<{ cancelled: boolean }> {
		const result = new DeferredPromise<{ cancelled: boolean }>();
		this.requests.push({ id, model, messages, result });
		return result.p;
	}
	async cancelChat(id: string): Promise<void> { this.cancelled.push(id); }
}

suite('CloudCodeChatController', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let service: TestService;
	let view: TestView;
	let controller: CloudCodeChatController;
	let contextProvider: TestContextProvider;
	let editProvider: TestEditProvider;
	let agent: TestAgent;

	setup(async () => {
		service = disposables.add(new TestService());
		view = disposables.add(new TestView());
		contextProvider = new TestContextProvider();
		editProvider = new TestEditProvider();
		agent = new TestAgent();
		controller = disposables.add(new CloudCodeChatController(view, contextProvider, editProvider, agent, undefined, service));
		await controller.initialize();
		// The shared cases below exercise explicitly selected Ask behavior.
		view.changeMode.fire('ask');
	});

	async function attach(attachments: readonly ICloudCodeAttachment[]): Promise<void> {
		const result = new DeferredPromise<readonly ICloudCodeAttachment[]>();
		contextProvider.result = result.p;
		view.requestAttachments.fire();
		await result.complete(attachments);
		await Promise.resolve();
	}

	const editableAttachment: ICloudCodeAttachment = {
		id: 'file:///project/main.ts', resource: 'file:///project/main.ts', label: 'main.ts', content: 'const version = 1;', languageId: 'typescript'
	};

	async function settleEdits(): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}

	async function generateEdits(response: string = JSON.stringify({ edits: [{ attachment: 1, replacement: 'const version = 2;' }] })): Promise<void> {
		view.changeMode.fire('edit');
		await attach([editableAttachment]);
		view.submit.fire('Update the version');
		await settleEdits();
		const request = service.requests.at(-1)!;
		service.deltas.fire({ requestId: request.id, text: response });
		await request.result.complete({ cancelled: false });
		await settleEdits();
	}

	test('New Chat preserves messages, draft attachments and mode for switching back', async () => {
		view.submit.fire('Review package.json');
		const request = service.requests[0];
		service.deltas.fire({ requestId: request.id, text: 'It defines the build scripts.' });
		await request.result.complete({ cancelled: false });
		await attach([editableAttachment]);
		view.draft = 'Explain the scripts';
		const firstId = view.activeChat;
		view.newConversation.fire();
		const secondId = view.activeChat;
		assert.notStrictEqual(firstId, secondId);
		view.draft = 'Another question';
		view.selectConversation.fire(firstId);
		assert.deepStrictEqual({ title: view.chats.find(chat => chat.id === firstId)?.title, draft: view.draft, mode: view.mode, attachments: view.attachments, messages: view.messages.map(message => message.text) }, {
			title: 'Review package.json', draft: 'Explain the scripts', mode: 'ask', attachments: [editableAttachment], messages: ['Review package.json', 'It defines the build scripts.']
		});
		view.submit.fire('Continue');
		assert.deepStrictEqual(service.requests[1].messages.slice(0, 2), [{ role: 'user', content: 'Review package.json' }, { role: 'assistant', content: 'It defines the build scripts.' }]);
	});

	test('switching away from a running chat freezes its partial response and ignores late deltas', async () => {
		view.submit.fire('First');
		const first = service.requests[0];
		const firstId = view.activeChat;
		service.deltas.fire({ requestId: first.id, text: 'Partial reply' });
		view.newConversation.fire();
		service.deltas.fire({ requestId: first.id, text: 'Must not appear' });
		await first.result.complete({ cancelled: false });
		view.selectConversation.fire(firstId);
		assert.deepStrictEqual({ text: view.messages.at(-1)?.text, incomplete: view.messages.at(-1)?.incomplete, cancelled: service.cancelled }, { text: 'Partial reply', incomplete: true, cancelled: [first.id] });
	});

	test('history restores after reopening and remains isolated between accounts and teams', async () => {
		controller.dispose();
		const values = new Map<string, string>();
		const storage: ICloudCodeConversationStorage = { scope: account => `${account.user.id}:${account.team.id}`, read: scope => values.get(scope), write: (scope, value) => { values.set(scope, value); } };
		controller = disposables.add(new CloudCodeChatController(view, contextProvider, editProvider, agent, storage, service));
		await controller.initialize();
		view.changeMode.fire('ask');
		view.submit.fire('Remember this chat');
		service.deltas.fire({ requestId: service.requests[0].id, text: 'Saved answer' });
		await service.requests[0].result.complete({ cancelled: false });
		view.draft = 'Unsent follow-up';
		controller.dispose();
		controller = disposables.add(new CloudCodeChatController(view, contextProvider, editProvider, agent, storage, service));
		await controller.initialize();
		assert.deepStrictEqual({ draft: view.draft, mode: view.mode, text: view.messages.at(-1)?.text }, { draft: 'Unsent follow-up', mode: 'ask', text: 'Saved answer' });
		service.stateEmitter.fire({ ...signedIn, account: { ...signedIn.account!, team: { id: 2, name: 'Another team' } } });
		assert.deepStrictEqual({ messages: view.messages, draft: view.draft, titles: view.chats.map(chat => chat.title) }, { messages: [], draft: '', titles: ['New Chat'] });
		service.stateEmitter.fire(signedIn);
		assert.strictEqual(view.messages.at(-1)?.text, 'Saved answer');
	});

	test('Agent is the initial mode and dispatches project questions without a mode change', async () => {
		controller.dispose();
		controller = disposables.add(new CloudCodeChatController(view, contextProvider, editProvider, agent, undefined, service));
		await controller.initialize();
		const prompt = 'C:\\code\\cloudcode\\package.json — review the dependency versions';
		view.submit.fire(prompt);
		assert.deepStrictEqual({ mode: view.mode, prompt: agent.requests[0]?.prompt, nativeRequests: service.requests.length, text: view.messages.at(-1)?.text, progress: view.messages.at(-1)?.progress }, {
			mode: 'agent', prompt, nativeRequests: 0, text: '', progress: 'Exploring your project…'
		});
		await agent.requests[0].result.complete({ text: 'Reviewed the file.', attachments: [], edits: [] });
		await settleEdits();
	});

	test('Ask remains available when the window has no Agent implementation', async () => {
		controller.dispose();
		controller = disposables.add(new CloudCodeChatController(view, contextProvider, editProvider, undefined, undefined, service));
		await controller.initialize();
		view.submit.fire('Explain this');
		assert.deepStrictEqual({ mode: view.mode, messages: service.requests[0]?.messages, agentRequests: agent.requests.length }, {
			mode: 'ask', messages: [{ role: 'user', content: 'Explain this' }], agentRequests: 0
		});
	});

	test('an explicit Ask choice survives New Chat and account updates and does not resolve typed paths', async () => {
		view.newConversation.fire();
		service.stateEmitter.fire({ ...signedIn, account: { ...signedIn.account!, team: { id: 2, name: 'Other team' } } });
		await settleEdits();
		const prompt = 'C:\\code\\cloudcode\\package.json — explain this file';
		view.submit.fire(prompt);
		assert.deepStrictEqual({ mode: view.mode, messages: service.requests[0]?.messages, agentRequests: agent.requests.length, attachments: view.attachments }, {
			mode: 'ask', messages: [{ role: 'user', content: prompt }], agentRequests: 0, attachments: []
		});
	});

	test('pasted images are retained in follow-up requests and cleared by New Chat', async () => {
		const attachment = { id: 'screenshot', label: 'Screenshot.png', content: '', image: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=' } };
		view.requestAttachments.fire(async () => [attachment]);
		await settleEdits();
		view.submit.fire('Explain this');
		const first = service.requests[0];
		service.deltas.fire({ requestId: first.id, text: 'An image' });
		await first.result.complete({ cancelled: false });
		view.submit.fire('More details');
		assert.deepStrictEqual(service.requests[1].messages[0].images, [attachment.image]);
		view.newConversation.fire();
		view.submit.fire('Hello');
		assert.deepStrictEqual(service.requests[2].messages, [{ role: 'user', content: 'Hello' }]);
	});

	test('New Chat discards an in-flight drop before it can attach to the new draft', async () => {
		const pending = new DeferredPromise<readonly ICloudCodeAttachment[]>();
		view.requestAttachments.fire(() => pending.p);
		view.newConversation.fire();
		await pending.complete([editableAttachment]);
		await settleEdits();
		assert.deepStrictEqual({ attachments: view.attachments, loading: view.loadingAttachments }, { attachments: [], loading: false });
	});

	test('edit mode sends images as references but only prepares text targets', async () => {
		const image = { id: 'image', label: 'Screenshot.png', content: '', image: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=' } };
		await attach([image, editableAttachment]);
		view.changeMode.fire('edit');
		view.submit.fire('Match the screenshot');
		await settleEdits();
		assert.deepStrictEqual(editProvider.prepared, [[editableAttachment]]);
		assert.deepStrictEqual(service.requests[0].messages[0].images, [image.image]);
	});

	test('streams only matching request deltas and carries completed turns forward', async () => {
		view.submit.fire('First question');
		const first = service.requests[0];
		service.deltas.fire({ requestId: 'another-window', text: 'wrong' });
		service.deltas.fire({ requestId: first.id, text: 'First ' });
		service.deltas.fire({ requestId: first.id, text: 'answer' });
		await first.result.complete({ cancelled: false });
		view.submit.fire('Second question');
		assert.deepStrictEqual({ messages: service.requests[1].messages, status: view.status }, {
			messages: [
				{ role: 'user', content: 'First question' },
				{ role: 'assistant', content: 'First answer' },
				{ role: 'user', content: 'Second question' }
			],
			status: 'running'
		});
	});

	test('stop is immediate, preserves partial response, and excludes the incomplete turn', async () => {
		view.submit.fire('Stopped question');
		const first = service.requests[0];
		service.deltas.fire({ requestId: first.id, text: 'Partial' });
		view.stop.fire();
		service.deltas.fire({ requestId: first.id, text: 'Late text' });
		await first.result.complete({ cancelled: false });
		assert.deepStrictEqual({ last: view.messages.at(-1), cancelled: service.cancelled, status: view.status }, {
			last: { role: 'assistant', text: 'Partial', incomplete: true },
			cancelled: [first.id],
			status: 'ready'
		});
		view.submit.fire('Next question');
		assert.deepStrictEqual(service.requests[1].messages, [{ role: 'user', content: 'Next question' }]);
	});

	test('a failed response keeps partial text and allows another request without failed context', async () => {
		view.submit.fire('Failed question');
		const first = service.requests[0];
		service.deltas.fire({ requestId: first.id, text: 'Partial' });
		await first.result.error(new Error('Connection lost'));
		assert.deepStrictEqual({ last: view.messages.at(-1), error: view.error, status: view.status }, {
			last: { role: 'assistant', text: 'Partial', incomplete: true }, error: 'Connection lost', status: 'ready'
		});
		view.submit.fire('Try another question');
		assert.deepStrictEqual(service.requests[1].messages, [{ role: 'user', content: 'Try another question' }]);
	});

	test('account change clears conversation and draft and cancels the previous request', () => {
		view.submit.fire('Private question');
		view.draft = 'Private draft';
		service.stateEmitter.fire({ ...signedIn, account: { ...signedIn.account!, team: { id: 2, name: 'Another team' } } });
		assert.deepStrictEqual({ messages: view.messages, draft: view.draft, cancelled: service.cancelled }, {
			messages: [], draft: '', cancelled: [service.requests[0].id]
		});
	});

	test('late model responses cannot restore a signed-out session', async () => {
		const models = new DeferredPromise<readonly ICloudCodeModel[]>();
		service.modelResult = models.p;
		service.stateEmitter.fire({ status: 'signedOut' });
		service.stateEmitter.fire(signedIn);
		service.stateEmitter.fire({ status: 'signedOut' });
		await models.complete([{ id: 'late-model', name: 'Late model' }]);
		assert.deepStrictEqual({ state: view.state.status, models: view.models, status: view.status }, {
			state: 'signedOut', models: [], status: 'disconnected'
		});
	});

	test('model loading errors can be retried without another sign-in', async () => {
		const models = new DeferredPromise<readonly ICloudCodeModel[]>();
		service.modelResult = models.p;
		service.stateEmitter.fire({ status: 'signedOut' });
		service.stateEmitter.fire(signedIn);
		await models.error(new Error('Network unavailable'));
		service.modelResult = Promise.resolve([{ id: 'recovered', name: 'Recovered' }]);
		view.retryModels.fire();
		await Promise.resolve();
		assert.deepStrictEqual({ status: view.status, models: view.models, error: view.error }, {
			status: 'ready', models: [{ id: 'recovered', name: 'Recovered' }], error: undefined
		});
	});

	test('new chat cancels an active request and starts with empty model context', () => {
		view.submit.fire('Old question');
		view.newConversation.fire();
		view.submit.fire('Fresh question');
		assert.deepStrictEqual({ messages: service.requests[1].messages, cancelled: service.cancelled }, {
			messages: [{ role: 'user', content: 'Fresh question' }], cancelled: [service.requests[0].id]
		});
	});

	test('sign-out and cancelled sign-in update the view through native state events', () => {
		view.signOut.fire();
		view.signIn.fire();
		assert.strictEqual(view.state.status, 'signingIn');
		view.cancelSignIn.fire();
		assert.strictEqual(view.state.status, 'signedOut');
	});

	test('disposing the window cancels its stream and ignores late events', () => {
		view.submit.fire('Question');
		const request = service.requests[0];
		controller.dispose();
		service.deltas.fire({ requestId: request.id, text: 'Late' });
		assert.deepStrictEqual({ text: view.messages.at(-1)?.text, cancelled: service.cancelled }, { text: '', cancelled: [request.id] });
	});

	test('oversized messages retain the draft without sending an inference request', () => {
		const prompt = 'x'.repeat(CLOUDCODE_MAX_MESSAGE_LENGTH + 1);
		view.submit.fire(prompt);
		assert.deepStrictEqual({ requests: service.requests.length, draft: view.draft, status: view.status }, { requests: 0, draft: prompt, status: 'ready' });
		assert.ok(view.error?.includes('Shorten'));
	});

	test('context limits count UTF-8 bytes and never silently drop existing history', async () => {
		view.submit.fire('First question');
		service.deltas.fire({ requestId: service.requests[0].id, text: '界'.repeat(21000) });
		await service.requests[0].result.complete({ cancelled: false });
		const prompt = '界'.repeat(1000);
		view.submit.fire(prompt);
		assert.deepStrictEqual({ requests: service.requests.length, draft: view.draft, status: view.status }, { requests: 1, draft: prompt, status: 'ready' });
		assert.ok(view.error?.includes('New Chat'));
	});

	test('attached snapshots stay local until submit and completed turns retain their serialized context', async () => {
		const source = { id: 'file:///private/project/src/main.ts', label: 'src/main.ts', content: 'const version = 1;', languageId: 'typescript' };
		await attach([source]);
		assert.strictEqual(service.requests.length, 0);
		source.content = 'const version = 2;';
		const snapshot = { ...source, content: 'const version = 1;' };
		view.submit.fire('Explain this code');
		const first = service.requests[0];
		service.deltas.fire({ requestId: first.id, text: 'It declares a constant.' });
		await first.result.complete({ cancelled: false });
		view.submit.fire('What is its value?');
		assert.deepStrictEqual({ displayed: view.messages[0], attachments: view.attachments, context: service.requests[1].messages }, {
			displayed: { role: 'user', text: 'Explain this code', attachments: [snapshot] },
			attachments: [],
			context: [
				{ role: 'user', content: formatCloudCodePrompt('Explain this code', [snapshot]) },
				{ role: 'assistant', content: 'It declares a constant.' },
				{ role: 'user', content: 'What is its value?' }
			]
		});
	});

	test('reselecting an attachment replaces its snapshot and removal excludes it from the request', async () => {
		const file = { id: 'file', label: 'file.ts', content: 'old' };
		const selection = { id: 'selection', label: 'file.ts', content: 'selected', startLine: 3, endLine: 4 };
		await attach([file, selection]);
		await attach([{ ...file, content: 'new' }]);
		view.removeAttachment.fire('selection');
		assert.deepStrictEqual(view.attachments, [{ ...file, content: 'new' }]);
		view.removeAttachment.fire('file');
		view.submit.fire('No files');
		assert.deepStrictEqual(service.requests[0].messages, [{ role: 'user', content: 'No files' }]);
	});

	test('oversized serialized requests preserve both the question and attached snapshots', async () => {
		const attachment = { id: 'file', label: 'file.ts', content: 'x'.repeat(16 * 1024) };
		await attach([attachment]);
		const prompt = 'q'.repeat(20 * 1024);
		view.submit.fire(prompt);
		assert.deepStrictEqual({ requests: service.requests.length, draft: view.draft, attachments: view.attachments, status: view.status }, {
			requests: 0, draft: prompt, attachments: [attachment], status: 'ready'
		});
		assert.ok(view.error);
	});

	test('a rejected attachment batch leaves the existing draft intact', async () => {
		const attachment = { id: 'file', label: 'file.ts', content: 'keep me' };
		await attach([attachment]);
		await attach([{ id: 'large', label: 'large.ts', content: '界'.repeat(6000) }]);
		assert.deepStrictEqual({ attachments: view.attachments, loading: view.loadingAttachments, requests: service.requests.length }, {
			attachments: [attachment], loading: false, requests: 0
		});
		assert.ok(view.error);
	});

	test('submit is blocked until the explicit attachment read finishes', async () => {
		const result = new DeferredPromise<readonly ICloudCodeAttachment[]>();
		contextProvider.result = result.p;
		view.requestAttachments.fire();
		view.submit.fire('Must not omit the file');
		assert.deepStrictEqual({ requests: service.requests.length, loading: view.loadingAttachments }, { requests: 0, loading: true });
		await result.complete([{ id: 'file', label: 'file.ts', content: 'read result' }]);
		await Promise.resolve();
		assert.strictEqual(view.loadingAttachments, false);
	});

	test('switching back during Agent work restores the old chat and ignores the late result', async () => {
		view.changeMode.fire('agent');
		view.submit.fire('First task');
		await agent.requests[0].result.complete({ text: 'First answer', attachments: [], edits: [] });
		await settleEdits();
		const firstId = view.activeChat;
		view.newConversation.fire();
		view.submit.fire('Second task');
		const secondId = view.activeChat;
		const request = agent.requests[1];
		view.selectConversation.fire(firstId);
		request.onProgress('Late progress');
		await request.result.complete({ text: 'Late answer', attachments: [], edits: [] });
		await settleEdits();
		assert.deepStrictEqual({ text: view.messages.at(-1)?.text, cancelled: request.token.isCancellationRequested }, { text: 'First answer', cancelled: true });
		view.selectConversation.fire(secondId);
		assert.deepStrictEqual({ text: view.messages.at(-1)?.text, incomplete: view.messages.at(-1)?.incomplete }, { text: 'Agent stopped. No changes were applied.', incomplete: true });
	});

	for (const reset of ['newChat', 'accountChange', 'signOut', 'dispose'] as const) {
		test(`${reset} ignores attachment results from an earlier conversation`, async () => {
			const result = new DeferredPromise<readonly ICloudCodeAttachment[]>();
			contextProvider.result = result.p;
			view.requestAttachments.fire();
			switch (reset) {
				case 'newChat': view.newConversation.fire(); break;
				case 'accountChange': service.stateEmitter.fire({ ...signedIn, account: { ...signedIn.account!, team: { id: 2, name: 'Other team' } } }); break;
				case 'signOut': view.signOut.fire(); break;
				case 'dispose': controller.dispose(); break;
			}
			await result.complete([{ id: 'private', label: 'private.ts', content: 'old account data' }]);
			await Promise.resolve();
			assert.deepStrictEqual(view.attachments, []);
		});
	}

	for (const outcome of ['cancelled', 'failed'] as const) {
		test(`${outcome} turns do not resend their attachments in later requests`, async () => {
			await attach([{ id: 'file', label: 'file.ts', content: 'discarded context' }]);
			view.submit.fire('First question');
			const first = service.requests[0];
			if (outcome === 'cancelled') {
				view.stop.fire();
				await first.result.complete({ cancelled: true });
			} else {
				await first.result.error(new Error('Request failed'));
			}
			view.submit.fire('Next question');
			assert.deepStrictEqual(service.requests[1].messages, [{ role: 'user', content: 'Next question' }]);
		});
	}

	test('revoked workspace trust blocks both new attachments and retained source history', async () => {
		const attachment = { id: 'file', label: 'file.ts', content: 'private code' };
		await attach([attachment]);
		contextProvider.trusted = false;
		view.submit.fire('First question');
		assert.deepStrictEqual({ requests: service.requests.length, attachments: view.attachments, error: view.error }, {
			requests: 0, attachments: [attachment], error: 'Workspace is not trusted'
		});
		contextProvider.trusted = true;
		view.submit.fire('First question');
		const first = service.requests[0];
		service.deltas.fire({ requestId: first.id, text: 'Response' });
		await first.result.complete({ cancelled: false });
		contextProvider.trusted = false;
		view.submit.fire('Follow up');
		assert.deepStrictEqual({ requests: service.requests.length, error: view.error, attachments: view.attachments }, {
			requests: 1, error: 'Workspace is not trusted', attachments: []
		});
		view.newConversation.fire();
		view.submit.fire('Question without project context');
		assert.deepStrictEqual(service.requests[1].messages, [{ role: 'user', content: 'Question without project context' }]);
	});
	test('Ask mode never turns an edit-shaped response into a file change', async () => {
		await attach([editableAttachment]);
		view.submit.fire('Explain this code');
		const request = service.requests[0];
		const response = JSON.stringify({ edits: [{ attachment: 1, replacement: 'unrequested' }] });
		service.deltas.fire({ requestId: request.id, text: response });
		await request.result.complete({ cancelled: false });
		assert.deepStrictEqual({ mode: view.mode, proposals: view.proposals, prepared: editProvider.prepared, applications: editProvider.applications }, {
			mode: 'ask', proposals: [], prepared: [], applications: []
		});
	});

	test('Edit mode requires explicit attachments and preserves the unsent question', async () => {
		view.changeMode.fire('edit');
		view.submit.fire('Update the version');
		await settleEdits();
		assert.deepStrictEqual({ requests: service.requests.length, draft: view.draft, prepared: editProvider.prepared, proposals: view.proposals }, {
			requests: 0, draft: 'Update the version', prepared: [], proposals: []
		});
		assert.ok(view.error);
	});

	test('generated edits require a completed diff preview before acceptance', async () => {
		await generateEdits();
		const proposal = view.proposals[0];
		assert.deepStrictEqual({ status: proposal.status, reviewed: proposal.reviewed, applications: editProvider.applications }, {
			status: 'pending', reviewed: false, applications: []
		});
		view.reviewEdit.fire({ id: proposal.id, action: 'accept' });
		await settleEdits();
		assert.strictEqual(editProvider.applications.length, 0);
		view.reviewEdit.fire({ id: proposal.id, action: 'preview' });
		await settleEdits();
		view.reviewEdit.fire({ id: proposal.id, action: 'accept' });
		await settleEdits();
		assert.deepStrictEqual({ previews: editProvider.previews.length, applications: editProvider.applications.map(edit => edit.replacement), status: view.proposals[0].status }, {
			previews: 1, applications: ['const version = 2;'], status: 'accepted'
		});
	});

	test('rejecting an edit never applies it and allows another message', async () => {
		await generateEdits();
		view.submit.fire('Must wait for review');
		assert.strictEqual(service.requests.length, 1);
		view.reviewEdit.fire({ id: view.proposals[0].id, action: 'reject' });
		await settleEdits();
		view.changeMode.fire('ask');
		view.submit.fire('Continue the discussion');
		assert.deepStrictEqual({ applications: editProvider.applications, requests: service.requests.length }, { applications: [], requests: 2 });
	});

	test('failed acceptance keeps the proposal pending and preserves the error', async () => {
		await generateEdits();
		const id = view.proposals[0].id;
		view.reviewEdit.fire({ id, action: 'preview' });
		await settleEdits();
		const result = new DeferredPromise<void>();
		editProvider.applyResult = result.p;
		view.reviewEdit.fire({ id, action: 'accept' });
		await result.error(new Error('The file changed after attachment'));
		await settleEdits();
		assert.deepStrictEqual({ status: view.proposals[0].status, error: view.proposals[0].error, busy: view.busyEdits, applications: editProvider.applications.length }, {
			status: 'pending', error: 'The file changed after attachment', busy: false, applications: 1
		});
	});

	test('an unfinished or failed preview cannot authorize applying an edit', async () => {
		await generateEdits();
		const id = view.proposals[0].id;
		const result = new DeferredPromise<void>();
		editProvider.previewResult = result.p;
		view.reviewEdit.fire({ id, action: 'preview' });
		view.reviewEdit.fire({ id, action: 'accept' });
		await result.error(new Error('Preview is unavailable'));
		await settleEdits();
		view.reviewEdit.fire({ id, action: 'accept' });
		await settleEdits();
		assert.deepStrictEqual({ reviewed: view.proposals[0].reviewed, applications: editProvider.applications, status: view.proposals[0].status }, {
			reviewed: false, applications: [], status: 'pending'
		});
	});

	test('edit preparation blocks duplicate submissions and preserves snapshots on failure', async () => {
		view.changeMode.fire('edit');
		await attach([editableAttachment]);
		const result = new DeferredPromise<readonly ICloudCodeEditTarget[]>();
		editProvider.prepareResult = result.p;
		view.submit.fire('Update the version');
		view.submit.fire('Duplicate');
		assert.deepStrictEqual({ requests: service.requests.length, preparations: editProvider.prepared.length }, { requests: 0, preparations: 1 });
		await result.error(new Error('The attachment is stale'));
		await settleEdits();
		assert.deepStrictEqual({ requests: service.requests.length, draft: view.draft, attachments: view.attachments, busy: view.busyEdits }, {
			requests: 0, draft: 'Update the version', attachments: [editableAttachment], busy: false
		});
	});

	for (const reset of ['newChat', 'accountChange', 'signOut', 'dispose'] as const) {
		test(reset + ' ignores edit preparation from an earlier conversation', async () => {
			view.changeMode.fire('edit');
			await attach([editableAttachment]);
			const result = new DeferredPromise<readonly ICloudCodeEditTarget[]>();
			editProvider.prepareResult = result.p;
			view.submit.fire('Update the version');
			switch (reset) {
				case 'newChat': view.newConversation.fire(); break;
				case 'accountChange': service.stateEmitter.fire({ ...signedIn, account: { ...signedIn.account!, team: { id: 2, name: 'Other team' } } }); break;
				case 'signOut': view.signOut.fire(); break;
				case 'dispose': controller.dispose(); break;
			}
			await result.complete([{ token: '1', attachment: editableAttachment }]);
			await settleEdits();
			assert.deepStrictEqual({ requests: service.requests.length, proposals: view.proposals, applications: editProvider.applications }, {
				requests: 0, proposals: [], applications: []
			});
			if (reset === 'newChat') {
				assert.strictEqual(view.status, 'ready');
			}
		});
	}

	for (const outcome of ['cancelled', 'failed', 'malformed'] as const) {
		test(outcome + ' edit generation creates no actionable changes', async () => {
			view.changeMode.fire('edit');
			await attach([editableAttachment]);
			view.submit.fire('Update the version');
			await settleEdits();
			const request = service.requests[0];
			service.deltas.fire({ requestId: request.id, text: outcome === 'malformed' ? 'I will change the file.' : JSON.stringify({ edits: [{ attachment: 1, replacement: 'const version = 2;' }] }) });
			if (outcome === 'failed') {
				await request.result.error(new Error('Connection lost'));
			} else {
				if (outcome === 'cancelled') {
					view.stop.fire();
				}
				await request.result.complete({ cancelled: outcome === 'cancelled' });
			}
			await settleEdits();
			assert.deepStrictEqual({ proposals: view.proposals, applications: editProvider.applications }, { proposals: [], applications: [] });
		});
	}

	test('New Chat ignores a late diff preview and invalidates its review controls', async () => {
		await generateEdits();
		const id = view.proposals[0].id;
		const result = new DeferredPromise<void>();
		editProvider.previewResult = result.p;
		view.reviewEdit.fire({ id, action: 'preview' });
		view.newConversation.fire();
		await result.complete();
		await settleEdits();
		view.reviewEdit.fire({ id, action: 'accept' });
		await settleEdits();
		assert.deepStrictEqual({ proposals: view.proposals, applications: editProvider.applications }, { proposals: [], applications: [] });
	});

	test('accepted edits clear obsolete source history and edit requests use only fresh targets', async () => {
		await attach([editableAttachment]);
		view.submit.fire('Explain the current version');
		const first = service.requests[0];
		service.deltas.fire({ requestId: first.id, text: 'The version is one.' });
		await first.result.complete({ cancelled: false });
		await generateEdits();
		assert.strictEqual(service.requests[1].messages.length, 1);
		const id = view.proposals[0].id;
		view.reviewEdit.fire({ id, action: 'preview' });
		await settleEdits();
		view.reviewEdit.fire({ id, action: 'accept' });
		await settleEdits();
		view.changeMode.fire('ask');
		view.submit.fire('Start a fresh discussion');
		assert.deepStrictEqual(service.requests[2].messages, [{ role: 'user', content: 'Start a fresh discussion' }]);
	});

		test('Agent mode explores without attachments and presents progress without exposing protocol responses', async () => {
		view.changeMode.fire('agent');
		view.submit.fire('Find the sign-in handler');
		const request = agent.requests[0];
		request.onProgress('Searching for sign-in');
		request.onProgress('Reading auth.ts');
		assert.deepStrictEqual({
			prompt: request.prompt, attachments: request.attachments, model: request.model,
			status: view.status, requests: service.requests.length, activity: view.messages.at(-1)?.activity,
			text: view.messages.at(-1)?.text, progress: view.messages.at(-1)?.progress
		}, {
			prompt: 'Find the sign-in handler', attachments: [], model: 'model',
			status: 'running', requests: 0, activity: ['Searching for sign-in', 'Reading auth.ts'],
			text: '', progress: 'Reading auth.ts'
		});
		await request.result.complete({ text: 'The handler is in auth.ts.', attachments: [editableAttachment], edits: [] });
		await settleEdits();
		assert.deepStrictEqual({ text: view.messages.at(-1)?.text, progress: view.messages.at(-1)?.progress, attachments: view.messages.at(-1)?.attachments, status: view.status, proposals: view.proposals }, {
			text: 'The handler is in auth.ts.', progress: undefined, attachments: [editableAttachment], status: 'ready', proposals: []
		});
	});

	test('completed Agent answers retain discovered source for Ask follow-ups', async () => {
		view.changeMode.fire('agent');
		await attach([editableAttachment]);
		view.submit.fire('Explain this implementation');
		const request = agent.requests[0];
		assert.deepStrictEqual(request.attachments, [editableAttachment]);
		await request.result.complete({ text: 'The current version is one.', attachments: [editableAttachment], edits: [] });
		await settleEdits();
		view.changeMode.fire('ask');
		view.submit.fire('Why is it one?');
		assert.deepStrictEqual(service.requests[0].messages, [
			{ role: 'user', content: formatCloudCodePrompt('Explain this implementation', [editableAttachment]) },
			{ role: 'assistant', content: 'The current version is one.' },
			{ role: 'user', content: 'Why is it one?' }
		]);
	});

	test('Agent proposals require the existing preview and approval flow before applying source', async () => {
		view.changeMode.fire('agent');
		view.submit.fire('Find and fix the version');
		const edit = { target: { token: 'agent-target', attachment: editableAttachment }, replacement: 'const version = 2;' };
		await agent.requests[0].result.complete({ text: 'I found the version.', attachments: [editableAttachment], edits: [edit] });
		await settleEdits();
		const id = view.proposals[0].id;
		view.reviewEdit.fire({ id, action: 'accept' });
		await settleEdits();
		assert.strictEqual(editProvider.applications.length, 0);
		view.reviewEdit.fire({ id, action: 'preview' });
		await settleEdits();
		view.reviewEdit.fire({ id, action: 'accept' });
		await settleEdits();
		assert.deepStrictEqual({ applications: editProvider.applications.map(value => value.replacement), status: view.proposals[0].status }, {
			applications: ['const version = 2;'], status: 'accepted'
		});
	});

	test('Stop cancels Agent work and prevents another task until resource cleanup finishes', async () => {
		view.changeMode.fire('agent');
		view.submit.fire('First task');
		const request = agent.requests[0];
		request.onProgress('Reading main.ts');
		view.stop.fire();
		request.onProgress('This late progress must be ignored');
		view.submit.fire('Too early');
		assert.deepStrictEqual({ cancelled: request.token.isCancellationRequested, requests: agent.requests.length, activity: view.messages.at(-1)?.activity, text: view.messages.at(-1)?.text, progress: view.messages.at(-1)?.progress }, {
			cancelled: true, requests: 1, activity: ['Reading main.ts'], text: 'Agent stopped. No changes were applied.', progress: undefined
		});
		await request.result.complete({ text: 'Late answer', attachments: [editableAttachment], edits: [{ target: { token: 'late', attachment: editableAttachment }, replacement: 'late edit' }] });
		await settleEdits();
		assert.deepStrictEqual({ proposals: view.proposals, incomplete: view.messages.at(-1)?.incomplete, progress: view.messages.at(-1)?.progress, status: view.status }, { proposals: [], incomplete: true, progress: undefined, status: 'ready' });
		view.changeMode.fire('ask');
		view.submit.fire('Fresh question');
		assert.deepStrictEqual(service.requests[0].messages, [{ role: 'user', content: 'Fresh question' }]);
	});

	for (const reset of ['newChat', 'accountChange', 'signOut', 'dispose'] as const) {
		test(reset + ' cancels Agent work and suppresses late progress, answers and proposals', async () => {
			view.changeMode.fire('agent');
			view.submit.fire('Read private project context');
			const request = agent.requests[0];
			switch (reset) {
				case 'newChat': view.newConversation.fire(); break;
				case 'accountChange': service.stateEmitter.fire({ ...signedIn, account: { ...signedIn.account!, team: { id: 2, name: 'Other team' } } }); break;
				case 'signOut': view.signOut.fire(); break;
				case 'dispose': controller.dispose(); break;
			}
			const messages = view.messages;
			request.onProgress('Private filename');
			await request.result.complete({ text: 'Private answer', attachments: [editableAttachment], edits: [{ target: { token: 'private', attachment: editableAttachment }, replacement: 'private edit' }] });
			await settleEdits();
			assert.deepStrictEqual({ cancelled: request.token.isCancellationRequested, messages: view.messages, proposals: view.proposals, applications: editProvider.applications }, {
				cancelled: true, messages, proposals: [], applications: []
			});
		});
	}

	test('a failed Agent run shows the failure and excludes discovered source from future history', async () => {
		view.changeMode.fire('agent');
		view.submit.fire('Find the handler');
		const request = agent.requests[0];
		request.onProgress('Reading auth.ts');
		await request.result.error(new Error('The workspace changed'));
		await settleEdits();
		assert.deepStrictEqual({ error: view.error, incomplete: view.messages.at(-1)?.incomplete, progress: view.messages.at(-1)?.progress, proposals: view.proposals, status: view.status }, {
			error: 'The workspace changed', incomplete: true, progress: undefined, proposals: [], status: 'ready'
		});
		view.changeMode.fire('ask');
		view.submit.fire('Next question');
		assert.deepStrictEqual(service.requests[0].messages, [{ role: 'user', content: 'Next question' }]);
	});

	test('an account switch reloads models after the cancelled Agent releases its resources', async () => {
		view.changeMode.fire('agent');
		view.submit.fire('First team task');
		const request = agent.requests[0];
		service.modelResult = Promise.resolve([{ id: 'new-team-model', name: 'New Team Model' }]);
		service.stateEmitter.fire({ ...signedIn, account: { ...signedIn.account!, team: { id: 2, name: 'Other team' } } });
		await request.result.complete({ text: 'Old account answer', attachments: [], edits: [] });
		await settleEdits();
		assert.deepStrictEqual({ models: view.models, status: view.status, messages: view.messages }, {
			models: [{ id: 'new-team-model', name: 'New Team Model' }], status: 'ready', messages: []
		});
		view.submit.fire('New team task');
		assert.strictEqual(agent.requests[1].model, 'new-team-model');
		await agent.requests[1].result.complete({ text: 'New team answer', attachments: [], edits: [] });
		await settleEdits();
	});

});

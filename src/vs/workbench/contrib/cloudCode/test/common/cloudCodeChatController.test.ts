/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLOUDCODE_MAX_MESSAGE_LENGTH, ICloudCodeChatDelta, ICloudCodeMessage, ICloudCodeModel, ICloudCodeService, ICloudCodeState } from '../../../../../platform/cloudCode/common/cloudCode.js';
import { CloudCodeChatStatus, ICloudCodeChatMessage, ICloudCodeChatView } from '../../common/cloudCodeChat.js';
import { CloudCodeChatController } from '../../common/cloudCodeChatController.js';
import { formatCloudCodePrompt, ICloudCodeAttachment, ICloudCodeContextProvider } from '../../common/cloudCodeChatContext.js';

class TestView extends Disposable implements ICloudCodeChatView {
	readonly requestAttachments = this._register(new Emitter<void>());
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

	setup(async () => {
		service = disposables.add(new TestService());
		view = disposables.add(new TestView());
		contextProvider = new TestContextProvider();
		controller = disposables.add(new CloudCodeChatController(view, contextProvider, service));
		await controller.initialize();
	});

	async function attach(attachments: readonly ICloudCodeAttachment[]): Promise<void> {
		const result = new DeferredPromise<readonly ICloudCodeAttachment[]>();
		contextProvider.result = result.p;
		view.requestAttachments.fire();
		await result.complete(attachments);
		await Promise.resolve();
	}

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
});

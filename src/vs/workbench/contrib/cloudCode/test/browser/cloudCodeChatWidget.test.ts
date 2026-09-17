/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService, IFileStatWithPartialMetadata } from '../../../../../platform/files/common/files.js';
import { IWorkspace, IWorkspaceContextService, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { CloudCodeAttachmentInput } from '../../browser/cloudCodeAttachmentInput.js';
import { CloudCodeChatWidget } from '../../browser/cloudCodeChatWidget.js';
import { CloudCodeComposer } from '../../browser/cloudCodeComposer.js';
import { CloudCodeContext } from '../../browser/cloudCodeContext.js';
import { ICloudCodeAttachment, mergeCloudCodeAttachments } from '../../common/cloudCodeChatContext.js';
import { CloudCodeEditingSessionAction, ICloudCodeEditingSessionView } from '../../common/cloudCodeEditingSession.js';

suite('CloudCode inline composer', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const first: ICloudCodeAttachment = { id: 'first', label: 'file.json', content: '{}' };
	const second: ICloudCodeAttachment = { id: 'second', label: 'file2.json', content: '{}' };
	let composer: CloudCodeComposer;
	let attachments: readonly ICloudCodeAttachment[];

	setup(() => {
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		disposables.add(toDisposable(() => parent.remove()));
		composer = disposables.add(new CloudCodeComposer(parent));
		attachments = [];
		disposables.add(composer.onDidChangeAttachments(next => { attachments = next; composer.setAttachments(next, false); }));
	});

	test('inserts chips at the caret between ordinary text and restores their positions', () => {
		composer.setAttachments([first], false);
		composer.insertText('-- work with this file then this ');
		composer.markInsertionPoint();
		composer.setAttachments([first, second], false);
		const text = composer.value;
		const references = composer.references;
		composer.setValue(text, references);
		assert.deepStrictEqual({ text: composer.value, references: composer.references, tokens: composer.domNode.querySelectorAll('[contenteditable="false"]').length }, {
			text: '[file.json] -- work with this file then this [file2.json] ', references, tokens: 2
		});
	});

	test('inserts into the middle of existing text and keeps the second half', () => {
		composer.setValue('Please review and fix this.');
		const range = document.createRange();
		range.setStart(composer.domNode.firstChild!, 14); range.collapse(true);
		document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
		// Selection changes are delivered asynchronously; insertion must read the current range.
		composer.setAttachments([first], false);
		assert.strictEqual(composer.value, 'Please review [file.json] and fix this.');
	});

	test('replacing a selected token removes its snapshot from the outgoing attachments', () => {
		attachments = [first];
		composer.setAttachments(attachments, false);
		const range = document.createRange();
		range.selectNodeContents(composer.domNode);
		document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
		composer.markInsertionPoint();
		composer.setAttachments([first, second], false);
		assert.deepStrictEqual({ text: composer.value, attachments }, { text: '[file2.json] ', attachments: [second] });
	});

	test('removing a chip and undo/redo keep the actual attachment list in sync', () => {
		attachments = [first];
		composer.setAttachments(attachments, false);
		composer.domNode.querySelector<HTMLButtonElement>('.cloudcode-chat-attachment-remove')!.click();
		assert.deepStrictEqual(attachments, []);
		composer.domNode.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
		assert.deepStrictEqual({ text: composer.value, attachments }, { text: '[file.json] ', attachments: [first] });
		composer.domNode.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true }));
		assert.deepStrictEqual({ text: composer.value, attachments }, { text: ' ', attachments: [] });
	});

	test('plain text is never interpreted as HTML and a new draft clears undo history', () => {
		composer.insertText('<img src=x onerror=alert(1)>\nSecond line');
		assert.deepStrictEqual({ text: composer.value, images: composer.domNode.querySelectorAll('img').length }, { text: '<img src=x onerror=alert(1)>\nSecond line', images: 0 });
		composer.setValue('New chat');
		composer.domNode.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
		assert.strictEqual(composer.value, 'New chat');
	});
});

suite('CloudCodeChatWidget thinking state', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let widget: CloudCodeChatWidget;

	setup(() => {
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		disposables.add(toDisposable(() => parent.remove()));
		widget = disposables.add(new CloudCodeChatWidget(parent));
		widget.setSession({ status: 'signedIn' });
		widget.setModels([{ id: 'model', name: 'Model' }], 'model', false);
		widget.setStatus('ready');
	});

	test('starts in Agent mode', () => {
		assert.strictEqual(widget.domNode.querySelector('.cloudcode-chat-mode')?.textContent, 'Agent');
	});

	const task: ICloudCodeEditingSessionView = {
		id: 'task', status: 'pending', reviewed: false, changes: [
			{ kind: 'edit', path: 'main.ts' }, { kind: 'create', path: 'new.ts' },
			{ kind: 'rename', path: 'old.ts', newPath: 'renamed.ts' }, { kind: 'delete', path: 'unused.ts' }
		]
	};

	function taskButton(action: CloudCodeEditingSessionAction): HTMLElement {
		return widget.domNode.querySelector<HTMLElement>(`[data-session-action="${action}"]`)!;
	}

	test('task review shows a combined file list, gates acceptance and blocks sending until reviewed', () => {
		const actions: string[] = [];
		const prompts: string[] = [];
		disposables.add(widget.onDidReviewEditingSession(event => actions.push(event.action)));
		disposables.add(widget.onDidSubmit(prompt => prompts.push(prompt)));
		widget.setDraft('Follow up');
		widget.setEditingSessions([task], false);
		taskButton('accept').click();
		taskButton('preview').click();
		widget.domNode.querySelector<HTMLElement>('[role="textbox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		assert.deepStrictEqual({ files: Array.from(widget.domNode.querySelectorAll('.cloudcode-chat-task-files li')).map(file => file.textContent), actions, prompts, acceptDisabled: taskButton('accept').getAttribute('aria-disabled') }, {
			files: ['Editmain.ts', 'Createnew.ts', 'Renameold.ts → renamed.ts', 'Deleteunused.ts'], actions: ['preview'], prompts: [], acceptDisabled: 'true'
		});
		widget.setEditingSessions([{ ...task, reviewed: true }], false);
		taskButton('accept').click();
		assert.deepStrictEqual(actions, ['preview', 'accept']);
	});

	test('busy task review disables all review actions without losing its visible files', () => {
		const actions: string[] = [];
		disposables.add(widget.onDidReviewEditingSession(event => actions.push(event.action)));
		widget.setEditingSessions([{ ...task, reviewed: true }], true);
		for (const action of ['preview', 'accept', 'reject'] as const) {
			taskButton(action).click();
		}
		widget.setEditProposals([], false);
		assert.deepStrictEqual({ actions, count: widget.domNode.querySelectorAll('.cloudcode-chat-task-files li').length, busy: widget.domNode.querySelector('.cloudcode-chat-editing-sessions')?.getAttribute('aria-busy'), acceptDisabled: taskButton('accept').getAttribute('aria-disabled') }, {
			actions: [], count: 4, busy: 'true', acceptDisabled: 'true'
		});
	});

	test('task review restores keyboard focus after busy updates without stealing it from the diff editor', () => {
		widget.setEditingSessions([task], false);
		taskButton('preview').focus();
		widget.setEditingSessions([task], true);
		widget.setEditingSessions([{ ...task, reviewed: true }], false);
		assert.strictEqual(document.activeElement, taskButton('preview'));
		widget.setEditingSessions([task], true);
		const editor = document.createElement('button');
		document.body.appendChild(editor);
		disposables.add(toDisposable(() => editor.remove()));
		editor.focus();
		widget.setEditingSessions([{ ...task, reviewed: true }], false);
		assert.strictEqual(document.activeElement, editor);
	});

	test('partial and applied task outcomes retain Undo and allow a followup', () => {
		const actions: string[] = [];
		const prompts: string[] = [];
		disposables.add(widget.onDidReviewEditingSession(event => actions.push(event.action)));
		disposables.add(widget.onDidSubmit(prompt => prompts.push(prompt)));
		widget.setEditingSessions([{ ...task, status: 'partial', reviewed: true, error: 'Some changes could not be applied' }], false);
		const partialHint = widget.domNode.querySelector('.cloudcode-chat-editing-session .cloudcode-chat-hint')?.textContent;
		taskButton('undo').click();
		widget.setDraft('Inspect current files');
		widget.domNode.querySelector<HTMLElement>('[role="textbox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		widget.setEditingSessions([{ ...task, status: 'applied', reviewed: true }], false);
		assert.deepStrictEqual({ partialHint, actions, prompts, accept: widget.domNode.querySelector('[data-session-action="accept"]'), undoDisabled: taskButton('undo').getAttribute('aria-disabled') }, {
			partialHint: 'Some changes were applied. You can undo this task or continue from the current files.', actions: ['undo'], prompts: ['Inspect current files'], accept: null, undoDisabled: 'false'
		});
		widget.setSession({ status: 'signedOut' });
		taskButton('undo').click();
		assert.deepStrictEqual(actions, ['undo']);
	});

	test('task paths and errors render as text and rejected tasks have no live actions', () => {
		widget.setEditingSessions([{ ...task, changes: [{ kind: 'create', path: '<img src=x onerror=alert(1)>' }], error: '<script>bad()</script>' }], false);
		assert.deepStrictEqual({ images: widget.domNode.querySelectorAll('.cloudcode-chat-editing-sessions img').length, path: widget.domNode.querySelector('.cloudcode-chat-task-path')?.textContent, error: widget.domNode.querySelector('.cloudcode-chat-editing-session .cloudcode-chat-error')?.textContent }, {
			images: 0, path: '<img src=x onerror=alert(1)>', error: '<script>bad()</script>'
		});
		widget.setEditingSessions([{ ...task, status: 'rejected' }], false);
		assert.strictEqual(widget.domNode.querySelectorAll('[data-session-action]').length, 0);
	});

	test('dropping HTML inserts only its plain text', () => {
		widget.setDraft('');
		const data = new DataTransfer();
		data.setData('text/html', '<img src="https://example.com/image.png">');
		data.setData('text/plain', 'Copied text');
		const event = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
		widget.domNode.querySelector('[role="textbox"]')!.dispatchEvent(event);
		assert.deepStrictEqual({ text: widget.getDraft(), images: widget.domNode.querySelectorAll('img').length, prevented: event.defaultPrevented }, { text: 'Copied text', images: 0, prevented: true });
	});

	test('selects conversation tabs with click and arrow keys, retaining focus after updates', () => {
		const chats = [{ id: 'first', title: 'Review package.json' }, { id: 'second', title: 'Fix the build' }];
		const selected: string[] = [];
		disposables.add(widget.onDidSelectConversation(id => { selected.push(id); widget.setConversations(chats, id); }));
		widget.setConversations(chats, 'second');
		widget.titleControl.querySelector<HTMLButtonElement>('[data-chat-id="first"]')!.click();
		const first = widget.titleControl.querySelector<HTMLButtonElement>('[data-chat-id="first"]')!;
		first.focus();
		first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		assert.deepStrictEqual({ selected, focused: document.activeElement?.textContent, tabs: Array.from(widget.titleControl.querySelectorAll('[role="tab"]')).map(tab => tab.getAttribute('aria-selected')) }, {
			selected: ['first', 'second'], focused: 'Fix the build', tabs: ['false', 'true']
		});
	});

	test('shows compact attachment chips inside the composer with preview and remove actions', () => {
		const removed: string[] = [];
		disposables.add(widget.onDidChangeDraftAttachments(attachments => { if (!attachments.length) { removed.push('file'); } }));
		widget.setAttachments([{ id: 'file', label: 'package.json', content: '{"private":true}', resource: 'file:///project/package.json' }], false);
		const chip = widget.domNode.querySelector<HTMLElement>('.cloudcode-chat-input .cloudcode-chat-attachment-chip')!;
		const preview = widget.domNode.querySelector<HTMLElement>('.cloudcode-chat-chip-preview')!;
		assert.strictEqual(preview.hidden, true);
		chip.click();
		chip.querySelector<HTMLButtonElement>('.cloudcode-chat-attachment-remove')!.click();
		assert.deepStrictEqual({ removed, previewHidden: preview.hidden, expanded: preview.querySelector('details')?.open, contents: preview.textContent?.includes('{"private":true}') }, { removed: ['file'], previewHidden: false, expanded: true, contents: true });
	});

	test('Enter on a file token opens its preview without sending the message', () => {
		let submitted = false;
		disposables.add(widget.onDidSubmit(() => submitted = true));
		widget.setAttachments([{ id: 'file', label: 'file.json', content: '{}' }], false);
		widget.domNode.querySelector<HTMLElement>('.cloudcode-chat-attachment-chip')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		assert.deepStrictEqual({ submitted, previewHidden: widget.domNode.querySelector<HTMLElement>('.cloudcode-chat-chip-preview')!.hidden }, { submitted: false, previewHidden: false });
	});

	test('file reference chips show an on-demand preview rather than an empty file', () => {
		widget.setAttachments([{ id: 'lock', label: 'package-lock.json', resource: 'file:///project/package-lock.json', content: '', reference: true }], false);
		widget.domNode.querySelector<HTMLElement>('.cloudcode-chat-attachment-chip')!.click();
		const preview = widget.domNode.querySelector<HTMLElement>('.cloudcode-chat-chip-preview')!;
		assert.deepStrictEqual({ label: preview.querySelector('summary')?.textContent, body: preview.querySelector('p')?.textContent, source: preview.querySelector('pre'), draft: widget.getDraft() }, {
			label: 'package-lock.json', body: 'Attached by reference. Agent reads relevant sections as needed.', source: null, draft: '[package-lock.json] '
		});
	});

	test('shows thinking until the first answer text while preserving the streamed text node', () => {
		widget.setMessages([{ role: 'user', text: 'Review package.json' }, { role: 'assistant', text: '' }]);
		const thinking = widget.domNode.querySelector<HTMLElement>('.cloudcode-chat-thinking')!;
		assert.strictEqual(thinking.hidden, true);
		widget.setStatus('running');
		assert.deepStrictEqual({ hidden: thinking.hidden, label: thinking.getAttribute('aria-label'), dots: thinking.querySelectorAll('.cloudcode-chat-thinking-dots span').length }, {
			hidden: false, label: 'Thinking', dots: 3
		});
		widget.appendResponse(' ');
		assert.strictEqual(thinking.hidden, false);
		widget.appendResponse('This project');
		const body = thinking.nextElementSibling!;
		const text = body.firstChild;
		widget.appendResponse(' uses TypeScript.');
		assert.deepStrictEqual({ hidden: thinking.hidden, content: body.textContent, sameNode: text === body.firstChild }, {
			hidden: true, content: ' This project uses TypeScript.', sameNode: true
		});
	});

	test('renders Agent activity as progress and removes it when the answer arrives', () => {
		widget.setStatus('running');
		widget.setMessages([{ role: 'assistant', text: '', progress: 'Reading package.json' }]);
		const thinking = widget.domNode.querySelector<HTMLElement>('.cloudcode-chat-thinking')!;
		assert.deepStrictEqual({ hidden: thinking.hidden, label: thinking.getAttribute('aria-label') }, { hidden: false, label: 'Reading package.json' });
		widget.setMessages([{ role: 'assistant', text: 'The file contains three scripts.' }]);
		widget.setStatus('ready');
		assert.strictEqual(widget.domNode.querySelector('.cloudcode-chat-thinking'), null);
	});

	test('does not leave thinking active after stopping, errors, or clearing the conversation', () => {
		widget.setMessages([{ role: 'assistant', text: '' }]);
		widget.setStatus('running');
		widget.setStatus('ready');
		assert.strictEqual(widget.domNode.querySelector<HTMLElement>('.cloudcode-chat-thinking')?.hidden, true);
		widget.setMessages([{ role: 'assistant', text: '', progress: 'Reading a file', incomplete: true }]);
		widget.setStatus('running');
		assert.strictEqual(widget.domNode.querySelector('.cloudcode-chat-thinking'), null);
		widget.setError('Request failed');
		widget.setStatus('ready');
		widget.setMessages([]);
		assert.strictEqual(widget.domNode.querySelector('.cloudcode-chat-thinking'), null);
	});
});

suite('CloudCodeChatWidget attachments', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const resource = URI.file('/project/unsaved.ts');
	const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=';
	let widget: CloudCodeChatWidget;
	let prompt: HTMLElement;
	let clipboardResources: URI[];
	let attachments: readonly ICloudCodeAttachment[];
	let completion: Promise<void>;
	let largeFileContent: string;

	setup(() => {
		clipboardResources = [];
		attachments = [];
		completion = Promise.resolve();
		largeFileContent = '{\n"lockfileVersion": 3,\n' + '"dependency": {},\n'.repeat(45000) + '}';
		const model = disposables.add(createTextModel('unsaved changes', 'typescript', undefined, resource));
		const context = new CloudCodeContext(
			upcastPartial<IEditorService>({}),
			upcastPartial<IModelService>({ getModel: uri => uri.toString() === resource.toString() ? model : null }),
			upcastPartial<ITextFileService>({ read: async () => { throw new Error('Large file contents must not be copied when attaching'); } }),
			upcastPartial<IFileService>({ stat: async uri => {
				assert.strictEqual(uri.path, '/project/package-lock.json');
				return upcastPartial<IFileStatWithPartialMetadata>({ resource: uri, name: 'package-lock.json', isFile: true, isDirectory: false, isSymbolicLink: false, size: new TextEncoder().encode(largeFileContent).byteLength });
			} }),
			upcastPartial<IFileDialogService>({}),
			upcastPartial<IWorkspaceContextService>({
				getWorkspaceFolder: () => toWorkspaceFolder(URI.file('/project')),
				getWorkspace: () => upcastPartial<IWorkspace>({ folders: [toWorkspaceFolder(URI.file('/project'))] }),
			}),
			upcastPartial<IWorkspaceTrustManagementService>({ isWorkspaceTrusted: () => true }),
		);
		const input = new CloudCodeAttachmentInput(context, upcastPartial<IClipboardService>({
			readResources: async () => clipboardResources,
			readImage: async () => new Uint8Array(),
		}));
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		disposables.add(toDisposable(() => parent.remove()));
		widget = disposables.add(new CloudCodeChatWidget(parent, undefined, undefined, input));
		widget.setSession({ status: 'signedIn' });
		widget.setModels([{ id: 'model', name: 'Model' }], 'model', false);
		widget.setStatus('ready');
		prompt = widget.domNode.querySelector<HTMLElement>('[role="textbox"]')!;
		disposables.add(widget.onDidRequestAttachments(read => {
			widget.setAttachments(attachments, true);
			completion = (async () => {
				attachments = mergeCloudCodeAttachments(attachments, await read!());
				widget.setAttachments(attachments, false);
			})();
		}));
	});

	test('pastes an image as an inline removable token', async () => {
		const data = new DataTransfer();
		data.items.add(new File([Uint8Array.from(decodeBase64(png).buffer)], 'Screenshot.png', { type: 'image/png' }));
		prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
		await completion;
		const image = widget.domNode.querySelector('img')!;
		assert.deepStrictEqual({ text: widget.getDraft(), label: image.alt, url: image.src, count: attachments.length }, {
			text: '[Screenshot.png] ', label: 'Screenshot.png', url: `data:image/png;base64,${png}`, count: 1
		});
		assert.ok(widget.domNode.querySelector('[aria-label="Remove Screenshot.png"]'));
	});

	test('Explorer drop uses unsaved contents and prevents the default editor drop', async () => {
		const data = new DataTransfer();
		data.setData('ResourceURLs', JSON.stringify([resource.toString()]));
		const event = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
		prompt.dispatchEvent(event);
		await completion;
		assert.deepStrictEqual({ prevented: event.defaultPrevented, content: attachments[0]?.content, resource: attachments[0]?.resource }, {
			prevented: true, content: 'unsaved changes', resource: resource.toString()
		});
	});

	test('Explorer drops and clipboard resources attach large lockfiles inline without reading the full file', async () => {
		const lockfile = URI.file('/project/package-lock.json');
		const data = new DataTransfer();
		data.setData('ResourceURLs', JSON.stringify([lockfile.toString()]));
		prompt.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
		await completion;
		assert.deepStrictEqual({ draft: widget.getDraft(), reference: attachments[0]?.reference, content: attachments[0]?.content }, { draft: '[package-lock.json] ', reference: true, content: '' });
		clipboardResources = [lockfile];
		prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }));
		await completion;
		assert.strictEqual(attachments.length, 1);
	});

	test('copied Explorer resources attach while ordinary text replaces the selected text', async () => {
		clipboardResources = [resource];
		const data = new DataTransfer();
		data.setData('text/plain', 'unsaved.ts');
		prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
		await completion;
		assert.deepStrictEqual({ count: attachments.length, text: widget.getDraft() }, { count: 1, text: '[unsaved.ts] ' });
		clipboardResources = [];
		attachments = [];
		widget.setAttachments([], false);
		widget.setDraft('Hello world');
		const range = document.createRange();
		range.setStart(prompt.firstChild!, 6); range.setEnd(prompt.firstChild!, 11);
		document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
		data.setData('text/plain', 'CloudCode');
		prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
		await completion;
		assert.strictEqual(widget.getDraft(), 'Hello CloudCode');
	});

	test('a delayed text paste cannot change a reset draft', async () => {
		const data = new DataTransfer();
		data.setData('text/plain', 'old clipboard');
		prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
		widget.setDraft('New conversation');
		await completion;
		assert.strictEqual(widget.getDraft(), 'New conversation');
	});
});

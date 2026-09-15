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
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { CloudCodeAttachmentInput } from '../../browser/cloudCodeAttachmentInput.js';
import { CloudCodeChatWidget } from '../../browser/cloudCodeChatWidget.js';
import { CloudCodeContext } from '../../browser/cloudCodeContext.js';
import { ICloudCodeAttachment, mergeCloudCodeAttachments } from '../../common/cloudCodeChatContext.js';

suite('CloudCodeChatWidget attachments', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const resource = URI.file('/project/unsaved.ts');
	const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=';
	let widget: CloudCodeChatWidget;
	let prompt: HTMLTextAreaElement;
	let clipboardResources: URI[];
	let attachments: readonly ICloudCodeAttachment[];
	let completion: Promise<void>;

	setup(() => {
		clipboardResources = [];
		attachments = [];
		completion = Promise.resolve();
		const model = disposables.add(createTextModel('unsaved changes', 'typescript', undefined, resource));
		const context = new CloudCodeContext(
			upcastPartial<IEditorService>({}),
			upcastPartial<IModelService>({ getModel: uri => uri.toString() === resource.toString() ? model : null }),
			upcastPartial<ITextFileService>({}),
			upcastPartial<IFileService>({ stat: async () => { throw new Error('Must use the editor buffer'); } }),
			upcastPartial<IFileDialogService>({}),
			upcastPartial<IWorkspaceContextService>({ getWorkspaceFolder: () => null }),
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
		prompt = widget.domNode.querySelector('textarea')!;
		disposables.add(widget.onDidRequestAttachments(read => {
			widget.setAttachments(attachments, true);
			completion = (async () => {
				attachments = mergeCloudCodeAttachments(attachments, await read!());
				widget.setAttachments(attachments, false);
			})();
		}));
	});

	test('pastes an image as a removable preview without inserting a filename', async () => {
		const data = new DataTransfer();
		data.items.add(new File([Uint8Array.from(decodeBase64(png).buffer)], 'Screenshot.png', { type: 'image/png' }));
		prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
		await completion;
		const image = widget.domNode.querySelector('img')!;
		assert.deepStrictEqual({ text: prompt.value, label: image.alt, url: image.src, count: attachments.length }, {
			text: '', label: 'Screenshot.png', url: `data:image/png;base64,${png}`, count: 1
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

	test('copied Explorer resources attach while ordinary text replaces the selected text', async () => {
		clipboardResources = [resource];
		const data = new DataTransfer();
		data.setData('text/plain', 'unsaved.ts');
		prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
		await completion;
		assert.deepStrictEqual({ count: attachments.length, text: prompt.value }, { count: 1, text: '' });
		clipboardResources = [];
		widget.setDraft('Hello world');
		prompt.setSelectionRange(6, 11);
		data.setData('text/plain', 'CloudCode');
		prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
		await completion;
		assert.strictEqual(prompt.value, 'Hello CloudCode');
	});

	test('a delayed text paste cannot change a reset draft', async () => {
		const data = new DataTransfer();
		data.setData('text/plain', 'old clipboard');
		prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
		widget.setDraft('New conversation');
		await completion;
		assert.strictEqual(prompt.value, 'New conversation');
	});
});

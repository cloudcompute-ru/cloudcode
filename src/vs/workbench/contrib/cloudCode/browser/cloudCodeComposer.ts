/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { cloudCodeImageBytes } from '../../../../platform/cloudCode/common/cloudCodeImages.js';
import { ICloudCodeDraftReference } from '../common/cloudCodeChat.js';
import { ICloudCodeAttachment } from '../common/cloudCodeChatContext.js';

interface IDraft {
	readonly text: string;
	readonly references: readonly ICloudCodeDraftReference[];
}

/** Plain text and atomic file tokens, with a draft-local undo history. Never accepts pasted HTML. */
export class CloudCodeComposer extends Disposable {
	readonly domNode: HTMLElement;
	private readonly changeEmitter = this._register(new Emitter<void>());
	readonly onDidChange = this.changeEmitter.event;
	private readonly attachmentsEmitter = this._register(new Emitter<readonly ICloudCodeAttachment[]>());
	readonly onDidChangeAttachments = this.attachmentsEmitter.event;
	private readonly previewEmitter = this._register(new Emitter<ICloudCodeAttachment>());
	readonly onDidPreview = this.previewEmitter.event;
	private attachments: readonly ICloudCodeAttachment[] = [];
	private catalog = new Map<string, ICloudCodeAttachment>();
	private selection: Range | undefined;
	private insertionPoint: Range | undefined;
	private history: IDraft[] = [{ text: '', references: [] }];
	private historyIndex = 0;

	constructor(parent: HTMLElement) {
		super();
		this.domNode = dom.append(parent, dom.$('.cloudcode-chat-prompt', { contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': localize('cloudcode.message', "Message"), spellcheck: 'false' }));
		this._register(dom.addDisposableListener(this.domNode.ownerDocument, 'selectionchange', () => this.rememberSelection()));
		this._register(dom.addDisposableListener(this.domNode, 'input', () => this.changed(true)));
		this._register(dom.addDisposableListener(this.domNode, 'beforeinput', (event: InputEvent) => {
			if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
				event.preventDefault();
				this.undo(event.inputType === 'historyRedo');
			}
		}));
		this._register(dom.addDisposableListener(this.domNode, 'keydown', (event: KeyboardEvent) => {
			if (event.isComposing) { return; }
			if (dom.isHTMLElement(event.target) && event.target !== this.domNode && ['Enter', ' '].includes(event.key)) {
				event.preventDefault(); event.stopPropagation();
				event.target.click();
				return;
			}
			if ((event.ctrlKey || event.metaKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
				event.preventDefault(); event.stopPropagation();
				this.undo(event.shiftKey || event.key.toLowerCase() === 'y');
			} else if (event.key === 'Enter' && event.shiftKey) {
				event.preventDefault();
				this.insertText('\n');
			}
		}));
		for (const type of ['copy', 'cut']) {
			this._register(dom.addDisposableListener(this.domNode, type, (event: ClipboardEvent) => {
				this.rememberSelection();
				const range = this.currentSelection();
				if (range.collapsed || !event.clipboardData) { return; }
				event.preventDefault();
				event.clipboardData.setData('text/plain', this.read(range.cloneContents()).text);
				if (type === 'cut') { this.insertText(''); }
			}));
		}
		this._register(dom.addDisposableListener(this.domNode, 'click', (event: MouseEvent) => {
			let target = dom.isHTMLElement(event.target) ? event.target : null;
			let remove = false;
			while (target && target !== this.domNode) {
				remove ||= target.classList.contains('cloudcode-chat-attachment-remove');
				const id = target.getAttribute('data-attachment-id');
				if (id) {
					const attachment = this.catalog.get(id);
					if (remove) {
						target.remove();
						this.changed(true);
					} else if (attachment) { this.previewEmitter.fire(attachment); }
					return;
				}
				target = target.parentElement;
			}
		}));
	}

	get value(): string { return this.read().text; }
	get references(): readonly ICloudCodeDraftReference[] { return this.read().references; }
	set placeholder(value: string) { this.domNode.dataset.placeholder = value; }
	focus(): void { this.domNode.focus(); }

	rememberSelection(): void {
		const selection = this.domNode.ownerDocument.getSelection();
		if (selection?.rangeCount && this.domNode.contains(selection.getRangeAt(0).commonAncestorContainer)) {
			this.selection = selection.getRangeAt(0).cloneRange();
		}
	}

	markInsertionPoint(): void {
		this.rememberSelection();
		this.insertionPoint = this.currentSelection();
	}

	/** Capture the actual drop point rather than appending the file after the message. */
	setDropPosition(x: number, y: number): void {
		const range = this.domNode.ownerDocument.caretRangeFromPoint(x, y);
		if (range && this.domNode.contains(range.startContainer)) {
			this.selection = range.cloneRange();
			this.selection.collapse(true);
		}
		this.insertionPoint = this.currentSelection();
	}

	private currentSelection(): Range {
		if (this.selection && this.domNode.contains(this.selection.commonAncestorContainer)) { return this.selection.cloneRange(); }
		const range = this.domNode.ownerDocument.createRange();
		range.selectNodeContents(this.domNode);
		range.collapse(false);
		return range;
	}

	insertText(text: string): void {
		this.rememberSelection();
		if (this.insertionPoint && this.domNode.contains(this.insertionPoint.commonAncestorContainer)) { this.selection = this.insertionPoint; }
		this.insertionPoint = undefined;
		const node = this.domNode.ownerDocument.createTextNode(text);
		this.insert(node);
		this.changed(true);
	}

	private insert(node: Node): void {
		const range = this.currentSelection();
		range.deleteContents();
		range.insertNode(node);
		range.setStartAfter(node);
		range.collapse(true);
		this.selection = range;
		const selection = this.domNode.ownerDocument.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}

	setValue(text: string, references: readonly ICloudCodeDraftReference[] = []): void {
		this.insertionPoint = undefined;
		this.catalog = new Map(this.attachments.map(attachment => [attachment.id, attachment]));
		this.render({ text, references });
		this.history = [this.read()];
		this.historyIndex = 0;
	}

	/** Reconcile controller-owned snapshots while leaving the caret and existing tokens in place. */
	setAttachments(attachments: readonly ICloudCodeAttachment[], loading: boolean): void {
		this.attachments = attachments;
		for (const attachment of attachments) { this.catalog.set(attachment.id, attachment); }
		if (loading) { return; }
		this.rememberSelection();
		const reconcileAttachments = !!this.insertionPoint;
		if (this.insertionPoint && this.domNode.contains(this.insertionPoint.commonAncestorContainer)) { this.selection = this.insertionPoint; }
		this.insertionPoint = undefined;
		const ids = new Set(attachments.map(attachment => attachment.id));
		const visit = (node: Node) => {
			for (const child of Array.from(node.childNodes)) {
				if (dom.isHTMLElement(child) && child.dataset.attachmentId) {
					if (!ids.has(child.dataset.attachmentId)) { child.remove(); }
				} else { visit(child); }
			}
		};
		visit(this.domNode);
		const present = new Set(this.references.map(reference => reference.id));
		for (const attachment of attachments) {
			if (!present.has(attachment.id)) {
				this.insert(this.createChip(attachment));
				this.insert(this.domNode.ownerDocument.createTextNode(' '));
			}
		}
		this.changed(reconcileAttachments);
	}

	ensureAttachments(): void { this.setAttachments(this.attachments, false); }

	private createChip(attachment: ICloudCodeAttachment): HTMLElement {
		const chip = dom.$('span.cloudcode-chat-attachment-chip', { contenteditable: 'false', role: 'button', tabIndex: 0, 'data-attachment-id': attachment.id, 'aria-label': attachment.label, title: attachment.label });
		if (attachment.image && cloudCodeImageBytes(attachment.image.dataUrl) !== undefined) {
			const image = dom.append(chip, dom.$<HTMLImageElement>('img.cloudcode-chat-attachment-thumbnail', { draggable: 'false' }));
			image.src = attachment.image.dataUrl; image.alt = attachment.label;
		} else { chip.appendChild(renderIcon(attachment.label.endsWith('.json') ? Codicon.json : Codicon.file)); }
		dom.append(chip, dom.$('span.cloudcode-chat-attachment-name')).textContent = attachment.label;
		const remove = dom.append(chip, dom.$('button.cloudcode-chat-attachment-remove', { type: 'button', 'aria-label': localize('cloudcode.removeNamedAttachment', "Remove {0}", attachment.label), title: localize('cloudcode.removeNamedAttachment', "Remove {0}", attachment.label) }));
		remove.appendChild(renderIcon(Codicon.close));
		return chip;
	}

	private read(root: Node = this.domNode): IDraft {
		let text = '';
		const references: ICloudCodeDraftReference[] = [];
		const visit = (node: Node) => {
			if (node.nodeType === Node.TEXT_NODE) { text += node.textContent ?? ''; return; }
			if (dom.isHTMLElement(node)) {
				const attachment = this.catalog.get(node.dataset.attachmentId ?? '');
				if (attachment) {
					const start = text.length;
					text += `[${attachment.label}]`;
					references.push({ id: attachment.id, start, end: text.length });
					return;
				}
				if (node.tagName === 'BR') { text += '\n'; return; }
				if (['DIV', 'P'].includes(node.tagName) && node !== root && text && !text.endsWith('\n')) { text += '\n'; }
			}
			for (const child of Array.from(node.childNodes)) { visit(child); }
		};
		visit(root);
		return { text, references };
	}

	private render(draft: IDraft): void {
		dom.clearNode(this.domNode);
		let offset = 0;
		for (const reference of draft.references) {
			const attachment = this.catalog.get(reference.id);
			if (!attachment || reference.start < offset || reference.end > draft.text.length) { continue; }
			this.domNode.append(this.domNode.ownerDocument.createTextNode(draft.text.slice(offset, reference.start)), this.createChip(attachment));
			offset = reference.end;
		}
		this.domNode.append(this.domNode.ownerDocument.createTextNode(draft.text.slice(offset)));
		this.selection = undefined;
		this.domNode.classList.toggle('empty', !draft.text);
	}

	private changed(reconcileAttachments: boolean): void {
		const draft = this.read();
		this.domNode.classList.toggle('empty', !draft.text);
		if (JSON.stringify(draft) !== JSON.stringify(this.history[this.historyIndex])) {
			this.history.splice(this.historyIndex + 1);
			this.history.push(draft);
			if (this.history.length > 50) { this.history.shift(); }
			this.historyIndex = this.history.length - 1;
			const retainedIds = new Set(this.history.flatMap(entry => entry.references.map(reference => reference.id)));
			for (const id of this.catalog.keys()) { if (!retainedIds.has(id) && !this.attachments.some(attachment => attachment.id === id)) { this.catalog.delete(id); } }
		}
		if (reconcileAttachments) { this.reconcileAttachments(draft); }
		this.changeEmitter.fire();
	}

	private reconcileAttachments(draft: IDraft): void {
		const ids = [...new Set(draft.references.map(reference => reference.id))];
		if (ids.length !== this.attachments.length || ids.some(id => !this.attachments.some(attachment => attachment.id === id))) {
			this.attachmentsEmitter.fire(ids.flatMap(id => { const attachment = this.catalog.get(id); return attachment ? [attachment] : []; }));
		}
	}

	private undo(redo: boolean): void {
		const next = this.historyIndex + (redo ? 1 : -1);
		if (next < 0 || next >= this.history.length) { return; }
		this.historyIndex = next;
		const draft = this.history[next];
		this.render(draft);
		this.reconcileAttachments(draft);
		this.changeEmitter.fire();
	}
}

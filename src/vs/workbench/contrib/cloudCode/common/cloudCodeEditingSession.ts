/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { CLOUDCODE_MAX_ATTACHMENT_BYTES, ICloudCodeAttachment } from './cloudCodeChatContext.js';

/** Only the edit-size limit permits falling back to read-only exploration. */
export class CloudCodeEditingReadOnlyError extends Error { }

/** Local snapshots never grant authority to paths supplied by inference. */
export interface ICloudCodeSessionFile {
	readonly root: string;
	readonly path: string;
	readonly resource: string;
	readonly content: string | undefined;
	readonly languageId?: string;
}

/** One original-to-final change; intermediate edits remain in the task overlay. */
export interface ICloudCodeSessionChange {
	readonly kind: 'create' | 'edit' | 'rename' | 'delete';
	readonly before: ICloudCodeSessionFile;
	readonly after: ICloudCodeSessionFile;
}

export type CloudCodeSessionCommand =
	| { readonly tool: 'apply_patch'; readonly root: string; readonly path: string; readonly oldText: string; readonly newText: string }
	| { readonly tool: 'create_file'; readonly root: string; readonly path: string; readonly content: string }
	| { readonly tool: 'rename_file'; readonly root: string; readonly path: string; readonly newPath: string }
	| { readonly tool: 'delete_file'; readonly root: string; readonly path: string };

export type CloudCodeEditingSessionStatus = 'pending' | 'applied' | 'partial' | 'rejected' | 'undone';

/** Browser adapter owns filesystem capabilities, baseline checks and native undo. */
export interface ICloudCodeEditingWorkspace extends IDisposable {
	assertValid(): void;
	key(root: string, path: string): string;
	read(root: string, path: string, token: CancellationToken): Promise<ICloudCodeSessionFile>;
	preview(changes: readonly ICloudCodeSessionChange[]): Promise<void>;
	/** False records a partial native apply, which must remain visible and recoverable. */
	apply(changes: readonly ICloudCodeSessionChange[]): Promise<boolean>;
	undo(): Promise<void>;
}

/** Presentation state contains paths and outcomes, never source or workspace capabilities. */
export interface ICloudCodeEditingSessionView {
	readonly id: string;
	readonly title?: string;
	/** Already applied to the project before a command, rather than awaiting final review. */
	readonly checkpoint?: boolean;
	readonly status: CloudCodeEditingSessionStatus;
	readonly reviewed: boolean;
	readonly changes: readonly { readonly kind: ICloudCodeSessionChange['kind']; readonly path: string; readonly newPath?: string }[];
	readonly error?: string;
}

export type CloudCodeEditingSessionAction = 'preview' | 'accept' | 'reject' | 'undo';

/** An Agent edits this overlay until it returns the complete session for user review. */
export interface ICloudCodeEditingSession extends IDisposable {
	readonly id: string;
	readonly status: CloudCodeEditingSessionStatus;
	readonly reviewed: boolean;
	readonly changes: readonly ICloudCodeSessionChange[];
	read(root: string, path: string, token: CancellationToken, startLine?: number, endLine?: number): Promise<{ readonly text: string; readonly attachment: ICloudCodeAttachment }>;
	stage(command: CloudCodeSessionCommand, token: CancellationToken): Promise<void>;
	/** Overlay paths let discovery results label disk data and avoid treating it as staged content. */
	summary(): readonly { readonly root: string; readonly path: string; readonly newPath?: string; readonly kind: ICloudCodeSessionChange['kind'] }[];
	preview(): Promise<void>;
	apply(): Promise<void>;
	reject(): void;
	undo(): Promise<void>;
}

export interface ICloudCodeEditingSessionFactory {
	createSession(): ICloudCodeEditingSession;
}

interface ISessionEntry {
	readonly before: ICloudCodeSessionFile;
	after: ICloudCodeSessionFile;
	known: string[];
	readLines: [number, number][];
	fullyRead: boolean;
}

const maxFileBytes = 1024 * 1024;
const maxTaskBytes = 4 * 1024 * 1024;
const maxChangedFiles = 20;
const maxWriteBytes = 32 * 1024;

/** Stage bounded changes without mutating the user's files or undo stacks. */
export class CloudCodeEditingSession implements ICloudCodeEditingSession {
	readonly id = generateUuid();
	private readonly entries = new Set<ISessionEntry>();
	private readonly paths = new Map<string, ISessionEntry | undefined>();
	private currentStatus: CloudCodeEditingSessionStatus = 'pending';
	private hasReviewed = false;
	private disposed = false;
	private busy = false;
	private snapshotBytes = 0;

	constructor(private readonly workspace: ICloudCodeEditingWorkspace) { }

	get status(): CloudCodeEditingSessionStatus { return this.currentStatus; }
	get reviewed(): boolean { return this.hasReviewed; }
	get changes(): readonly ICloudCodeSessionChange[] { return this.collectChanges(); }

	summary(): ReturnType<ICloudCodeEditingSession['summary']> {
		return this.changes.map(change => ({ root: change.before.root, path: change.kind === 'create' ? change.after.path : change.before.path, kind: change.kind,
			...(change.kind === 'rename' ? { newPath: change.after.path } : {}) }));
	}

	/** Reads always come from the current overlay, including newly created or renamed files. */
	async read(root: string, path: string, token: CancellationToken, startLine?: number, endLine?: number): Promise<{ text: string; attachment: ICloudCodeAttachment }> {
		return this.perform(async () => {
			this.assertPending(token);
			const entry = await this.entry(root, path, token);
			const value = entry.after.content;
			if (value === undefined) { throw this.missingFile(); }
			const starts = [0];
			const ends: number[] = [];
			const newline = /\r\n|\r|\n/g;
			let match: RegExpExecArray | null;
			while ((match = newline.exec(value))) { ends.push(match.index); starts.push(match.index + match[0].length); }
			ends.push(value.length);
			if ((startLine === undefined) !== (endLine === undefined)) { throw this.invalidRange(); }
			const first = startLine ?? 1;
			const last = endLine ?? starts.length;
			if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > starts.length || last - first + 1 > 200) { throw this.invalidRange(); }
			const content = startLine === undefined ? value : value.slice(starts[first - 1], ends[last - 1]);
			if (this.bytes(content) > CLOUDCODE_MAX_ATTACHMENT_BYTES) { throw this.invalidRange(); }
			entry.known.push(content);
			entry.readLines.push([first, last]);
			const intervals = [...entry.readLines].sort((left, right) => left[0] - right[0]);
			let observed = 0;
			for (const [from, to] of intervals) { if (from > observed + 1) { break; } observed = Math.max(observed, to); }
			entry.fullyRead = entry.fullyRead || observed === starts.length;
			return {
				text: 'Current staged file contents.',
				attachment: { id: `${entry.after.resource}#cloudcode-session-${this.id}`, label: entry.after.path,
					resource: entry.after.resource, content, languageId: entry.after.languageId,
					...(startLine === undefined ? {} : { startLine: first, endLine: last, range: { startLineNumber: first, startColumn: 1, endLineNumber: last, endColumn: ends[last - 1] - starts[last - 1] + 1 } }) }
			};
		});
	}

	/** Exact matches and observed source prevent patches from modifying unseen or ambiguous text. */
	async stage(command: CloudCodeSessionCommand, token: CancellationToken): Promise<void> {
		await this.perform(async () => {
			this.assertPending(token);
			const entry = await this.entry(command.root, command.path, token);
			const beforeStage = entry.after;
			let after: ICloudCodeSessionFile;
			let destination: ISessionEntry | undefined;
			switch (command.tool) {
				case 'create_file':
					if (beforeStage.content !== undefined || entry.before.content !== undefined) { throw this.collision(); }
					this.validateText(command.content, maxWriteBytes);
					after = { ...beforeStage, content: command.content };
					break;
				case 'apply_patch': {
					if (beforeStage.content === undefined) { throw this.missingFile(); }
					this.validateText(command.oldText, maxWriteBytes);
					this.validateText(command.newText, maxWriteBytes);
					const eol = /\r\n|\r|\n/.exec(beforeStage.content)?.[0] ?? '\n';
					const oldText = command.oldText.replace(/\r\n|\r|\n/g, eol);
					const newText = command.newText.replace(/\r\n|\r|\n/g, eol);
					this.validateText(newText, maxWriteBytes);
					const position = beforeStage.content.indexOf(oldText);
					if (!oldText || !entry.known.some(text => text.includes(oldText)) || position < 0 || beforeStage.content.indexOf(oldText, position + 1) >= 0) {
						throw new Error(localize('cloudCode.session.patchMatch', "Read the current code and provide one unique, exact patch match."));
					}
					after = { ...beforeStage, content: beforeStage.content.slice(0, position) + newText + beforeStage.content.slice(position + oldText.length) };
					break;
				}
				case 'rename_file':
					if (beforeStage.content === undefined) { throw this.missingFile(); }
					if (!entry.known.length) { throw this.readFirst(); }
					if (this.workspace.key(command.root, command.newPath) === this.workspace.key(command.root, command.path)) { throw this.collision(); }
					destination = await this.entry(command.root, command.newPath, token);
					if (destination.before.content !== undefined || destination.after.content !== undefined) { throw this.collision(); }
					after = { ...destination.after, content: beforeStage.content, languageId: beforeStage.languageId };
					break;
				case 'delete_file':
					if (beforeStage.content === undefined) { throw this.missingFile(); }
					if (!entry.fullyRead) { throw this.readFirst(); }
					after = { ...beforeStage, content: undefined };
					break;
			}
			this.assertPending(token);
			if (after.content !== undefined) { this.validateText(after.content, maxFileBytes); }
			const prospective = this.collectChanges(entry, after);
			if (prospective.length > maxChangedFiles || prospective.reduce((size, change) => size + this.bytes(change.after.content ?? ''), 0) > maxTaskBytes) {
				throw new Error(localize('cloudCode.session.changeLimit', "A task supports up to 20 changed files and 4 MiB of changed text. Request a smaller change."));
			}
			entry.after = after;
			if (command.tool === 'rename_file' && destination) {
				this.paths.set(this.workspace.key(command.root, command.path), undefined);
				this.paths.set(this.workspace.key(command.root, command.newPath), entry);
			}
			if (command.tool === 'create_file') { entry.known = [command.content]; entry.fullyRead = true; }
			if (command.tool === 'apply_patch') {
				// Prior excerpts have shifted. Keep only the new text as known unless the whole file was read.
				entry.known = entry.fullyRead ? [after.content!] : [command.newText.replace(/\r\n|\r|\n/g, /\r\n|\r|\n/.exec(beforeStage.content!)?.[0] ?? '\n')];
				entry.readLines = [];
			}
			this.hasReviewed = false;
		});
	}

	async preview(): Promise<void> {
		await this.perform(async () => {
			this.assertPending(CancellationToken.None);
			const changes = this.changes;
			if (!changes.length) { throw this.noChanges(); }
			await this.workspace.preview(changes);
			this.assertPending(CancellationToken.None);
			this.hasReviewed = true;
		});
	}

	async apply(): Promise<void> {
		await this.perform(async () => {
			this.assertPending(CancellationToken.None);
			if (!this.hasReviewed) { throw new Error(localize('cloudCode.session.previewFirst', "Preview all changes before accepting this task.")); }
			if (!this.changes.length) { throw this.noChanges(); }
			const complete = await this.workspace.apply(this.changes);
			this.currentStatus = complete ? 'applied' : 'partial';
			if (!complete) { throw new Error(localize('cloudCode.session.partial', "Only part of this task could be applied. Review the files and use Undo Task to recover when available.")); }
		});
	}

	reject(): void {
		if (this.busy) { throw this.operationBusy(); }
		this.assertPending(CancellationToken.None);
		this.currentStatus = 'rejected';
	}

	async undo(): Promise<void> {
		await this.perform(async () => {
			this.assertValid(CancellationToken.None);
			if (this.currentStatus !== 'applied' && this.currentStatus !== 'partial') { throw this.noChanges(); }
			await this.workspace.undo();
			this.currentStatus = 'undone';
		});
	}

	dispose(): void {
		if (!this.disposed) { this.disposed = true; this.workspace.dispose(); }
	}

	private async entry(root: string, path: string, token: CancellationToken): Promise<ISessionEntry> {
		const key = this.workspace.key(root, path);
		if (this.paths.has(key)) {
			const entry = this.paths.get(key);
			if (!entry) { throw this.missingFile(); }
			return entry;
		}
		const file = await this.workspace.read(root, path, token);
		this.assertPending(token);
		if (this.workspace.key(file.root, file.path) !== key || !file.resource) { throw this.missingFile(); }
		if (file.content !== undefined) { this.validateText(file.content, maxFileBytes); }
		const bytes = this.bytes(file.content ?? '');
		if (this.snapshotBytes + bytes > maxTaskBytes || this.paths.size >= 80) {
			throw new Error(localize('cloudCode.session.snapshotLimit', "This task has reached its local file snapshot limit. Request a smaller change."));
		}
		this.snapshotBytes += bytes;
		const entry: ISessionEntry = { before: file, after: file, known: [], fullyRead: false, readLines: [] };
		this.entries.add(entry);
		this.paths.set(key, entry);
		return entry;
	}

	private collectChanges(replaced?: ISessionEntry, replacement?: ICloudCodeSessionFile): ICloudCodeSessionChange[] {
		const changes: ICloudCodeSessionChange[] = [];
		for (const entry of this.entries) {
			const before = entry.before;
			const after = entry === replaced ? replacement! : entry.after;
			if (before.content === undefined && after.content === undefined) { continue; }
			if (before.content === after.content && before.resource === after.resource) { continue; }
			changes.push({ before, after, kind: before.content === undefined ? 'create' : after.content === undefined ? 'delete' : before.resource !== after.resource ? 'rename' : 'edit' });
		}
		return changes;
	}

	private async perform<T>(operation: () => Promise<T>): Promise<T> {
		if (this.busy) { throw this.operationBusy(); }
		this.busy = true;
		try { return await operation(); } finally { this.busy = false; }
	}

	private assertValid(token: CancellationToken): void {
		if (this.disposed || token.isCancellationRequested) { throw new CancellationError(); }
		this.workspace.assertValid();
	}

	private assertPending(token: CancellationToken): void {
		this.assertValid(token);
		if (this.currentStatus !== 'pending') { throw new Error(localize('cloudCode.session.closed', "This task is already complete. Start a new task for further changes.")); }
	}

	private bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
	private validateText(value: string, limit: number): void {
		if (value.includes('\0') || this.bytes(value) > limit) { throw new Error(localize('cloudCode.session.textLimit', "The requested change exceeds the text size limit or contains binary data.")); }
	}
	private missingFile(): Error { return new Error(localize('cloudCode.session.missingFile', "This file is unavailable or has been removed from the staged task.")); }
	private collision(): Error { return new Error(localize('cloudCode.session.collision', "Choose a new file path that does not overwrite or reuse another task path.")); }
	private readFirst(): Error { return new Error(localize('cloudCode.session.readFirst', "Read the current file before changing it. Deleting a file requires reading all its contents.")); }
	private invalidRange(): Error { return new Error(localize('cloudCode.session.readRange', "Read at most 200 lines and 16 KiB at a time, using valid start and end lines.")); }
	private noChanges(): Error { return new Error(localize('cloudCode.session.noChanges', "There are no available task changes for this action.")); }
	private operationBusy(): Error { return new Error(localize('cloudCode.session.busy', "Wait for the current task action to finish.")); }
}

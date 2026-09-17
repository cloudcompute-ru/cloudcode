/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CloudCodeEditingSession, ICloudCodeEditingWorkspace, ICloudCodeSessionChange, ICloudCodeSessionFile } from '../../common/cloudCodeEditingSession.js';

suite('CloudCodeEditingSession', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const token = CancellationToken.None;

	class Workspace implements ICloudCodeEditingWorkspace {
		readonly files = new Map<string, string>();
		readonly previews: (readonly ICloudCodeSessionChange[])[] = [];
		readonly applications: (readonly ICloudCodeSessionChange[])[] = [];
		reads = 0;
		undos = 0;
		valid = true;
		complete = true;
		undoError = false;
		previewWait: DeferredPromise<void> | undefined;
		readWait: DeferredPromise<void> | undefined;
		assertValid(): void { if (!this.valid) { throw new Error('Workspace is invalid'); } }
		key(root: string, path: string): string {
			if (root !== '1' || !path || path.startsWith('/') || /[\\:]/.test(path) || path.split('/').some(part => !part || part === '..' || part === '.')) { throw new Error('Invalid path'); }
			return path.toLowerCase();
		}
		async read(root: string, path: string): Promise<ICloudCodeSessionFile> {
			this.reads++;
			await this.readWait?.p;
			return { root, path, resource: `file:///project/${this.key(root, path)}`, content: this.files.get(this.key(root, path)), languageId: 'typescript' };
		}
		async preview(changes: readonly ICloudCodeSessionChange[]): Promise<void> { this.previews.push(changes); await this.previewWait?.p; }
		async apply(changes: readonly ICloudCodeSessionChange[]): Promise<boolean> { this.applications.push(changes); return this.complete; }
		async undo(): Promise<void> { if (this.undoError) { throw new Error('Later user edit'); } this.undos++; }
		dispose(): void { this.valid = false; }
	}

	function setup(files: Record<string, string> = { 'main.ts': 'const value = 1;\n' }): { workspace: Workspace; session: CloudCodeEditingSession } {
		const workspace = new Workspace();
		for (const [path, value] of Object.entries(files)) { workspace.files.set(path, value); }
		return { workspace, session: store.add(new CloudCodeEditingSession(workspace)) };
	}

	test('repeated patches and rename collapse into one original-to-final change without writing', async () => {
		const { session, workspace } = setup();
		await session.read('1', 'main.ts', token);
		await session.stage({ tool: 'apply_patch', root: '1', path: 'main.ts', oldText: 'value = 1', newText: 'value = 2' }, token);
		await session.stage({ tool: 'rename_file', root: '1', path: 'main.ts', newPath: 'renamed.ts' }, token);
		await session.stage({ tool: 'apply_patch', root: '1', path: 'renamed.ts', oldText: 'value = 2', newText: 'value = 3' }, token);
		const read = await session.read('1', 'renamed.ts', token);
		assert.deepStrictEqual({ changes: session.changes.map(change => [change.kind, change.before.path, change.before.content, change.after.path, change.after.content]), content: read.attachment.content, applications: workspace.applications }, {
			changes: [['rename', 'main.ts', 'const value = 1;\n', 'renamed.ts', 'const value = 3;\n']], content: 'const value = 3;\n', applications: []
		});
		await assert.rejects(session.read('1', 'main.ts', token));
	});

	test('create rename patch delete cancels out, without exposing a disk fallback', async () => {
		const { session, workspace } = setup({});
		await session.stage({ tool: 'create_file', root: '1', path: 'new.ts', content: 'hello' }, token);
		await session.stage({ tool: 'rename_file', root: '1', path: 'new.ts', newPath: 'final.ts' }, token);
		assert.deepStrictEqual(session.summary(), [{ root: '1', path: 'final.ts', kind: 'create' }]);
		await session.stage({ tool: 'apply_patch', root: '1', path: 'final.ts', oldText: 'hello', newText: 'world' }, token);
		await session.stage({ tool: 'delete_file', root: '1', path: 'final.ts' }, token);
		const reads = workspace.reads;
		await assert.rejects(session.read('1', 'new.ts', token));
		await assert.rejects(session.read('1', 'final.ts', token));
		assert.deepStrictEqual({ changes: session.changes, diskReads: workspace.reads - reads, applications: workspace.applications }, { changes: [], diskReads: 0, applications: [] });
	});

	test('rename then delete removes the original file in the final change set', async () => {
		const { session } = setup();
		await session.read('1', 'main.ts', token);
		await session.stage({ tool: 'rename_file', root: '1', path: 'main.ts', newPath: 'renamed.ts' }, token);
		await session.stage({ tool: 'delete_file', root: '1', path: 'renamed.ts' }, token);
		assert.deepStrictEqual(session.changes.map(change => [change.kind, change.before.path, change.after.content]), [['delete', 'main.ts', undefined]]);
	});

	test('new files and case aliases cannot overwrite existing files or task paths', async () => {
		const { session } = setup({ 'main.ts': 'existing', 'other.ts': 'other' });
		await session.read('1', 'main.ts', token);
		await assert.rejects(session.stage({ tool: 'create_file', root: '1', path: 'MAIN.ts', content: 'overwrite' }, token));
		await assert.rejects(session.stage({ tool: 'rename_file', root: '1', path: 'main.ts', newPath: 'MAIN.ts' }, token));
		await assert.rejects(session.stage({ tool: 'rename_file', root: '1', path: 'main.ts', newPath: 'other.ts' }, token));
		await session.stage({ tool: 'rename_file', root: '1', path: 'main.ts', newPath: 'new.ts' }, token);
		await assert.rejects(session.stage({ tool: 'create_file', root: '1', path: 'main.ts', content: 'reuse' }, token));
		assert.strictEqual(session.changes.length, 1);
	});

	test('patches need observed source and one exact unambiguous match', async () => {
		const { session } = setup({ 'main.ts': 'same\nsame\nunseen' });
		await assert.rejects(session.stage({ tool: 'apply_patch', root: '1', path: 'main.ts', oldText: 'unseen', newText: 'changed' }, token));
		await session.read('1', 'main.ts', token, 1, 1);
		await assert.rejects(session.stage({ tool: 'apply_patch', root: '1', path: 'main.ts', oldText: 'same', newText: 'ambiguous' }, token));
		await assert.rejects(session.stage({ tool: 'apply_patch', root: '1', path: 'main.ts', oldText: 'unseen', newText: 'changed' }, token));
		await session.read('1', 'main.ts', token, 3, 3);
		await session.stage({ tool: 'apply_patch', root: '1', path: 'main.ts', oldText: 'unseen', newText: 'observed' }, token);
		assert.strictEqual(session.changes[0].after.content, 'same\nsame\nobserved');
	});

	test('deletion requires all lines to have been read, including after separate range reads', async () => {
		const { session } = setup({ 'main.ts': 'first\r\nsecond\r\nthird' });
		await session.read('1', 'main.ts', token, 1, 1);
		await assert.rejects(session.stage({ tool: 'delete_file', root: '1', path: 'main.ts' }, token));
		const read = await session.read('1', 'main.ts', token, 2, 3);
		await session.stage({ tool: 'delete_file', root: '1', path: 'main.ts' }, token);
		assert.deepStrictEqual({ read: read.attachment.content, changes: session.changes.map(change => change.kind) }, { read: 'second\r\nthird', changes: ['delete'] });
	});

	test('patches preserve CRLF and invalidate prior preview before acceptance', async () => {
		const { session, workspace } = setup({ 'main.ts': 'first\r\nsecond\r\n' });
		await session.read('1', 'main.ts', token);
		await session.stage({ tool: 'apply_patch', root: '1', path: 'main.ts', oldText: 'first\nsecond', newText: 'first\nchanged' }, token);
		await session.preview();
		await session.stage({ tool: 'apply_patch', root: '1', path: 'main.ts', oldText: 'changed', newText: 'final' }, token);
		await assert.rejects(session.apply());
		assert.deepStrictEqual({ reviewed: session.reviewed, content: session.changes[0].after.content, applications: workspace.applications }, { reviewed: false, content: 'first\r\nfinal\r\n', applications: [] });
	});

	test('one combined preview gates one application and task undo', async () => {
		const { session, workspace } = setup();
		await session.read('1', 'main.ts', token);
		await session.stage({ tool: 'apply_patch', root: '1', path: 'main.ts', oldText: 'value = 1', newText: 'value = 2' }, token);
		await session.stage({ tool: 'create_file', root: '1', path: 'new.ts', content: 'new' }, token);
		await assert.rejects(session.apply());
		await session.preview();
		await session.apply();
		await assert.rejects(session.apply());
		await session.undo();
		assert.deepStrictEqual({ previews: workspace.previews.length, applied: workspace.applications.length, fileCount: workspace.applications[0].length, status: session.status, undos: workspace.undos }, { previews: 1, applied: 1, fileCount: 2, status: 'undone', undos: 1 });
	});

	test('partial application remains recoverable and a failed undo keeps its state', async () => {
		const { session, workspace } = setup({});
		await session.stage({ tool: 'create_file', root: '1', path: 'new.ts', content: 'new' }, token);
		await session.preview();
		workspace.complete = false;
		await assert.rejects(session.apply());
		workspace.undoError = true;
		await assert.rejects(session.undo());
		assert.strictEqual(session.status, 'partial');
		workspace.undoError = false;
		await session.undo();
		assert.strictEqual(session.status, 'undone');
	});

	test('rejecting a task never mutates workspace files', async () => {
		const { session, workspace } = setup({});
		await session.stage({ tool: 'create_file', root: '1', path: 'new.ts', content: 'new' }, token);
		session.reject();
		await assert.rejects(session.apply());
		assert.deepStrictEqual({ status: session.status, applied: workspace.applications, files: [...workspace.files] }, { status: 'rejected', applied: [], files: [] });
	});

	test('simultaneous actions cannot invalidate an in-flight combined preview', async () => {
		const { session, workspace } = setup({});
		await session.stage({ tool: 'create_file', root: '1', path: 'new.ts', content: 'new' }, token);
		workspace.previewWait = new DeferredPromise<void>();
		const preview = session.preview();
		await assert.rejects(session.stage({ tool: 'create_file', root: '1', path: 'other.ts', content: 'other' }, token));
		assert.throws(() => session.reject());
		await workspace.previewWait.complete();
		await preview;
		assert.deepStrictEqual({ reviewed: session.reviewed, paths: session.summary().map(change => change.path) }, { reviewed: true, paths: ['new.ts'] });
	});

	test('cancelled or disposed asynchronous reads cannot produce edit capabilities', async () => {
		const { session, workspace } = setup();
		const cancellation = store.add(new CancellationTokenSource());
		workspace.readWait = new DeferredPromise<void>();
		const reading = session.read('1', 'main.ts', cancellation.token);
		cancellation.cancel();
		session.dispose();
		await workspace.readWait.complete();
		await assert.rejects(reading);
		assert.deepStrictEqual(session.changes, []);
	});

	test('read and write budgets reject oversized input without staging a partial change', async () => {
		const { session } = setup({ 'main.ts': 'a'.repeat(16385), 'lines.ts': 'a\n'.repeat(201) });
		await assert.rejects(session.read('1', 'main.ts', token));
		await assert.rejects(session.read('1', 'lines.ts', token));
		await assert.rejects(session.stage({ tool: 'create_file', root: '1', path: 'new.ts', content: '界'.repeat(12000) }, token));
		await assert.rejects(session.stage({ tool: 'create_file', root: '1', path: 'binary.ts', content: '\0' }, token));
		assert.deepStrictEqual(session.changes, []);
	});

	test('twentieth file fits and the next creation leaves existing changes intact', async () => {
		const { session } = setup({});
		for (let index = 0; index < 20; index++) { await session.stage({ tool: 'create_file', root: '1', path: `file${index}.ts`, content: 'value' }, token); }
		await assert.rejects(session.stage({ tool: 'create_file', root: '1', path: 'overflow.ts', content: 'value' }, token));
		assert.strictEqual(session.changes.length, 20);
	});

	test('summaries exclude source contents and absolute workspace resources', async () => {
		const { session } = setup();
		await session.stage({ tool: 'create_file', root: '1', path: 'new.ts', content: 'private source' }, token);
		assert.deepStrictEqual(session.summary(), [{ root: '1', path: 'new.ts', kind: 'create' }]);
	});
});

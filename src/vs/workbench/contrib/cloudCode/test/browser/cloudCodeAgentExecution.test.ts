/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { CLOUDCODE_MAX_COMMAND_TIMEOUT_MS, ICloudCodeCommandResult, ICloudCodeCommandService } from '../../../../../platform/cloudCode/common/cloudCodeCommand.js';
import { IConfirmation, IConfirmationResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService, IFileStatWithPartialMetadata } from '../../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IOutputChannel, IOutputService } from '../../../../services/output/common/output.js';
import { IResolvedTextFileEditorModel, ITextFileContent, ITextFileEditorModel, ITextFileEditorModelManager, ITextFileSaveOptions, ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IWorkingCopy } from '../../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { CloudCodeAgentExecutionSession } from '../../browser/cloudCodeAgentExecution.js';
import { CloudCodeAgentExecutionError, ICloudCodeAgentCommand } from '../../common/cloudCodeAgentExecution.js';
import { ICloudCodeEditingSession, ICloudCodeSessionChange } from '../../common/cloudCodeEditingSession.js';

suite('CloudCodeAgentExecution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const root = URI.file('/project');
	const command: ICloudCodeAgentCommand = { root: '1', path: '.', command: 'npm test', explanation: 'Check the change' };
	const completed: ICloudCodeCommandResult = { exitCode: 0, stdout: 'pass', stderr: '', timedOut: false, cancelled: false, truncated: false };
	let folders: IWorkspaceFolder[];
	let trusted: boolean;
	let trustChanged: Emitter<boolean>;
	let foldersChanged: Emitter<IWorkspaceFoldersChangeEvent>;
	let files: Map<string, string>;
	let models: Map<string, string>;
	let dirty: Set<string>;
	let links: Set<string>;
	let directories: Set<string>;
	let calls: string[];
	let confirmations: IConfirmation[];
	let confirm: (confirmation: IConfirmation) => Promise<IConfirmationResult>;
	let run: (requestId: string, value: string, cwd: string, timeout: number) => Promise<ICloudCodeCommandResult>;
	let cancel: (requestId: string) => Promise<void>;
	let save: (resource: URI, options?: ITextFileSaveOptions) => Promise<URI | undefined>;
	let reload: (resource: URI) => Promise<void>;
	let refreshed: string[];
	let output: string[];
	let session: CloudCodeAgentExecutionSession;

	function createSession(): CloudCodeAgentExecutionSession {
		return disposables.add(new CloudCodeAgentExecutionSession(
			upcastPartial<IDialogService>({ confirm: async confirmation => { confirmations.push(confirmation); return confirm(confirmation); } }),
			upcastPartial<IWorkspaceContextService>({ getWorkspace: () => upcastPartial<IWorkspace>({ folders }), onDidChangeWorkspaceFolders: foldersChanged.event, onDidChangeWorkbenchState: Event.None }),
			upcastPartial<IWorkspaceTrustManagementService>({ isWorkspaceTrusted: () => trusted, onDidChangeTrust: trustChanged.event }),
			upcastPartial<IFileService>({ stat: async resource => {
				const key = resource.toString();
				if (!directories.has(key) && !files.has(key)) { throw new Error('Missing path'); }
				return upcastPartial<IFileStatWithPartialMetadata>({ resource, isDirectory: directories.has(key), isFile: files.has(key), isSymbolicLink: links.has(key) });
			} }),
			upcastPartial<ITextFileService>({
				files: upcastPartial<ITextFileEditorModelManager>({
					get: () => undefined,
					get models() { return [...models.keys()].map(resource => upcastPartial<ITextFileEditorModel>({ resource: URI.parse(resource), isDirty(): this is IResolvedTextFileEditorModel { return dirty.has(resource); } })); },
					resolve: async (resource, options) => {
						refreshed.push(resource.toString());
						assert.deepStrictEqual(options, { reload: { async: false }, forceReadFromFile: true });
						await reload(resource);
						return upcastPartial<ITextFileEditorModel>({ resource });
					},
				}),
				isDirty: resource => dirty.has(resource.toString()), save: (resource, options) => save(resource, options),
				read: async resource => upcastPartial<ITextFileContent>({ resource, value: files.get(resource.toString())! }),
			}),
			upcastPartial<IModelService>({ getModel: resource => models.has(resource.toString()) ? upcastPartial<ITextModel>({ getValue: () => models.get(resource.toString())! }) : null }),
			upcastPartial<IWorkingCopyService>({ get dirtyWorkingCopies() { return [...dirty].map(resource => upcastPartial<IWorkingCopy>({ resource: URI.parse(resource) })); } }),
			upcastPartial<IUriIdentityService>({ extUri, asCanonicalUri: resource => resource }),
			upcastPartial<ICloudCodeCommandService>({
				run: async (requestId, value, cwd, timeout) => { calls.push('run'); return run(requestId, value, cwd, timeout); },
				cancel: async requestId => { calls.push('cancel'); return cancel(requestId); },
			}),
			upcastPartial<IOutputService>({ getChannel: id => { assert.strictEqual(id, 'cloudcode.agentCommands'); return upcastPartial<IOutputChannel>({ append: text => output.push(text) }); } }),
		));
	}

	function editing(changes: readonly ICloudCodeSessionChange[] = [], apply?: () => Promise<void>): ICloudCodeEditingSession {
		return upcastPartial<ICloudCodeEditingSession>({
			changes,
			preview: async () => { calls.push('preview'); },
			apply: async () => {
				calls.push('apply');
				if (apply) { return apply(); }
				for (const change of changes) {
					if (change.after.content !== undefined) {
						models.set(change.after.resource, change.after.content);
						dirty.add(change.after.resource);
						if (change.kind === 'create') { files.set(change.after.resource, change.after.content); }
					}
				}
			},
		});
	}

	function change(path = 'test.ts'): ICloudCodeSessionChange {
		const resource = URI.joinPath(root, path).toString();
		files.set(resource, 'before');
		models.set(resource, 'before');
		return { kind: 'edit', before: { root: '1', path, resource, content: 'before' }, after: { root: '1', path, resource, content: 'after' } };
	}

	setup(() => {
		folders = [toWorkspaceFolder(root)];
		trusted = true;
		trustChanged = disposables.add(new Emitter<boolean>());
		foldersChanged = disposables.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		files = new Map(); models = new Map(); dirty = new Set(); links = new Set();
		directories = new Set([root.toString(), URI.file('/').toString(), URI.joinPath(root, 'src').toString()]);
		calls = []; confirmations = []; refreshed = []; output = [];
		confirm = async () => ({ confirmed: true });
		run = async (_id, _value, cwd, timeout) => { assert.deepStrictEqual([cwd, timeout], [root.fsPath, CLOUDCODE_MAX_COMMAND_TIMEOUT_MS]); return completed; };
		cancel = async () => { };
		reload = async resource => { if (!dirty.has(resource.toString())) { models.set(resource.toString(), files.get(resource.toString())!); } };
		save = async (resource, options) => {
			calls.push('save');
			assert.strictEqual(options?.skipSaveParticipants, true);
			files.set(resource.toString(), models.get(resource.toString())!);
			dirty.delete(resource.toString());
			return resource;
		};
		session = createSession();
	});

	test('denial previews a checkpoint but neither applies nor runs', async () => {
		confirm = async () => ({ confirmed: false, checkboxChecked: true });
		assert.deepStrictEqual(await session.run(command, editing([change()]), CancellationToken.None), { denied: true });
		assert.deepStrictEqual(calls, ['preview']);
		assert.deepStrictEqual(output, []);
	});

	test('command-only request is approved without preview or apply', async () => {
		assert.deepStrictEqual(await session.run(command, editing(), CancellationToken.None), completed);
		assert.deepStrictEqual(calls, ['run']);
		assert.strictEqual(confirmations[0].primaryButton, 'Run Command');
		assert.ok(String(confirmations[0].detail).includes(command.command));
		assert.ok(String(confirmations[0].detail).includes(root.fsPath));
	});

	test('approved checkpoint is applied and saved before the command', async () => {
		const edited = change();
		dirty.add(edited.before.resource);
		await session.run(command, editing([edited]), CancellationToken.None);
		assert.deepStrictEqual({ calls, content: files.get(edited.after.resource), dirty: [...dirty], primary: confirmations[0].primaryButton },
			{ calls: ['preview', 'apply', 'save', 'run'], content: 'after', dirty: [], primary: 'Apply Changes and Run' });
		assert.ok(String(confirmations[0].detail).includes('existing unsaved changes'));
	});

	test('task consent applies only to this session', async () => {
		confirm = async () => ({ confirmed: true, checkboxChecked: true });
		await session.run(command, editing(), CancellationToken.None);
		await session.run(command, editing([change()]), CancellationToken.None);
		await createSession().run(command, editing(), CancellationToken.None);
		assert.deepStrictEqual({ dialogs: confirmations.length, calls }, { dialogs: 2, calls: ['run', 'preview', 'apply', 'save', 'run', 'run'] });
	});

	test('ordinary approval does not automatically approve the next command', async () => {
		await session.run(command, editing(), CancellationToken.None);
		await session.run(command, editing(), CancellationToken.None);
		assert.strictEqual(confirmations.length, 2);
	});

	test('cancellation while confirmation is open cannot apply or run', async () => {
		const opened = new DeferredPromise<void>();
		const answer = new DeferredPromise<IConfirmationResult>();
		const token = disposables.add(new CancellationTokenSource());
		confirm = async () => { opened.complete(); return answer.p; };
		const operation = session.run(command, editing([change()]), token.token);
		await opened.p;
		token.cancel();
		await assert.rejects(operation, /Canceled/);
		answer.complete({ confirmed: true, checkboxChecked: true });
		assert.deepStrictEqual(calls, ['preview']);
	});

	test('trust revocation while confirmation is open prevents a later approval', async () => {
		confirm = async () => { trusted = false; trustChanged.fire(false); return { confirmed: true, checkboxChecked: true }; };
		await assert.rejects(session.run(command, editing([change()]), CancellationToken.None), /Canceled/);
		trusted = true;
		await assert.rejects(session.run(command, editing(), CancellationToken.None), /Canceled/);
		assert.deepStrictEqual(calls, ['preview']);
	});

	test('workspace changes revoke consent and cannot be revived by restoring the roots', async () => {
		confirm = async () => ({ confirmed: true, checkboxChecked: true });
		await session.run(command, editing(), CancellationToken.None);
		foldersChanged.fire({ added: [], removed: [], changed: [] });
		await assert.rejects(session.run(command, editing(), CancellationToken.None), /Canceled/);
		assert.deepStrictEqual(calls, ['run']);
	});

	test('workspace mismatch after approval is detected even without an event', async () => {
		confirm = async () => { folders = [toWorkspaceFolder(URI.file('/different'))]; return { confirmed: true }; };
		await assert.rejects(session.run(command, editing([change()]), CancellationToken.None), /Canceled/);
		assert.deepStrictEqual(calls, ['preview']);
	});

	test('rejects traversal, absolute paths, invalid roots and symbolic-link directories before prompting', async () => {
		for (const path of ['../other', '/tmp', 'src/../other', 'C:\\Windows', 'src//other', 'src\n']) {
			await assert.rejects(session.run({ ...command, path }, editing(), CancellationToken.None), /relative directory/);
		}
		await assert.rejects(session.run({ ...command, root: '2' }, editing(), CancellationToken.None), /relative directory/);
		links.add(root.toString());
		await assert.rejects(session.run(command, editing(), CancellationToken.None), /symbolic links/);
		assert.deepStrictEqual({ calls, confirmations }, { calls: [], confirmations: [] });
	});

	test('revalidates directory links after approval before applying', async () => {
		confirm = async () => { links.add(root.toString()); return { confirmed: true }; };
		await assert.rejects(session.run(command, editing([change()]), CancellationToken.None), /symbolic links/);
		assert.deepStrictEqual(calls, ['preview']);
	});

	test('remote workspaces cannot dispatch a local command', async () => {
		folders = [toWorkspaceFolder(URI.parse('vscode-remote://ssh-remote+host/project'))];
		const remote = createSession();
		await assert.rejects(remote.run(command, editing(), CancellationToken.None), /local project folder/);
		assert.deepStrictEqual({ calls, confirmations }, { calls: [], confirmations: [] });
	});

	test('unrelated dirty source is preserved and blocks a command', async () => {
		const unrelated = URI.joinPath(root, 'other.ts').toString();
		dirty.add(unrelated);
		await assert.rejects(session.run(command, editing([change()]), CancellationToken.None), /unsaved project files/);
		assert.deepStrictEqual({ calls, dirty: [...dirty] }, { calls: [], dirty: [unrelated] });
	});

	test('dirty source created during approval is rechecked', async () => {
		confirm = async () => { dirty.add(URI.joinPath(root, 'other.ts').toString()); return { confirmed: true }; };
		await assert.rejects(session.run(command, editing(), CancellationToken.None), /unsaved project files/);
		assert.deepStrictEqual(calls, []);
	});

	test('partial apply and save failure never start the command', async () => {
		await assert.rejects(session.run(command, editing([change()], async () => { throw new Error('Partial apply'); }), CancellationToken.None), /Partial apply/);
		save = async () => undefined;
		await assert.rejects(session.run(command, editing([change()]), CancellationToken.None), /could not be saved/);
		assert.deepStrictEqual(calls, ['preview', 'apply', 'preview', 'apply']);
	});

	test('manual edits after apply are preserved without saving or executing', async () => {
		const edited = change();
		await assert.rejects(session.run(command, editing([edited], async () => { models.set(edited.after.resource, 'user typed'); dirty.add(edited.after.resource); }), CancellationToken.None), /project changed/);
		assert.deepStrictEqual({ calls, buffer: models.get(edited.after.resource), disk: files.get(edited.after.resource) }, { calls: ['preview', 'apply'], buffer: 'user typed', disk: 'before' });
	});

	test('cancellation waits for the active runner to settle and revokes task consent', async () => {
		const started = new DeferredPromise<void>();
		const stopped = new DeferredPromise<ICloudCodeCommandResult>();
		const token = disposables.add(new CancellationTokenSource());
		confirm = async () => ({ confirmed: true, checkboxChecked: true });
		run = async () => { started.complete(); return stopped.p; };
		cancel = async () => { stopped.complete({ ...completed, cancelled: true, exitCode: null }); };
		const operation = session.run(command, editing(), token.token);
		await started.p;
		token.cancel();
		await assert.rejects(operation, /Canceled/);
		run = async () => completed;
		await session.run(command, editing(), CancellationToken.None);
		assert.deepStrictEqual({ calls, dialogs: confirmations.length }, { calls: ['run', 'cancel', 'run'], dialogs: 2 });
	});

	test('dispose cancels the active command and disables the session', async () => {
		const started = new DeferredPromise<void>();
		const stopped = new DeferredPromise<ICloudCodeCommandResult>();
		run = async () => { started.complete(); return stopped.p; };
		cancel = async () => { stopped.complete({ ...completed, cancelled: true, exitCode: null }); };
		const operation = session.run(command, editing(), CancellationToken.None);
		await started.p;
		session.dispose();
		await assert.rejects(operation, /Canceled/);
		await assert.rejects(session.run(command, editing(), CancellationToken.None), /Canceled/);
		assert.deepStrictEqual(calls, ['run', 'cancel']);
	});

	test('command changes reload clean models before the next editing session', async () => {
		const edited = change();
		run = async () => { files.set(edited.before.resource, 'command output'); return completed; };
		await session.run(command, editing(), CancellationToken.None);
		assert.deepStrictEqual({ buffer: models.get(edited.before.resource), refreshed }, { buffer: 'command output', refreshed: [edited.before.resource] });
	});

	test('local output includes the exact approved command, cwd and bounded runner result', async () => {
		const result = { ...completed, stdout: 'x'.repeat(8192), stderr: 'failure', exitCode: 1, truncated: true };
		run = async () => result;
		assert.deepStrictEqual(await session.run(command, editing(), CancellationToken.None), result);
		assert.deepStrictEqual(output, [`\nCommand: npm test\nDirectory: ${root.fsPath}\n`, result.stdout + '\n', 'Standard error:\nfailure\n', 'Exit code: 1. Timed out: false. Cancelled: false. Output truncated: true.\n']);
	});

	test('failed commands also refresh clean models while preserving new unsaved user changes', async () => {
		const clean = change('clean.ts');
		const user = change('user.ts');
		run = async () => {
			files.set(clean.before.resource, 'command output');
			models.set(user.before.resource, 'user typed'); dirty.add(user.before.resource);
			return { ...completed, exitCode: 1 };
		};
		await session.run(command, editing(), CancellationToken.None);
		assert.deepStrictEqual({ clean: models.get(clean.before.resource), user: models.get(user.before.resource), refreshed },
			{ clean: 'command output', user: 'user typed', refreshed: [clean.before.resource] });
	});

	test('user cancellation refreshes command-written files before returning', async () => {
		const edited = change();
		const started = new DeferredPromise<void>();
		const stopped = new DeferredPromise<ICloudCodeCommandResult>();
		const token = disposables.add(new CancellationTokenSource());
		run = async () => { files.set(edited.before.resource, 'command output'); started.complete(); return stopped.p; };
		cancel = async () => { stopped.complete({ ...completed, cancelled: true, exitCode: null }); };
		const operation = session.run(command, editing(), token.token);
		await started.p;
		token.cancel();
		await assert.rejects(operation, /Canceled/);
		assert.deepStrictEqual({ buffer: models.get(edited.before.resource), refreshed }, { buffer: 'command output', refreshed: [edited.before.resource] });
	});

	test('termination failure remains fatal when Stop is requested and cleanup cannot mask it', async () => {
		change();
		const started = new DeferredPromise<void>();
		const stopped = new DeferredPromise<ICloudCodeCommandResult>();
		const token = disposables.add(new CancellationTokenSource());
		run = async () => { started.complete(); return stopped.p; };
		cancel = async () => { stopped.complete({ ...completed, cancelled: true, exitCode: null, failure: 'termination_failed' }); };
		reload = async () => { throw new Error('Provider detail must not mask termination'); };
		const operation = session.run(command, editing(), token.token);
		await started.p;
		token.cancel();
		await assert.rejects(operation, error => error instanceof CloudCodeAgentExecutionError && error.fatal && error.message.includes('could not confirm that the command stopped'));
		assert.deepStrictEqual(refreshed, []);
		assert.ok(output.join('').includes('Check for running processes and restart CloudCode'));
	});

	test('a rejected cancel operation cannot be disguised as an ordinary cancellation', async () => {
		const started = new DeferredPromise<void>();
		const stopped = new DeferredPromise<ICloudCodeCommandResult>();
		const token = disposables.add(new CancellationTokenSource());
		run = async () => { started.complete(); return stopped.p; };
		cancel = async () => { stopped.complete(completed); throw new Error('Transport detail'); };
		const operation = session.run(command, editing(), token.token);
		await started.p;
		token.cancel();
		await assert.rejects(operation, error => error instanceof CloudCodeAgentExecutionError && error.fatal && !error.message.includes('Transport detail'));
	});

	test('unexpected reload failures stop the loop with a safe fatal explanation even after Stop', async () => {
		change();
		const started = new DeferredPromise<void>();
		const stopped = new DeferredPromise<ICloudCodeCommandResult>();
		const token = disposables.add(new CancellationTokenSource());
		run = async () => { started.complete(); return stopped.p; };
		cancel = async () => { stopped.complete({ ...completed, cancelled: true }); };
		reload = async () => { throw new Error('Private provider response'); };
		const operation = session.run(command, editing(), token.token);
		await started.p;
		token.cancel();
		await assert.rejects(operation, error => error instanceof CloudCodeAgentExecutionError && error.fatal && error.message.includes('could not refresh') && !error.message.includes('Private provider'));
	});

	test('known runner failures have fixed user-facing explanations', async () => {
		run = async () => ({ ...completed, exitCode: null, failure: 'launch_failed' });
		await assert.rejects(session.run(command, editing(), CancellationToken.None), error => error instanceof CloudCodeAgentExecutionError && !error.fatal && error.message.includes('could not start'));
		run = async () => ({ ...completed, failure: 'background_processes' });
		await assert.rejects(session.run(command, editing(), CancellationToken.None), error => error instanceof CloudCodeAgentExecutionError && error.message.includes('background processes'));
	});
});

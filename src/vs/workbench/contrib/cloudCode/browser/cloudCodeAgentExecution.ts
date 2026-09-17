/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isWindows } from '../../../../base/common/platform.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { CLOUDCODE_MAX_COMMAND_LENGTH, CLOUDCODE_MAX_COMMAND_TIMEOUT_MS, ICloudCodeCommandResult, ICloudCodeCommandService } from '../../../../platform/cloudCode/common/cloudCodeCommand.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileOperationError, FileOperationResult, IFileService, IFileStatWithPartialMetadata } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { SaveReason } from '../../../common/editor.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { ITextFileService, TextFileEditorModelState } from '../../../services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { CLOUDCODE_COMMAND_OUTPUT_CHANNEL, CloudCodeAgentCommandResult, CloudCodeAgentExecutionError, ICloudCodeAgentCommand, ICloudCodeAgentExecutionFactory, ICloudCodeAgentExecutionSession } from '../common/cloudCodeAgentExecution.js';
import { ICloudCodeEditingSession, ICloudCodeSessionChange } from '../common/cloudCodeEditingSession.js';

/** Creates fresh consent for every Agent task; consent is never persisted or shared with a later request. */
export class CloudCodeAgentExecutionFactory implements ICloudCodeAgentExecutionFactory {
	readonly shell = isWindows ? 'cmd' : 'sh';

	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) { }

	createSession(): ICloudCodeAgentExecutionSession {
		return this.instantiationService.createInstance(CloudCodeAgentExecutionSession);
	}
}

/** Runs approved commands against saved checkpoints in the real, trusted local workspace. */
export class CloudCodeAgentExecutionSession extends Disposable implements ICloudCodeAgentExecutionSession {
	private readonly folders: readonly Pick<IWorkspaceFolder, 'name' | 'uri'>[];
	private readonly lifetime = this._register(new CancellationTokenSource());
	private allowTask = false;
	private revoked = false;
	private busy = false;
	private activeRequest: string | undefined;
	private cancelling: Promise<boolean> | undefined;

	constructor(
		@IDialogService private readonly dialogService: IDialogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustService: IWorkspaceTrustManagementService,
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IModelService private readonly modelService: IModelService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ICloudCodeCommandService private readonly commandService: ICloudCodeCommandService,
		@IOutputService private readonly outputService: IOutputService,
	) {
		super();
		this.folders = workspaceContextService.getWorkspace().folders.map(folder => ({ name: folder.name, uri: folder.uri }));
		this._register(workspaceTrustService.onDidChangeTrust(trusted => { if (!trusted) { this.revoke(); } }));
		this._register(workspaceContextService.onDidChangeWorkspaceFolders(() => this.revoke()));
		this._register(workspaceContextService.onDidChangeWorkbenchState(() => this.revoke()));
	}

	async run(command: ICloudCodeAgentCommand, editingSession: ICloudCodeEditingSession, token: CancellationToken): Promise<CloudCodeAgentCommandResult> {
		if (this.busy) {
			throw new CloudCodeAgentExecutionError(localize('cloudCode.execution.busy', "Wait for the current command to finish."));
		}
		this.busy = true;
		const operation = new DisposableStore();
		const cancellation = operation.add(new CancellationTokenSource(token));
		operation.add(this.lifetime.token.onCancellationRequested(() => cancellation.cancel()));
		operation.add(cancellation.token.onCancellationRequested(() => { this.allowTask = false; this.cancelActive(); }));
		try {
			this.check(cancellation.token);
			if (!command.command.trim() || command.command.length > CLOUDCODE_MAX_COMMAND_LENGTH || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command.command)) {
				throw new CloudCodeAgentExecutionError(localize('cloudCode.execution.invalidCommand', "Provide a nonempty command without control characters, up to 8,192 characters."));
			}
			const cwd = this.commandDirectory(command);
			await this.assertSafePath(cwd, true, cancellation.token);
			const changes = editingSession.changes;
			const reviewedChanges = JSON.stringify(changes);
			this.assertCleanWorkspace(changes);
			if (changes.length) {
				await editingSession.preview();
				this.check(cancellation.token);
			}
			if (!this.allowTask) {
				const result = await raceCancellationError(this.dialogService.confirm({
					type: 'question',
					message: localize('cloudCode.execution.confirm', "Run this command in your project?"),
					detail: this.confirmationDetail(command, cwd, changes),
					primaryButton: changes.length ? localize('cloudCode.execution.applyRun', "Apply Changes and Run") : localize('cloudCode.execution.run', "Run Command"),
					cancelButton: localize('cloudCode.execution.deny', "Don't Run"),
					checkbox: { label: localize('cloudCode.execution.allowTask', "Allow Further Edits and Commands for This Task"), checked: false },
					custom: true,
					token: cancellation.token,
				}), cancellation.token);
				this.check(cancellation.token);
				if (!result.confirmed) { return { denied: true }; }
				this.allowTask = result.checkboxChecked === true;
			}
			await this.assertSafePath(cwd, true, cancellation.token);
			this.assertCleanWorkspace(changes);
			if (JSON.stringify(editingSession.changes) !== reviewedChanges) { throw this.changedError(); }
			if (changes.length) {
				await editingSession.apply();
				this.check(cancellation.token);
				await this.saveCheckpoint(changes, cancellation.token);
			}
			await this.assertSafePath(cwd, true, cancellation.token);
			this.assertCleanWorkspace([]);
			for (const change of changes) {
				if (change.after.content !== undefined) { this.assertModelContent(URI.parse(change.after.resource), change.after.content); }
			}
			this.check(cancellation.token);
			this.activeRequest = generateUuid();
			this.appendOutput(localize('cloudCode.execution.outputCommand', "\nCommand: {0}\nDirectory: {1}\n", command.command, cwd.fsPath));
			let result: ICloudCodeCommandResult | undefined;
			try {
				result = await this.commandService.run(this.activeRequest, command.command, cwd.fsPath, CLOUDCODE_MAX_COMMAND_TIMEOUT_MS);
			} catch {
				// Transport/provider errors have no trustworthy process-lifetime information.
			}
			// Termination failure must survive Stop and must never be hidden by cleanup or cancellation.
			const cancelledSafely = this.cancelling ? await this.cancelling : true;
			this.activeRequest = undefined;
			this.cancelling = undefined;
			if (!result || !cancelledSafely || result.failure === 'termination_failed') {
				const failure = new CloudCodeAgentExecutionError(localize('cloudCode.execution.terminationFailed', "CloudCode could not confirm that the command stopped. Check for running processes and restart CloudCode before retrying."), true);
				this.appendOutput(failure.message + '\n');
				this.revoke();
				throw failure;
			}
			this.writeResult(result);
			// User cancellation does not make already-written source disappear. Refresh using a cleanup
			// token, while still checking workspace identity and trust before and after every read.
			this.check(CancellationToken.None);
			await this.refreshCleanModels(CancellationToken.None);
			if (result.failure === 'launch_failed') {
				throw new CloudCodeAgentExecutionError(localize('cloudCode.execution.launchFailed', "The command could not start. Check the command, working directory, and installed tools before retrying."));
			}
			if (result.failure === 'background_processes') {
				throw new CloudCodeAgentExecutionError(localize('cloudCode.execution.backgroundProcesses', "The command left background processes running, so CloudCode stopped them. Use a foreground command that exits when its work is complete."));
			}
			this.check(cancellation.token);
			return result;
		} finally {
			operation.dispose();
			this.busy = false;
		}
	}

	override dispose(): void {
		this.revoke();
		super.dispose();
	}

	private revoke(): void {
		this.revoked = true;
		this.allowTask = false;
		this.lifetime.cancel();
		this.cancelActive();
	}

	private cancelActive(): void {
		if (this.activeRequest && !this.cancelling) {
			// Observe rejection immediately, then report it after the run has settled.
			this.cancelling = this.commandService.cancel(this.activeRequest).then(() => true, () => false);
		}
	}

	private check(token: CancellationToken): void {
		if (this.revoked || this._store.isDisposed || token.isCancellationRequested) { throw new CancellationError(); }
		if (!this.workspaceTrustService.isWorkspaceTrusted()) {
			throw new CloudCodeAgentExecutionError(localize('cloudCode.execution.trust', "Trust this workspace before running Agent commands."));
		}
		const current = this.workspaceContextService.getWorkspace().folders;
		if (current.length !== this.folders.length || current.some((folder, index) => folder.name !== this.folders[index].name || !this.uriIdentityService.extUri.isEqual(folder.uri, this.folders[index].uri))) {
			this.revoke();
			throw new CancellationError();
		}
		if (!this.folders.length || this.folders.some(folder => folder.uri.scheme !== Schemas.file || !!folder.uri.authority)) {
			throw new CloudCodeAgentExecutionError(localize('cloudCode.execution.localOnly', "Agent commands require an open local project folder. Remote and virtual workspaces are not supported yet."));
		}
	}

	private commandDirectory(command: ICloudCodeAgentCommand): URI {
		const folder = this.folders.find((_folder, index) => String(index + 1) === command.root);
		const path = command.path === '.' ? '' : command.path;
		if (!folder || path.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(path) || (path && path.split('/').some(segment => !segment || segment === '.' || segment === '..'))) {
			throw new CloudCodeAgentExecutionError(localize('cloudCode.execution.path', "Choose a relative directory inside an available project root."));
		}
		const resource = path ? joinPath(folder.uri, path) : folder.uri;
		if (!this.uriIdentityService.extUri.isEqualOrParent(resource, folder.uri)) { throw this.changedError(); }
		return resource;
	}

	/** Include ancestors above the opened folder, so an alias in the root path is not mistaken for isolation. */
	private async assertSafePath(resource: URI, directory: boolean, token: CancellationToken): Promise<void> {
		const ancestors: URI[] = [];
		let current = resource;
		while (true) {
			ancestors.push(current);
			const parent = dirname(current);
			if (this.uriIdentityService.extUri.isEqual(parent, current)) { break; }
			current = parent;
		}
		for (const ancestor of ancestors.reverse()) {
			this.check(token);
			let stat: IFileStatWithPartialMetadata;
			try {
				stat = await raceCancellationError(this.fileService.stat(ancestor), token);
			} catch {
				this.check(token);
				throw new CloudCodeAgentExecutionError(localize('cloudCode.execution.pathUnavailable', "The command's working directory or an edited file is unavailable. Check that the project still exists and is accessible."));
			}
			this.check(token);
			const requiresDirectory = directory || !this.uriIdentityService.extUri.isEqual(ancestor, resource);
			if (stat.isSymbolicLink || (requiresDirectory ? !stat.isDirectory : !stat.isFile)) {
				throw new CloudCodeAgentExecutionError(localize('cloudCode.execution.symlink', "Choose a local directory without symbolic links in its path."));
			}
		}
	}

	private assertCleanWorkspace(changes: readonly ICloudCodeSessionChange[]): void {
		const allowed = new Set(changes.flatMap(change => [change.before.resource, change.after.resource]).map(resource => this.uriIdentityService.extUri.getComparisonKey(URI.parse(resource))));
		for (const copy of this.workingCopyService.dirtyWorkingCopies) {
			if (this.folders.some(folder => this.uriIdentityService.extUri.isEqualOrParent(copy.resource, folder.uri)) && !allowed.has(this.uriIdentityService.extUri.getComparisonKey(copy.resource))) {
				throw new CloudCodeAgentExecutionError(localize('cloudCode.execution.unsaved', "Save or revert other unsaved project files before running commands. Your unsaved changes were preserved."));
			}
		}
	}

	private async saveCheckpoint(changes: readonly ICloudCodeSessionChange[], token: CancellationToken): Promise<void> {
		for (const change of changes) {
			if (change.after.content === undefined) { continue; }
			const resource = URI.parse(change.after.resource);
			await this.assertSafePath(resource, false, token);
			const fileModel = this.textFileService.files.get(resource);
			if (fileModel?.hasState(TextFileEditorModelState.PENDING_SAVE)) {
				await raceCancellationError(fileModel.joinState(TextFileEditorModelState.PENDING_SAVE), token);
				this.check(token);
			}
			this.assertModelContent(resource, change.after.content);
			if (this.textFileService.isDirty(resource)) {
				const saved = await this.textFileService.save(resource, { reason: SaveReason.EXPLICIT, skipSaveParticipants: true, ignoreErrorHandler: true });
				this.check(token);
				if (!saved || !this.uriIdentityService.extUri.isEqual(saved, resource) || this.textFileService.isDirty(resource)) { throw this.changedError(); }
			}
			const saved = await this.textFileService.read(resource, { acceptTextOnly: true, limits: { size: 1024 * 1024 } });
			this.check(token);
			this.assertModelContent(resource, change.after.content);
			if (saved.value !== change.after.content) { throw this.changedError(); }
		}
		for (const change of changes) {
			if (change.after.content !== undefined) { this.assertModelContent(URI.parse(change.after.resource), change.after.content); }
		}
	}

	private assertModelContent(resource: URI, expected: string): void {
		const model = this.modelService.getModel(resource);
		if (model && model.getValue() !== expected) { throw this.changedError(); }
	}

	private appendOutput(value: string): void {
		try {
			this.outputService.getChannel(CLOUDCODE_COMMAND_OUTPUT_CHANNEL)?.append(value);
		} catch {
			// A closed output channel must never conceal command termination or checkpoint errors.
		}
	}

	private writeResult(result: ICloudCodeCommandResult): void {
		if (result.stdout) { this.appendOutput(result.stdout + '\n'); }
		if (result.stderr) { this.appendOutput(localize('cloudCode.execution.stderr', "Standard error:\n{0}\n", result.stderr)); }
		this.appendOutput(localize('cloudCode.execution.outputResult', "Exit code: {0}. Timed out: {1}. Cancelled: {2}. Output truncated: {3}.\n",
			result.exitCode ?? localize('cloudCode.execution.noExitCode', "unavailable"), result.timedOut, result.cancelled, result.truncated));
	}

	/** A fresh editing session must not combine pre-command buffers with post-command disk baselines. */
	private async refreshCleanModels(token: CancellationToken): Promise<void> {
		for (const model of this.textFileService.files.models) {
			this.check(token);
			if (model.isDirty() || !this.folders.some(folder => this.uriIdentityService.extUri.isEqualOrParent(model.resource, folder.uri))) { continue; }
			try {
				await this.textFileService.files.resolve(model.resource, { reload: { async: false }, forceReadFromFile: true });
			} catch (error) {
				if (isCancellationError(error)) { throw error; }
				// Deleted files remain orphaned; the next editing adapter will reject their missing baseline.
				if (!(error instanceof FileOperationError) || error.fileOperationResult !== FileOperationResult.FILE_NOT_FOUND) {
					throw new CloudCodeAgentExecutionError(localize('cloudCode.execution.reloadFailed', "CloudCode could not refresh the files changed by the command. Reload the project before continuing so the Agent does not use stale contents."), true);
				}
			}
			this.check(token);
		}
	}

	private confirmationDetail(command: ICloudCodeAgentCommand, cwd: URI, changes: readonly ICloudCodeSessionChange[]): string {
		const files = changes.map(change => change.kind === 'create' ? change.after.path : change.kind === 'rename' ? `${change.before.path} → ${change.after.path}` : change.before.path).join('\n');
		return localize('cloudCode.execution.detail', "Command:\n{0}\n\nDirectory:\n{1}\n\nPurpose:\n{2}\n\n{3}\n\nThe command runs with your computer's permissions. Its output will be sent to the selected model. Undo Checkpoint only restores CloudCode edits; it does not reverse other changes made by commands.",
			command.command, cwd.fsPath, command.explanation,
			changes.length ? localize('cloudCode.execution.files', "Apply and save these files, including any existing unsaved changes in them:\n{0}", files) : localize('cloudCode.execution.noEdits', "There are no staged edits to apply."));
	}

	private changedError(): CloudCodeAgentExecutionError {
		return new CloudCodeAgentExecutionError(localize('cloudCode.execution.changed', "The project changed or could not be saved as reviewed. The command was not started. Review the applied checkpoint and your current files."));
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn, SpawnOptionsWithoutStdio } from 'child_process';
import { lstat } from 'fs/promises';
import { isAbsolute, win32 } from 'path';
import { StringDecoder } from 'string_decoder';
import { DeferredPromise, disposableTimeout } from '../../../base/common/async.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { isWindows } from '../../../base/common/platform.js';
import { removeAnsiEscapeCodes } from '../../../base/common/strings.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { killTree } from '../../../base/node/processes.js';
import { localize } from '../../../nls.js';
import { CLOUDCODE_MAX_COMMAND_LENGTH, CLOUDCODE_MAX_COMMAND_OUTPUT_BYTES, CLOUDCODE_MAX_COMMAND_TIMEOUT_MS, ICloudCodeCommandResult, ICloudCodeCommandService } from '../common/cloudCodeCommand.js';
import { cloudCodeWindowsCommandArguments, CloudCodeWindowsCommandOutput } from './cloudCodeWindowsCommand.js';

const maximumConcurrentCommands = 4;
const terminationTimeoutMs = 5000;
const pipeDrainTimeoutMs = 1000;
const outputMarker = localize('cloudcode.commandOutputTruncated', "\n[... output truncated ...]\n");

/** Injectable process boundary, also used to exercise Windows launch/termination on other hosts. */
export interface ICloudCodeCommandRuntime {
	readonly windows: boolean;
	validateCwd(cwd: string): Promise<void>;
	spawn(executable: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcess;
	terminate(pid: number): Promise<void>;
}

const commandRuntime: ICloudCodeCommandRuntime = {
	windows: isWindows,
	validateCwd: async cwd => {
		const stat = await lstat(cwd);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(localize('cloudcode.commandDirectory', "Choose an existing workspace directory that is not a symbolic link."));
		}
	},
	spawn: (executable, args, options) => spawn(executable, args, { ...options, stdio: [isWindows ? 'pipe' : 'ignore', 'pipe', 'pipe'] }),
	terminate: async pid => {
		if (isWindows) {
			await killTree(pid, true);
		} else {
			// Each command owns a new process group. It remains addressable even if its shell exits
			// while a child keeps a pipe open, unlike a tree walk rooted at the departed shell PID.
			try {
				process.kill(-pid, 'SIGKILL');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
					throw error;
				}
			}
		}
	},
};

interface ICommandRun {
	cancelled: boolean;
	timedOut: boolean;
	readonly done: DeferredPromise<void>;
	readonly stop: DeferredPromise<void>;
	terminationError?: Error;
}

interface IOutputChunk {
	readonly stream: 'stdout' | 'stderr';
	data: Buffer;
}

/** Keeps one shared head/tail budget across both streams, including multibyte output. */
class CommandOutput {
	private readonly head: IOutputChunk[] = [];
	private readonly tail: IOutputChunk[] = [];
	private headBytes = 0;
	private tailBytes = 0;
	private readonly halfLimit = Math.max(0, Math.floor((CLOUDCODE_MAX_COMMAND_OUTPUT_BYTES - 2 * Buffer.byteLength(outputMarker) - 16) / 2));
	truncated = false;

	append(stream: IOutputChunk['stream'], text: string): void {
		let data = Buffer.from(text);
		if (this.headBytes < this.halfLimit) {
			const length = Math.min(this.halfLimit - this.headBytes, data.length);
			this.head.push({ stream, data: data.subarray(0, length) });
			this.headBytes += length;
			data = data.subarray(length);
		}
		if (data.length > 0) {
			this.tail.push({ stream, data });
			this.tailBytes += data.length;
		}
		while (this.tailBytes > this.halfLimit) {
			this.truncated = true;
			const first = this.tail[0];
			const removed = Math.min(this.tailBytes - this.halfLimit, first.data.length);
			first.data = first.data.subarray(removed);
			this.tailBytes -= removed;
			if (first.data.length === 0) {
				this.tail.shift();
			}
		}
	}

	text(stream: IOutputChunk['stream']): string {
		const head = Buffer.concat(this.head.filter(chunk => chunk.stream === stream).map(chunk => chunk.data));
		const tail = Buffer.concat(this.tail.filter(chunk => chunk.stream === stream).map(chunk => chunk.data));
		let text: string;
		if (this.truncated) {
			// Discard incomplete UTF-8 characters cut by the retained head/tail boundaries.
			let start = 0;
			while (start < tail.length && (tail[start] & 0xc0) === 0x80) { start++; }
			text = new StringDecoder('utf8').write(head) + (head.length || tail.length ? outputMarker : '') + tail.subarray(start).toString('utf8');
		} else {
			text = Buffer.concat([head, tail]).toString('utf8');
		}
		return removeAnsiEscapeCodes(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
	}
}

/** Runs a bounded, non-interactive command without coupling local execution to inference auth. */
export class CloudCodeCommandService extends Disposable implements ICloudCodeCommandService {
	declare readonly _serviceBrand: undefined;
	private readonly runs = new Map<string, ICommandRun>();
	private disposed = false;
	private terminationFailed = false;

	constructor(private readonly runtime: ICloudCodeCommandRuntime = commandRuntime) {
		super();
	}

	async run(requestId: string, command: string, cwd: string, timeoutMs: number): Promise<ICloudCodeCommandResult> {
		if (this.terminationFailed) {
			return { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: false, truncated: false, failure: 'termination_failed' };
		}
		if (this.disposed || typeof requestId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(requestId)
			|| typeof command !== 'string' || !command.trim() || command.length > CLOUDCODE_MAX_COMMAND_LENGTH || command.includes('\0')
			|| typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0') || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CLOUDCODE_MAX_COMMAND_TIMEOUT_MS) {
			throw new Error(localize('cloudcode.invalidCommand', "The command, working directory, or time limit is invalid."));
		}
		if (this.runs.has(requestId) || this.runs.size >= maximumConcurrentCommands) {
			throw new Error(localize('cloudcode.commandBusy', "CloudCode already has too many commands running, or this command was already started."));
		}
		const run: ICommandRun = { cancelled: false, timedOut: false, done: new DeferredPromise<void>(), stop: new DeferredPromise<void>() };
		this.runs.set(requestId, run);
		const store = new DisposableStore();
		store.add(disposableTimeout(() => {
			run.timedOut = true;
			run.stop.complete();
		}, timeoutMs));
		try {
			try {
				await this.bounded(this.runtime.validateCwd(cwd), terminationTimeoutMs, localize('cloudcode.commandDirectoryTimeout', "The command directory could not be checked in time."));
			} catch {
				return { exitCode: null, stdout: '', stderr: '', timedOut: run.timedOut, cancelled: run.cancelled, truncated: false, failure: 'launch_failed' };
			}
			if (run.cancelled || run.timedOut) {
				return { exitCode: null, stdout: '', stderr: '', timedOut: run.timedOut, cancelled: run.cancelled, truncated: false };
			}
			return await this.execute(run, command, cwd, store);
		} finally {
			store.dispose();
			this.runs.delete(requestId);
			run.done.complete();
		}
	}

	async cancel(requestId: string): Promise<void> {
		const run = this.runs.get(requestId);
		if (run) {
			run.cancelled = true;
			run.stop.complete();
			await run.done.p;
			if (run.terminationError) {
				throw run.terminationError;
			}
		}
	}

	override dispose(): void {
		this.disposed = true;
		for (const run of this.runs.values()) {
			run.cancelled = true;
			run.stop.complete();
		}
		super.dispose();
	}

	private async execute(run: ICommandRun, command: string, cwd: string, store: DisposableStore): Promise<ICloudCodeCommandResult> {
		const executable = this.runtime.windows ? win32.join(process.env['WINDIR'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
		const args = this.runtime.windows ? cloudCodeWindowsCommandArguments() : ['-c', command];
		let child: ChildProcess;
		try {
			child = this.runtime.spawn(executable, args, {
				cwd, windowsHide: true, detached: !this.runtime.windows,
				env: { ...process.env, CI: '1', NO_COLOR: '1', TERM: 'dumb', FORCE_COLOR: '0' },
			});
		} catch {
			return { exitCode: null, stdout: '', stderr: '', timedOut: run.timedOut, cancelled: run.cancelled, truncated: false, failure: 'launch_failed' };
		}
		const output = new CommandOutput();
		const nonce = generateUuid();
		const windowsOutput = this.runtime.windows ? new CloudCodeWindowsCommandOutput(nonce, text => output.append('stderr', text)) : undefined;
		const closed = new DeferredPromise<void>();
		const background = new DeferredPromise<void>();
		let exitCode: number | null = null;
		let launchError: Error | undefined;
		let failure: ICloudCodeCommandResult['failure'];
		const unconfirmed = () => {
			this.terminationFailed = true;
			failure = 'termination_failed';
			run.terminationError = new Error(localize('cloudcode.commandStopFailed', "CloudCode could not confirm that the command and its child processes stopped. Check their state and restart CloudCode before running another command."));
		};
		const onError = (error: Error) => {
			launchError = error;
			closed.complete();
		};
		const onExit = (code: number | null) => {
			exitCode = code;
			store.add(disposableTimeout(() => background.complete(), pipeDrainTimeoutMs));
		};
		const onClose = () => { closed.complete(); };
		const onStdout = (text: string) => output.append('stdout', text);
		const onStderr = (text: string) => windowsOutput ? windowsOutput.append(text) : output.append('stderr', text);
		const onInputError = () => { run.stop.complete(); };
		child.on('error', onError);
		child.on('exit', onExit);
		child.on('close', onClose);
		child.stdout?.setEncoding('utf8').on('data', onStdout);
		child.stderr?.setEncoding('utf8').on('data', onStderr);
		child.stdin?.on('error', onInputError);
		store.add(toDisposable(() => {
			child.removeListener('error', onError);
			child.removeListener('exit', onExit);
			child.removeListener('close', onClose);
			child.stdout?.removeListener('data', onStdout);
			child.stderr?.removeListener('data', onStderr);
			child.stdin?.removeListener('error', onInputError);
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
		}));
		if (this.runtime.windows) {
			if (child.stdin) {
				child.stdin.write(JSON.stringify({ command, cwd, nonce }) + '\n');
			} else {
				run.stop.complete();
			}
		}
		const completion = await Promise.race([closed.p.then(() => 'closed'), run.stop.p.then(() => 'stopped'), background.p.then(() => 'background')]);
		if (completion !== 'closed') {
			try {
				if (this.runtime.windows) {
					// The supervisor terminates its job and verifies it is empty before acknowledging.
					// Killing the supervisor directly would provide no such termination proof.
					child.stdin?.end('cancel\n');
					await this.bounded(closed.p, terminationTimeoutMs * 2, localize('cloudcode.commandStopTimeout', "The command could not be stopped in time."));
				} else if (child.pid) {
					await this.bounded(this.runtime.terminate(child.pid), terminationTimeoutMs, localize('cloudcode.commandStopTimeout', "The command could not be stopped in time. Check its processes before running another command."));
				}
				await this.bounded(closed.p, terminationTimeoutMs, localize('cloudcode.commandStillRunning', "CloudCode could not confirm that the command stopped. Check its processes before running another command."));
			} catch {
				unconfirmed();
				if (this.runtime.windows && child.pid) {
					try {
						await this.bounded(this.runtime.terminate(child.pid), terminationTimeoutMs, '');
						await this.bounded(closed.p, terminationTimeoutMs, '');
					} catch { /* The result remains termination_failed even if the fallback kill succeeds. */ }
				}
			}
			if (completion === 'background' && !failure && !this.runtime.windows) {
				failure = 'background_processes';
			}
		}
		// Closing stdout/stderr does not imply that every child exited. Clean up any remaining
		// members of our POSIX process group even after an otherwise successful shell exit.
		if (completion === 'closed' && child.pid && !this.runtime.windows) {
			try {
				await this.bounded(this.runtime.terminate(child.pid), terminationTimeoutMs, localize('cloudcode.commandCleanupTimeout', "The command's child processes could not be stopped in time."));
			} catch {
				unconfirmed();
			}
		}
		if (launchError) {
			failure = child.pid ? 'termination_failed' : 'launch_failed';
		}
		const status = windowsOutput?.finish();
		if (windowsOutput && !launchError) {
			if (!status || status.failure === 'termination_failed') {
				unconfirmed();
			} else if (failure !== 'termination_failed') {
				exitCode = status.exitCode;
				failure = status.failure;
			}
		}
		if (failure === 'termination_failed') {
			unconfirmed();
			exitCode = null;
		}
		return { exitCode, stdout: output.text('stdout'), stderr: output.text('stderr'), timedOut: run.timedOut, cancelled: run.cancelled, truncated: output.truncated, ...(failure ? { failure } : {}) };
	}

	private async bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
		const expired = new DeferredPromise<T>();
		const timer = disposableTimeout(() => expired.error(new Error(message)), milliseconds);
		try {
			return await Promise.race([promise, expired.p]);
		} finally {
			timer.dispose();
		}
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { isWindows } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { killTree } from '../../../../base/node/processes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLOUDCODE_MAX_COMMAND_LENGTH, CLOUDCODE_MAX_COMMAND_OUTPUT_BYTES, CLOUDCODE_MAX_COMMAND_TIMEOUT_MS } from '../../common/cloudCodeCommand.js';
import { CloudCodeCommandService, ICloudCodeCommandRuntime } from '../../node/cloudCodeCommandService.js';

suite('CloudCode command service', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let directory: string;
	setup(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'cloudcode-command-'))); });
	teardown(async () => { await rm(directory, { recursive: true, force: true }); });

	function command(script: string): string {
		const executable = isWindows ? `"${process.execPath}"` : `'${process.execPath.replace(/'/g, `'\\''`)}'`;
		return `${executable} -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString())"`;
	}

	async function terminate(pid: number): Promise<void> {
		if (isWindows) {
			await killTree(pid, true);
		} else {
			try { process.kill(-pid, 'SIGKILL'); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; }
			}
		}
	}

	function runtime(overrides: Partial<ICloudCodeCommandRuntime> = {}): ICloudCodeCommandRuntime {
		return {
			windows: isWindows,
			validateCwd: async () => { },
			spawn: (executable, args, options) => spawn(executable, args, { ...options, stdio: [isWindows ? 'pipe' : 'ignore', 'pipe', 'pipe'] }),
			terminate,
			...overrides,
		};
	}

	test('captures separate streams, exact nonzero exit, working directory, and noninteractive environment', async () => {
		const service = store.add(new CloudCodeCommandService());
		const result = await service.run(generateUuid(), command(`process.stdout.write(JSON.stringify({cwd:process.cwd(),ci:process.env.CI,color:process.env.NO_COLOR}));process.stderr.write('failed check');process.exitCode=7;`), directory, 5000);
		assert.deepStrictEqual({ ...result, stdout: JSON.parse(result.stdout) }, {
			exitCode: 7, stdout: { cwd: directory, ci: '1', color: '1' }, stderr: 'failed check', timedOut: false, cancelled: false, truncated: false,
		});
	});

	test('closes stdin and strips split terminal escape sequences', async () => {
		const service = store.add(new CloudCodeCommandService());
		const result = await service.run(generateUuid(), command(`process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('\x1b[');setTimeout(()=>process.stdout.write('31mfinished\x1b[0m\x07'),20);});`), directory, 5000);
		assert.deepStrictEqual(result, { exitCode: 0, stdout: 'finished', stderr: '', timedOut: false, cancelled: false, truncated: false });
	});

	test('preserves command stderr that resembles PowerShell progress serialization', async () => {
		const service = store.add(new CloudCodeCommandService());
		const stderr = '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">command error</S></Objs>\nPreparing modules for first use.\n';
		const result = await service.run(generateUuid(), command(`process.stderr.write(${JSON.stringify(stderr)});`), directory, 5000);
		assert.deepStrictEqual(result, { exitCode: 0, stdout: '', stderr, timedOut: false, cancelled: false, truncated: false });
	});

	test('retains bounded UTF-8 head and tail across both output streams', async () => {
		const service = store.add(new CloudCodeCommandService());
		const result = await service.run(generateUuid(), command(`process.stdout.write('first:'+ '😀'.repeat(10000));process.stderr.write('字'.repeat(10000)+':last');`), directory, 5000);
		assert.deepStrictEqual({
			code: result.exitCode, truncated: result.truncated, head: result.stdout.startsWith('first:'), tail: result.stderr.endsWith(':last'),
			bounded: Buffer.byteLength(result.stdout + result.stderr) <= CLOUDCODE_MAX_COMMAND_OUTPUT_BYTES,
			valid: !(result.stdout + result.stderr).includes('\ufffd'), marker: result.stdout.includes('output truncated'),
		}, { code: 0, truncated: true, head: true, tail: true, bounded: true, valid: true, marker: true });
	});

	test('rejects invalid commands, paths, time limits, and request identifiers before spawning', async () => {
		let spawned = false;
		const service = store.add(new CloudCodeCommandService(runtime({ spawn: () => { spawned = true; throw new Error('must not spawn'); } })));
		for (const [id, text, cwd, milliseconds] of [
			['bad-id', 'echo ok', directory, 100], [generateUuid(), '', directory, 100], [generateUuid(), 'a'.repeat(CLOUDCODE_MAX_COMMAND_LENGTH + 1), directory, 100],
			[generateUuid(), 'echo\0ok', directory, 100], [generateUuid(), 'echo ok', 'relative', 100],
			[generateUuid(), 'echo ok', directory, 0], [generateUuid(), 'echo ok', directory, CLOUDCODE_MAX_COMMAND_TIMEOUT_MS + 1],
		] as const) {
			await assert.rejects(service.run(id, text, cwd, milliseconds), /invalid/);
		}
		assert.strictEqual(spawned, false);
	});

	test('rejects missing directories and ordinary files', async () => {
		const service = store.add(new CloudCodeCommandService());
		const file = join(directory, 'file');
		await writeFile(file, 'content');
		assert.strictEqual((await service.run(generateUuid(), 'echo ok', join(directory, 'missing'), 1000)).failure, 'launch_failed');
		assert.strictEqual((await service.run(generateUuid(), 'echo ok', file, 1000)).failure, 'launch_failed');
	});

	test('rejects a symbolic link as command directory', async () => {
		const service = store.add(new CloudCodeCommandService());
		const link = join(directory, 'link');
		await symlink(directory, link, isWindows ? 'junction' : 'dir');
		assert.strictEqual((await service.run(generateUuid(), 'echo ok', link, 1000)).failure, 'launch_failed');
	});

	test('cancellation during directory validation never spawns and waits for run settlement', async () => {
		const validated = new DeferredPromise<void>();
		let spawned = false;
		let cancellationCompleted = false;
		const service = store.add(new CloudCodeCommandService(runtime({ validateCwd: () => validated.p, spawn: () => { spawned = true; throw new Error('must not spawn'); } })));
		const id = generateUuid();
		const running = service.run(id, 'echo ok', directory, 5000);
		const cancelling = service.cancel(id).then(() => { cancellationCompleted = true; });
		await Promise.resolve();
		assert.strictEqual(cancellationCompleted, false);
		validated.complete();
		const result = await running;
		await cancelling;
		assert.deepStrictEqual({ spawned, result }, { spawned: false, result: { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true, truncated: false } });
	});

	test('bounds concurrent runs and rejects duplicate request identifiers', async () => {
		const validated = new DeferredPromise<void>();
		const service = store.add(new CloudCodeCommandService(runtime({ validateCwd: () => validated.p })));
		const ids = Array.from({ length: 4 }, () => generateUuid());
		const runs = ids.map(id => service.run(id, 'echo ok', directory, 5000));
		await assert.rejects(service.run(ids[0], 'echo ok', directory, 5000), /already/);
		await assert.rejects(service.run(generateUuid(), 'echo ok', directory, 5000), /too many/);
		const cancellations = ids.map(id => service.cancel(id));
		validated.complete();
		assert.deepStrictEqual((await Promise.all(runs)).map(result => result.cancelled), [true, true, true, true]);
		await Promise.all(cancellations);
	});

	test('reports launch failure without claiming successful command completion', async () => {
		const service = store.add(new CloudCodeCommandService(runtime({ spawn: (_executable, _args, options) => spawn(join(directory, 'missing-shell'), [], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }) })));
		assert.strictEqual((await service.run(generateUuid(), 'echo ok', directory, 1000)).failure, 'launch_failed');
	});

	test('timeout stops the foreground command and its child before returning', async function () {
		this.timeout(20000);
		const service = store.add(new CloudCodeCommandService());
		const marker = join(directory, 'orphan');
		const delay = isWindows ? 8000 : 1800;
		const childScript = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),${delay});`;
		const result = await service.run(generateUuid(), command(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'});process.stdout.write('started');setInterval(()=>{},1000);`), directory, isWindows ? 6000 : 500);
		assert.strictEqual(result.stdout, 'started');
		await timeout(delay + 100);
		await assert.rejects(readFile(marker), { code: 'ENOENT' });
		assert.deepStrictEqual({ failed: result.exitCode !== 0, timedOut: result.timedOut, cancelled: result.cancelled }, { failed: true, timedOut: true, cancelled: false });
	});

	test('explicit cancellation awaits command termination', async () => {
		const started = new DeferredPromise<void>();
		const service = store.add(new CloudCodeCommandService(runtime({ spawn: (executable, args, options) => {
			const child = spawn(executable, args, { ...options, stdio: [isWindows ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
			child.once('spawn', () => started.complete());
			return child;
		} })));
		const id = generateUuid();
		const running = service.run(id, command('setInterval(()=>{},1000)'), directory, 5000);
		await started.p;
		await service.cancel(id);
		const result = await running;
		assert.deepStrictEqual({ failed: result.exitCode !== 0, cancelled: result.cancelled, timeout: result.timedOut }, { failed: true, cancelled: true, timeout: false });
	});

	test('cancels a started command and its child through the real platform supervisor', async function () {
		this.timeout(20000);
		const service = store.add(new CloudCodeCommandService());
		const ready = join(directory, 'ready');
		const orphan = join(directory, 'cancelled-child');
		const childScript = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(orphan)},'orphan'),1800);`;
		const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
		const id = generateUuid();
		const running = service.run(id, command(script), directory, 15000);
		try {
			const deadline = Date.now() + 10000;
			let started = false;
			while (Date.now() < deadline) {
				try { started = (await readFile(ready, 'utf8')) === 'ready'; } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
				}
				if (started) { break; }
				await timeout(50);
			}
			assert.ok(started, 'The command must start before its cancellation is tested');
			await service.cancel(id);
			const result = await running;
			await timeout(1900);
			await assert.rejects(readFile(orphan), { code: 'ENOENT' });
			assert.deepStrictEqual({ cancelled: result.cancelled, failure: result.failure }, { cancelled: true, failure: undefined });
		} finally {
			await service.cancel(id);
			await running;
		}
	});

	test('stops inherited pipes after the shell exits instead of hanging indefinitely', async function () {
		this.timeout(15000);
		const service = store.add(new CloudCodeCommandService());
		const marker = join(directory, 'inherited-pipes');
		const childScript = `process.stdout.write('started');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),2000);setInterval(()=>{},1000);process.send('ready');`;
		// Windows detachment avoids Node's own kill-on-exit job; the child still inherits the
		// supervisor's job. POSIX children must remain in the command's process group.
		const script = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:${isWindows},stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>{child.disconnect();child.unref();});`;
		const result = await service.run(generateUuid(), command(script), directory, 10000);
		await timeout(2100);
		await assert.rejects(readFile(marker), { code: 'ENOENT' });
		assert.deepStrictEqual({ exitCode: result.exitCode, stdout: result.stdout, failure: result.failure, timedOut: result.timedOut, cancelled: result.cancelled }, {
			exitCode: 0, stdout: 'started', failure: 'background_processes', timedOut: false, cancelled: false,
		});
	});

	test('cleans up owned children even when they do not retain output pipes', async function () {
		this.timeout(15000);
		const service = store.add(new CloudCodeCommandService());
		const marker = join(directory, 'background');
		const childScript = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'background'),1000);`;
		const result = await service.run(generateUuid(), command(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'}).unref();`), directory, 10000);
		await timeout(1100);
		await assert.rejects(readFile(marker), { code: 'ENOENT' });
		assert.strictEqual(result.exitCode, 0);
	});

	test('passes command data over stdin and awaits the Windows supervisor acknowledgement', async () => {
		let executable = '';
		let argumentsReceived: string[] = [];
		let childProcess: ChildProcess | undefined;
		const started = new DeferredPromise<void>();
		const service = store.add(new CloudCodeCommandService(runtime({
			windows: true,
			spawn: (file, args, options) => {
				executable = file;
				argumentsReceived = args;
				assert.deepStrictEqual({ hidden: options.windowsHide, detached: options.detached }, { hidden: true, detached: false });
				const script = `let input='';process.stdin.on('data',chunk=>{input+=chunk;const lines=input.split('\\n');if(lines.length>2){const request=JSON.parse(lines[0]);process.stdout.write(request.command);process.stderr.write('\\x1eCLOUDCODE_COMMAND_RESULT:'+request.nonce+':null:ok\\n');process.exit(0);}});`;
				childProcess = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
				childProcess.once('spawn', () => started.complete());
				return childProcess;
			},
			terminate: async () => { throw new Error('supervisor acknowledgement should avoid forced kill'); },
		})));
		const id = generateUuid();
		const running = service.run(id, 'npm test -- --run', directory, 5000);
		await started.p;
		await service.cancel(id);
		const result = await running;
		assert.deepStrictEqual({ executable: executable.endsWith('\\WindowsPowerShell\\v1.0\\powershell.exe'), flags: argumentsReceived.slice(0, 4), encodedFits: argumentsReceived[4].length < 30000, command: result.stdout, cancelled: result.cancelled, failure: result.failure }, {
			executable: true, flags: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'], encodedFits: true, command: 'npm test -- --run', cancelled: true, failure: undefined,
		});
	});

	test('blocks later runs when termination cannot be confirmed', async () => {
		let childProcess: ChildProcess | undefined;
		const service = store.add(new CloudCodeCommandService(runtime({
			windows: false,
			spawn: (_executable, _args, options) => childProcess = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'] }),
			terminate: async () => { throw new Error('termination failed'); },
		})));
		try {
			assert.strictEqual((await service.run(generateUuid(), command('setInterval(()=>{},1000)'), directory, 100)).failure, 'termination_failed');
			assert.strictEqual((await service.run(generateUuid(), 'echo next', directory, 100)).failure, 'termination_failed');
		} finally {
			if (childProcess?.pid) { await terminate(childProcess.pid); }
		}
	});

	test('missing Windows supervisor acknowledgement is a serializable fatal result', async () => {
		const service = store.add(new CloudCodeCommandService(runtime({
			windows: true,
			spawn: () => spawn(process.execPath, ['-e', `process.stdout.write('command output');`], { stdio: ['pipe', 'pipe', 'pipe'] }),
		})));
		const result = await service.run(generateUuid(), 'echo ok', directory, 5000);
		assert.deepStrictEqual({ code: result.exitCode, output: result.stdout, failure: result.failure }, { code: null, output: 'command output', failure: 'termination_failed' });
		assert.strictEqual((await service.run(generateUuid(), 'echo next', directory, 5000)).failure, 'termination_failed');
	});

	test('Windows setup failure acknowledgement remains a recoverable launch result', async () => {
		const script = `let input='';process.stdin.on('data',chunk=>{input+=chunk;const newline=input.indexOf('\\n');if(newline>=0){const request=JSON.parse(input.slice(0,newline));process.stderr.write('\\x1eCLOUDCODE_COMMAND_RESULT:'+request.nonce+':null:launch_failed\\n');process.exit(1);}});`;
		const service = store.add(new CloudCodeCommandService(runtime({
			windows: true,
			spawn: () => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] }),
		})));
		assert.strictEqual((await service.run(generateUuid(), 'echo ok', directory, 5000)).failure, 'launch_failed');
		assert.strictEqual((await service.run(generateUuid(), 'echo retry', directory, 5000)).failure, 'launch_failed');
	});

	test('disposal cancels active commands and prevents new work', async () => {
		const service = store.add(new CloudCodeCommandService());
		const running = service.run(generateUuid(), command('setInterval(()=>{},1000)'), directory, 5000);
		service.dispose();
		assert.strictEqual((await running).cancelled, true);
		await assert.rejects(service.run(generateUuid(), 'echo next', directory, 100), /invalid/);
	});
});

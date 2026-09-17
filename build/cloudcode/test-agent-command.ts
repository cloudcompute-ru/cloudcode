/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Run the real process-lifecycle tests before packaging, including the Windows Job Object helper.
// Only this suite and its dependencies are transpiled; no desktop build or Electron is needed.
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const outputRoot = join(root, '.build');
await mkdir(outputRoot, { recursive: true });
const temporary = await mkdtemp(join(outputRoot, 'cloudcode-command-tests-'));
try {
	await build({
		absWorkingDir: root,
		entryPoints: {
			commands: 'src/vs/platform/cloudCode/test/node/cloudCodeCommandService.test.ts',
			supervisor: 'src/vs/platform/cloudCode/test/node/cloudCodeWindowsCommand.test.ts',
		},
		outdir: temporary,
		outExtension: { '.js': '.test.mjs' },
		bundle: true,
		platform: 'node',
		format: 'esm',
		packages: 'external',
		sourcemap: 'inline',
		tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
	});
	const result = spawnSync(process.execPath, [join(root, 'node_modules/mocha/bin/mocha.js'), '--ui', 'tdd', '--timeout', '15000', join(temporary, 'commands.test.mjs'), join(temporary, 'supervisor.test.mjs')], { cwd: root, stdio: 'inherit' });
	if (result.error) { throw result.error; }
	process.exitCode = result.status ?? 1;
} finally {
	await rm(temporary, { recursive: true, force: true });
}

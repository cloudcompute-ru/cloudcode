/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { cloudCodeWindowsCommandArguments, CloudCodeWindowsCommandOutput } from '../../node/cloudCodeWindowsCommand.js';

suite('CloudCode Windows command supervision', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const nonce = '97d14d1e-d71b-4d42-975e-716d0fb76d11';
	const prefix = `\x1eCLOUDCODE_COMMAND_RESULT:${nonce}:`;

	test('accepts split authenticated status frames and preserves ordinary stderr', () => {
		let output = '';
		const parser = new CloudCodeWindowsCommandOutput(nonce, text => output += text);
		for (const character of `build failed\n${prefix}7:ok\r\ntrailing output`) {
			parser.append(character);
		}
		assert.deepStrictEqual({ result: parser.finish(), output }, { result: { exitCode: 7 }, output: 'build failed\ntrailing output' });
	});

	test('preserves wrong-nonce records as output without accepting them as completion', () => {
		let output = '';
		const parser = new CloudCodeWindowsCommandOutput(nonce, text => output += text);
		const unexpected = `\x1eCLOUDCODE_COMMAND_RESULT:${generateUuid()}:0:ok\n`;
		parser.append(unexpected);
		assert.deepStrictEqual({ result: parser.finish(), output }, { result: undefined, output: unexpected });
	});

	test('rejects duplicates, invalid statuses, truncated frames, and out-of-range exit codes', () => {
		const invalid = [
			`${prefix}0:ok\n${prefix}0:ok\n`, `${prefix}0:finished\n`, `${prefix}0:ok`, `${prefix}4294967296:ok\n`,
			`${prefix}-2147483649:ok\n`, `${prefix}${'1'.repeat(1000)}:ok\n`, `${prefix}0:malformed\n${prefix}0:ok\n`,
		];
		assert.deepStrictEqual(invalid.map(text => {
			const parser = new CloudCodeWindowsCommandOutput(nonce, () => { });
			parser.append(text);
			return parser.finish();
		}), invalid.map(() => undefined));
	});

	test('carries only the fixed serializable failure categories', () => {
		for (const failure of ['termination_failed', 'launch_failed', 'background_processes'] as const) {
			const parser = new CloudCodeWindowsCommandOutput(nonce, () => { });
			parser.append(`${prefix}null:${failure}\n`);
			assert.deepStrictEqual(parser.finish(), { exitCode: null, failure });
		}
	});

	test('retains bounded framing state while receiving long lines and huge command output', () => {
		let outputLength = 0;
		const parser = new CloudCodeWindowsCommandOutput(nonce, text => outputLength += text.length);
		for (let index = 0; index < 100; index++) { parser.append('x'.repeat(65536)); }
		parser.append(`${prefix}0:ok\n`);
		assert.deepStrictEqual({ result: parser.finish(), outputLength }, { result: { exitCode: 0 }, outputLength: 6553600 });
	});

	test('keeps the constant supervisor inside the Windows command-line length limit', () => {
		const args = cloudCodeWindowsCommandArguments();
		assert.ok(args.join(' ').length + 1024 < 32767);
		assert.ok(Buffer.from(args[4], 'base64').toString('utf16le').includes('[Console]::ReadLine() | ConvertFrom-Json'));
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { IProductConfiguration } from '../../../../base/common/product.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../log/common/log.js';
import { CLOUDCODE_ERROR_REPORTING_SETTING, ICloudCodeAgentDiagnostic, sanitizeCloudCodeAgentDiagnostic } from '../../common/cloudCodeDiagnostics.js';
import { CloudCodeDiagnostics, sanitizeCloudCodeSentryEvent } from '../../node/cloudCodeDiagnostics.js';

suite('CloudCode diagnostics', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const diagnostic: ICloudCodeAgentDiagnostic = { code: 'invalid_json', stage: 'parse', model: 'vendor/model', turn: 1, rootCount: 0, responseLength: 12, requestId: '12345678-1234-4234-8234-123456789abc' };

	function setup(settings = {}, dsn?: string) {
		const messages: string[] = [];
		const configuration = new TestConfigurationService(settings);
		store.add(configuration.onDidChangeConfigurationEmitter);
		const log = new class extends NullLogService {
			override error(message: string, ...args: string[]): void { messages.push([message, ...args].join(' ')); }
		};
		const product = { version: '1.0', commit: 'abc123', cloudCodeSentryDsn: dsn } as IProductConfiguration;
		return { reporter: store.add(new CloudCodeDiagnostics(configuration, product, log)), messages };
	}

	test('rebuilds IPC metadata and drops arbitrary fields and malformed values', () => {
		assert.deepStrictEqual([
			sanitizeCloudCodeAgentDiagnostic({ ...diagnostic, prompt: 'secret', error: new Error('private path') }),
			sanitizeCloudCodeAgentDiagnostic({ ...diagnostic, turn: NaN }),
			sanitizeCloudCodeAgentDiagnostic({ ...diagnostic, stage: 'command', turn: 40, command: 'private command', stdout: 'private output' }),
			sanitizeCloudCodeAgentDiagnostic({ ...diagnostic, turn: 41 }),
			sanitizeCloudCodeAgentDiagnostic({ ...diagnostic, code: 'arbitrary secret' }),
			sanitizeCloudCodeAgentDiagnostic({ ...diagnostic, model: 'user@example.com', requestId: '/private/file' })
		], [diagnostic, undefined, { ...diagnostic, stage: 'command', turn: 40 }, undefined, undefined, { ...diagnostic, model: 'unknown', requestId: undefined }]);
	});

	test('removes SDK and scope-added private data before transport', () => {
		const event = sanitizeCloudCodeSentryEvent({
			type: undefined,
			message: 'private exception', user: { email: 'private@example.com' }, server_name: 'private-host',
			request: { url: 'https://example.com/secret' }, breadcrumbs: [{ message: 'private prompt' }],
			tags: { code: diagnostic.code, stage: diagnostic.stage, model: diagnostic.model, private: 'private tag' },
			extra: { ...diagnostic, prompt: 'private prompt' }, contexts: { trace: { trace_id: 'private trace', span_id: 'private span' } }
		});
		const output = JSON.stringify(event);
		assert.ok(event && !output.includes('private') && !output.includes('secret'));
	});

	test('logs locally without a DSN and limits repeated reports', async () => {
		const test = setup();
		for (let i = 0; i < 25; i++) {
			await test.reporter.report(diagnostic);
		}
		assert.deepStrictEqual({ count: test.messages.length, payload: JSON.parse(test.messages[0].slice('[CloudCode Agent] '.length)) }, { count: 20, payload: diagnostic });
	});

	test('sends a sanitized event through the real SDK and respects reporting controls', async () => {
		const bodies: string[] = [];
		let received: () => void = () => { };
		const arrival = new Promise<void>(resolve => { received = resolve; });
		const server = createServer((request, response) => {
			let body = '';
			request.setEncoding('utf8');
			request.on('data', chunk => { body += chunk; });
			request.on('end', () => { bodies.push(body); response.end('{}'); received(); });
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const dsn = `http://public@127.0.0.1:${(server.address() as AddressInfo).port}/123`;
			for (const settings of [{ [CLOUDCODE_ERROR_REPORTING_SETTING]: false }, { 'telemetry.telemetryLevel': 'off' }, { 'telemetry.telemetryLevel': 'crash' }, { 'telemetry.enableTelemetry': false }]) {
				await setup(settings, dsn).reporter.report(diagnostic);
			}
			const test = setup({}, dsn);
			await test.reporter.report(diagnostic);
			await arrival;
			const event = JSON.parse(bodies[0].trim().split('\n')[2]);
			assert.deepStrictEqual({ count: bodies.length, message: event.message, release: event.release, extra: event.extra, user: event.user, host: event.server_name }, {
				count: 1, message: 'CloudCode Agent: invalid_json', release: 'cloudcode@1.0+abc123',
				extra: { turn: 1, rootCount: 0, responseLength: 12, requestId: diagnostic.requestId }, user: undefined, host: undefined
			});
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ErrorEvent, NodeClient } from '@sentry/node';
import { arch, platform } from 'os';
import { IProductConfiguration } from '../../../base/common/product.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { CLOUDCODE_ERROR_REPORTING_SETTING, sanitizeCloudCodeAgentDiagnostic } from '../common/cloudCodeDiagnostics.js';

/** Strip SDK-added host, user, request, breadcrumb and tracing data before transport. */
export function sanitizeCloudCodeSentryEvent(event: ErrorEvent): ErrorEvent | null {
	const diagnostic = sanitizeCloudCodeAgentDiagnostic({
		code: event.tags?.code, stage: event.tags?.stage, model: event.tags?.model,
		turn: event.extra?.turn, rootCount: event.extra?.rootCount,
		responseLength: event.extra?.responseLength, requestId: event.extra?.requestId
	});
	if (!diagnostic) {
		return null;
	}
	return {
		type: undefined,
		event_id: event.event_id, timestamp: event.timestamp, platform: 'javascript',
		level: 'error', logger: 'cloudcode.agent', release: event.release, environment: 'desktop',
		message: `CloudCode Agent: ${diagnostic.code}`,
		fingerprint: ['cloudcode.agent', diagnostic.code, diagnostic.stage],
		tags: { code: diagnostic.code, stage: diagnostic.stage, model: diagnostic.model, os: platform(), arch: arch() },
		extra: { turn: diagnostic.turn, rootCount: diagnostic.rootCount, responseLength: diagnostic.responseLength, requestId: diagnostic.requestId }
	};
}

/** Explicit handled-error reporting; does not install global hooks in Electron or other extensions. */
export class CloudCodeDiagnostics {
	private client: Promise<NodeClient> | undefined;
	private windowStart = 0;
	private reports = 0;
	private disposed = false;

	constructor(
		private readonly configuration: IConfigurationService,
		private readonly product: IProductConfiguration,
		private readonly log: ILogService,
	) { }

	private enabled(): boolean {
		return !this.disposed && this.configuration.getValue<boolean>(CLOUDCODE_ERROR_REPORTING_SETTING) !== false
			&& this.configuration.getValue<boolean>('telemetry.enableTelemetry') !== false
			&& this.configuration.getValue<boolean>('telemetry.enableCrashReporter') !== false
			&& this.configuration.getValue<string>('telemetry.telemetryLevel') !== 'off'
			&& this.configuration.getValue<string>('telemetry.telemetryLevel') !== 'crash';
	}

	async report(value: unknown): Promise<void> {
		const diagnostic = sanitizeCloudCodeAgentDiagnostic(value);
		if (!diagnostic || this.disposed) {
			return;
		}
		// Bound both local and remote volume across all windows sharing this process.
		if (Date.now() - this.windowStart >= 60000) {
			this.windowStart = Date.now();
			this.reports = 0;
		}
		if (++this.reports > 20) {
			return;
		}
		this.log.error('[CloudCode Agent]', JSON.stringify(diagnostic));
		if (!this.enabled() || !this.product.cloudCodeSentryDsn) {
			return;
		}
		try {
			this.client ??= import('@sentry/node').then(sentry => {
				const client = new sentry.NodeClient({
					dsn: this.product.cloudCodeSentryDsn,
					release: `cloudcode@${this.product.version}+${this.product.commit || 'development'}`,
					transport: sentry.makeNodeTransport,
					stackParser: sentry.defaultStackParser,
					integrations: [], sendDefaultPii: false,
					beforeSend: event => this.enabled() ? sanitizeCloudCodeSentryEvent(event) : null
				});
				client.init();
				return client;
			});
			const client = await this.client;
			if (!this.enabled()) {
				return;
			}
			client.captureEvent({
				message: `CloudCode Agent: ${diagnostic.code}`,
				fingerprint: ['cloudcode.agent', diagnostic.code, diagnostic.stage],
				tags: { code: diagnostic.code, stage: diagnostic.stage, model: diagnostic.model, os: platform(), arch: arch() },
				extra: { turn: diagnostic.turn, rootCount: diagnostic.rootCount, responseLength: diagnostic.responseLength, requestId: diagnostic.requestId }
			});
		} catch {
			// Diagnostics must never replace the original error or block the Agent.
			this.client = undefined;
			this.log.warn('[CloudCode Agent] Remote diagnostics unavailable; structured error retained in the local log.');
		}
	}

	dispose(): void {
		this.disposed = true;
		void this.client?.then(client => client.close(1000)).catch(() => { });
	}
}

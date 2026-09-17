# CloudCode Agent error reporting

Agent failures can happen after a successful HTTP response. For example, the model can return JSON that the desktop Agent rejects. The server need not produce a 500 or an exception in that case.

CloudCode explicitly reports failed Agent runs through the shared desktop process. Each accepted report is written to the local shared-process log, even when Sentry is not configured. Search for `[CloudCode Agent]` using **Developer: Open Logs Folder**. The message shown in chat remains unchanged.

## Sentry configuration

The separate Sentry project named `cloudcode` is configured through its **public DSN** in the repository's `product.json` field `cloudCodeSentryDsn`. Rebuild the installer with `scripts\build-cloudcode-win32.bat` to include this configuration. A public DSN is distributed with the application; do not put a Sentry auth token in this field.

The checked-in DSN enables remote reporting in rebuilt applications, subject to the reporting and telemetry settings below. Users do not need environment variables. Subsequent diagnostic events appear as `CloudCode Agent: <code>` and include a release such as `cloudcode@<version>+<commit>`.

Reports contain only:

- A fixed failure code and stage, such as `invalid_json` / `parse`, `invalid_root`, `invalid_tool`, `invalid_range`, `timeout` or `call_limit`.
- Model ID, build version/commit, OS and architecture.
- Model-call number, workspace root count, response character count and the desktop request UUID.

The UUID identifies the local inference request; it is not currently a server trace ID. No prompts, source files, filenames, workspace paths, responses, raw exception messages/stacks, account details, credentials, screenshots or session replays are sent. SDK-added request, hostname, user, breadcrumb and tracing data are removed before transmission. Reports are capped at 20 per minute per shared process, including local diagnostic entries.

Users can disable remote reporting with `cloudcode.errorReporting.enabled: false`. The existing telemetry levels `off` and `crash`, and legacy disabled telemetry settings, also disable this error reporting. Local structured logging remains available. Reporting is best-effort: it never delays completion of an Agent task or replaces its original error. Pressing Stop is not reported as a failure.

## Scope and verification

This integration captures handled failures from Agent tasks, including inference failures encountered during those tasks. It does not yet provide general Electron crash reporting, global renderer exception capture, or reporting for ordinary Ask, sign-in and extension errors. Installing global crash handlers alone would not capture the handled Agent failure that prompted this change.

The diagnostics tests exercise the real Sentry SDK against a loopback endpoint and verify the outgoing event. After rebuilding with the configured DSN, reproduce an Agent failure and confirm the event's model, code, stage and release in Sentry. Successful answers and user cancellations should not generate events. A live Sentry project and a Windows installer run must be checked separately.

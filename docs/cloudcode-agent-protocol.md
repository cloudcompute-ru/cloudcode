# CloudCode Agent protocol

Agent mode uses native function calls through the CloudCode inference endpoint. Ask and Edit mode retain their existing text transport. Models used in Agent mode must support OpenAI-compatible function tools; the desktop does not silently fall back to interpreting arbitrary answer text as executable JSON.

## Request and response

The desktop sends `tools`, `tool_choice: auto`, `parallel_tool_calls: false` and typed `system`, `user`, `assistant` and `tool` messages. Agent mode exposes `list`, `findFiles`, `search`, `read`, `apply_patch`, `create_file`, `rename_file` and `delete_file`. Writes remain staged until the user reviews and accepts a [multi-file editing session](cloudcode-editing-sessions.md). Execution-enabled tasks also expose `run_command`, which applies and saves approved checkpoints before [running checks and fixing failures](cloudcode-agent-execution.md). The legacy runner without an editing-session factory retains `propose`. Each tool result is paired with its assistant call ID. Provider reasoning content and ordered reasoning detail blocks are preserved unchanged within active tool turns, including through buffered responses; they are not displayed, logged to Sentry, or saved in the chat archive. The shared process validates the request before sending it through the existing authenticated, billed endpoint.

The Agent stream collector reconstructs fragmented function names, IDs and arguments. It requires the stream terminator and a completion reason before returning a response. Incomplete transport responses never authorize a local tool. `finish_reason: length` discards partial calls; a bounded retry can request more output. Explicit model filtering, transport failures and user cancellations do not trigger automatic retries.

Invalid arguments and rejected staged operations receive fixed error codes and corrective feedback. At most two correction attempts are permitted across a task. Execution-enabled tasks allow 40 model calls, fifteen minutes and four command attempts. Editing-only sessions allow 24 model calls and five minutes; the legacy runner retains twelve calls and three minutes. No invalid call executes and no invalid proposal acquires an editable target. Terminal failures still use the sanitized Sentry/local diagnostics path. A recovered mistake does not create a terminal failure report.

Agent output starts at 4096 tokens; after truncation it may increase to 8192. Each retry is an ordinary billed inference request. There is no hidden provider retry of interrupted streams.

## Conversation continuity

Follow-up Agent tasks receive completed discussion and previously referenced filenames. Stopped/failed turns, raw attachment snapshots and old tool permissions are excluded. The model is instructed to read current files again. Only the current task's validated snapshots can become edit targets.

Completed discussion is supplied as task-context data, avoiding synthetic assistant wire turns without the original provider reasoning/signatures. Recent history is bounded to four complete user/assistant pairs and 16 KiB, with further pruning if necessary to fit the request. Tool history is pruned in complete call/result groups. Chat archives retain whether a response only proposed changes, plus later per-file acceptance/rejection outcomes; proposals are never presented as already applied. New chats, accounts and teams remain isolated.

## Deployment and verification

1. Deploy the companion `nomadicsoft/app-cloudcompute-ru` gateway PR first. The old endpoint drops tool definitions and rejects tool/system messages. The gateway must also preserve calls in its buffered streaming path.
2. Merge this desktop PR, pull and rebuild using `scripts\build-cloudcode-win32.bat`.
3. With a tool-capable model, ask the Agent to find a function in a small repository. Confirm it searches/reads and answers, then ask a follow-up referring to that answer.
4. Ask for a bounded edit. Review and accept/reject it, then ask a follow-up. The Agent must reread current source and distinguish the recorded review outcome.
5. Stop an active request. No late tool call or edit proposal should execute. Check inference usage in the backend; tool-only responses and correction attempts still incur their actual usage.

Automated checks cover malformed calls, truncation, bounded correction, fragmented SSE, request validation, source/trust boundaries, cancellation, conversation persistence and sanitized diagnostics. A live provider and Windows installer still require a deployment smoke test.

## Remaining milestones

PR2 adds staged multi-file editing sessions, combined review and task undo. PR3 adds approved commands, saved checkpoints and the execution/test/fix loop. Model-sized context and resumable execution require subsequent work; Plan mode is separate.

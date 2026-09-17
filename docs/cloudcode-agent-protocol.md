# CloudCode Agent protocol (PR1)

Agent mode uses native function calls through the CloudCode inference endpoint. Ask and Edit mode retain their existing text transport. Models used in Agent mode must support OpenAI-compatible function tools; the desktop does not silently fall back to interpreting arbitrary answer text as executable JSON.

## Request and response

The desktop sends `tools`, `tool_choice: auto`, `parallel_tool_calls: false` and typed `system`, `user`, `assistant` and `tool` messages. Supported functions remain read-only `list`, `findFiles`, `search`, `read`, plus `propose` for user-reviewed edits. Each tool result is paired with its assistant call ID. Provider reasoning content and ordered reasoning detail blocks are preserved unchanged within active tool turns, including through buffered responses; they are not displayed, logged to Sentry, or saved in the chat archive. The shared process validates the request before sending it through the existing authenticated, billed endpoint.

The Agent stream collector reconstructs fragmented function names, IDs and arguments. It requires the stream terminator and a completion reason before returning a response. Incomplete transport responses never authorize a local tool. `finish_reason: length` discards partial calls; a bounded retry can request more output. Explicit model filtering, transport failures and user cancellations do not trigger automatic retries.

Invalid arguments and invalid proposals receive fixed error codes and corrective feedback. At most two correction attempts are permitted across a task, within the existing twelve-call and three-minute limits. No invalid call executes and no invalid proposal acquires an editable target. Terminal failures still use the sanitized Sentry/local diagnostics path. A recovered mistake does not create a terminal failure report.

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

PR1 does not add automatic editing, new-file creation, terminal commands or test execution. Existing snapshot limits (five attachments / 24 KiB combined) and task limits remain. Editing sessions/checkpoints and the execution/test/fix loop are the next milestones; model-sized context, longer-task budgets and resumable execution require subsequent work.

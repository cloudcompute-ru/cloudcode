# CloudCode command, test and fix loop (PR3)

Agent mode can run a foreground check, inspect its output, edit the project and run another check in the same task. The new `run_command` native tool uses the existing PR1 gateway; no companion app change or new backend configuration is required.

## Approval and checkpoints

The first command shows its exact shell command, working directory, purpose and staged file list. When there are staged edits, CloudCode opens the combined diff before asking to **Apply Changes and Run**. Approval applies and saves that checkpoint, then runs the command against the real project, using its installed dependencies and configuration.

The optional **Allow Further Edits and Commands for This Task** checkbox allows the Agent to continue the test/fix cycle without another approval for each command. It is off by default. Consent is limited to the active task and is revoked on Stop, workspace/trust changes or disposal. A later chat message needs fresh consent. Declining leaves pending edits available for final review.

Commands run with the user's normal operating-system permissions. The directory must be inside an open trusted local workspace, but this is not a filesystem or network sandbox: approved commands can have effects elsewhere. The model is instructed to use foreground checks, tests and builds, and to stage edits through the file tools. Background services, watchers, dependency installation and deployment are outside this milestone.

Unsaved project files outside the checkpoint must be saved or reverted first. Approval explicitly includes existing unsaved edits in files covered by the checkpoint. CloudCode verifies reviewed content, saves without extension save participants, and checks again before launch. Remote, virtual and network-share workspaces are not supported.

## Results and recovery

- A nonzero exit is returned to the model as feedback. It can reread current files, stage a fix and request another command.
- After a command, clean open files refresh from disk and a fresh editing session replaces the previous overlay. Dirty user buffers are preserved. Prior source observations cannot authorize a later edit.
- Applied checkpoints stay in the project after Stop, timeout or a later task failure. Each retained checkpoint offers **Undo Checkpoint**, subject to the normal file-content and native undo-stack checks. Undo only reverses that checkpoint's CloudCode edits; it does not reverse arbitrary command side effects. Later changes can prevent an older checkpoint from being undone.
- Changes staged after the last command remain pending and use the existing final **Preview Changes / Accept All / Reject All** flow. Rejecting them does not undo earlier checkpoints. The model is instructed to distinguish checked revisions from later unverified edits.
- Setup failures have actionable explanations. If process termination cannot be confirmed, the task stops with an explicit error and the command service blocks further execution until restart. Inspect running processes before retrying; a failed termination must not be presented as a successful Stop.

The activity panel shows command progress and exit status. **View → Output → CloudCode Agent Commands** contains each command, directory and bounded output for local troubleshooting. Output is also sent to the selected model as tool feedback. Raw command output is not written to chat archives or Sentry; diagnostics only report the sanitized command stage and error code. Up to five recent editing sessions/checkpoints remain live in the current chat. Undo handles and command consent are not restored from history.

## Limits

| Limit | Value |
| --- | --- |
| Model calls per execution-enabled task | 40 |
| Task duration | 15 minutes |
| Command attempts per task, including denials/setup failures | 4 |
| Timeout per command | 120 seconds |
| Command text | 8,192 characters |
| Captured stdout and stderr together | 16 KiB, keeping beginning and end |
| Tool feedback per output stream | 8 KiB |

Existing editing limits apply to each staged checkpoint. Commands have no interactive input. POSIX commands use `sh`; Windows commands use `cmd.exe`. Process cleanup is awaited before continuing the loop. A timeout or cancelled command is never reported as passing.

On Windows, the built-in Windows PowerShell hosts a small Job Object supervisor. The command joins its job at process creation, and child processes cannot inherit the supervisor's control input or job handle. Cancellation terminates the job and checks that it is empty. Hosts that block PowerShell or runtime helper compilation cannot run Agent commands; there is no unsupervised fallback.

## Deployment and smoke test

Merge the desktop change and rebuild with `scripts\build-cloudcode-win32.bat`. The deployed PR1 gateway is sufficient. Use a disposable local repository and a tool-capable model:

1. Ask the Agent to fix a failing test. Check the command, directory and combined diff in the first approval, then allow the task to continue. Confirm a failed check leads to a reread, fix and another check.
2. Decline a command. Confirm nothing launches and pending changes remain reviewable. Start a new task and confirm it requests fresh approval.
3. Keep an unrelated project file unsaved. Confirm the command explains the blockage and preserves that buffer. Save it and retry in a new task.
4. Run a command that changes an open file. Confirm the editor and the Agent's next read see its new contents. Repeat with Stop and verify already-written changes remain visible.
5. Stop a slow command with child processes. Check that the process tree exits and applied checkpoints remain available. Also exercise a command whose main process exits while a redirected child is still alive; no child should survive command cleanup.
6. Use Undo Checkpoint, then repeat after making a manual edit to an affected file. The latter must refuse conflicting undo. Confirm command-created files outside the checkpoint are not advertised as reversible.
7. Check the Output channel, timeout behavior and final summary. Any changes staged after the final successful check must be described as unverified.

Focused automated tests cover the Agent loop, checkpoint ownership, command approval, save/refresh/cancellation boundaries, output bounds and process lifecycle. The Windows packaging workflow runs the real command lifecycle suite before building the application; it can also be run with `node build/cloudcode/test-agent-command.ts`. A successful Windows CI run and live-provider desktop smoke test remain release gates.

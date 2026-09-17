# CloudCode multi-file editing sessions (PR2)

Agent mode can patch, create, rename and delete text files across one task. Changes stay in a local overlay while the Agent works. Later reads see staged contents, so the Agent can revise its own edits without changing the user's files. Repeated changes collapse into one original-to-final diff per file.

## Review and recovery

The finished task shows a file list with **Preview Changes**, **Accept All** and **Reject All**. Preview opens the native multi-file diff. Accept is enabled after the preview opens successfully. Reject discards the overlay. Cancellation or a failed Agent run also discards staged changes.

Accept rechecks workspace trust, file contents, dirty buffers, paths, permissions and destination conflicts, then uses native workspace edits. Edits to existing files follow the editor's normal save/autosave behavior; file creation, rename and deletion are filesystem operations. Deleting an existing file with unsaved edits is blocked until it is saved or reverted. A native late guard also preserves buffers that become dirty while deletion is pending, including undo of newly created files.

Task file operations skip extension file-operation participants so the accepted diff and undo group contain only reviewed changes. The Agent must include related import updates in its staged changes. Other editor operations retain their normal participant behavior.

**Undo Task** uses the task's native undo source. It checks every affected file and undo stack first, refusing to overwrite later user edits. Saving or autosaving exactly the accepted text does not itself prevent undo. Native filesystem operations are not atomic: a partial apply remains visible as partial and retains undo when the captured state allows safe recovery. A failed or incomplete undo is reported, never presented as a completed rollback.

Up to five recent task sessions remain available within the current chat. Pending review must be resolved before another message; applied or partial sessions allow follow-up work. Starting a new chat, switching account/team, reopening an archive or disposing the view releases live session capabilities. History keeps review outcomes, not executable file permissions or undo handles. Undo availability is therefore not persistent across restarts.

## Agent tools and limits

| Tool | Behavior |
| --- | --- |
| `list`, `findFiles`, `search` | Discover current filesystem content; the request separately lists staged changes. |
| `read` | Read the current overlay for editable files. Larger files support bounded read-only exploration. |
| `apply_patch` | Replace one unique, exact, previously read text match, preserving the file's line endings. |
| `create_file` | Stage a new text file at an unused path under an existing directory. |
| `rename_file` | Move a previously read file to an unused path in the same workspace root. |
| `delete_file` | Stage deletion after the complete file has been read. |

- 24 model calls and five minutes per editing task, with at most two correction attempts.
- 20 changed files, 1 MiB per editable text file, and 4 MiB each for captured baseline text and total staged final text.
- At most 200 lines and 16 KiB per read. The model's rolling source cache keeps the five newest snapshots, at most 24 KiB together. Eviction does not erase staged changes or read observations.
- Each patch text or new-file content is limited to 32 KiB. Larger changes require several small operations.
- Paths stay within trusted workspace roots. Secret paths, symlinks, binary files and existing files excluded from Agent discovery are rejected. Rename cannot overwrite an existing file; task paths cannot be recycled for a different file identity.
- No directory creation, cross-root moves, case-only renames, terminal execution, test runner or persistent task resume in this change. Attachment-based Edit mode keeps its existing review flow.

## Deployment and smoke test

The deployed PR1 Agent gateway is sufficient; no additional backend change or configuration is required. Merge the desktop change and rebuild with `scripts\build-cloudcode-win32.bat`.

Use a disposable repository and a tool-capable model:

1. Ask the Agent to extract a helper into a new file, update its imports in two existing files, rename another file and remove an obsolete fixture. Have it revise the helper before finishing.
2. Confirm that working files remain unchanged while the Agent works. Open Preview Changes and check all additions, modifications, renames and deletions in one original-to-final diff.
3. Reject the task and confirm nothing changed. Repeat, preview and accept; inspect the resulting working files.
4. Save the files and use Undo Task. Confirm the complete task is reversed. Repeat with an extra manual edit after acceptance; Undo Task must refuse and preserve it.
5. Change an affected file or occupy a destination while the task awaits review. Acceptance must report the conflict. Verify dirty-file deletion is also blocked.
6. Stop an active task and start a new chat. No staged changes should reach the filesystem or survive as active controls in restored history.

Automated tests exercise the overlay, tool loop, native-service adapter, review controller, UI controls and diagnostics bounds. A full Windows build and live-provider desktop smoke test are still required before release.

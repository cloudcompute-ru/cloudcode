# CloudCode development and sign-in

CloudCode opens CloudCompute's existing browser login, requests consent for the selected team, and streams chat responses in **View → CloudCode Chat**. Users do not copy API keys or client secrets into the editor. Chat supports explicitly attached text files and selections, plus proposed edits with native diff review and Accept/Reject controls. It does not explore the project automatically or run agent tools.

## Backend setup

Deploy the matching change in `nomadicsoft/app-cloudcompute-ru` first. Follow that repository's normal deployment and migrations; Passport tables and signing keys must already exist. Then run once per deployment:

```sh
php artisan cloudcode:oauth-client
```

Copy the printed `CLOUDCODE_OAUTH_CLIENT_ID=...` into that backend deployment's environment, run `php artisan config:cache`, and restart its Octane workers through the normal deployment process. `GET /cloudcode/auth/config` returns 200 when configured, or 503 until setup is complete. The client ID is public and discovered by the desktop; it is not embedded in builds.

CloudCompute and AtmosCompute deployments need their own client IDs. The backend repository's [desktop authentication guide](https://github.com/nomadicsoft/app-cloudcompute-ru/blob/master/docs/CLOUDCODE_DESKTOP_AUTH.md) describes the HTTP contract and deployment details.

## Build and launch locally

Use the Node.js version in [.nvmrc](.nvmrc), currently 24.18.0, and npm below version 13. Windows builds also require Python 3 and Visual Studio **2022** Build Tools with **Desktop development with C++**, a Windows SDK, and the matching x64/x86 MSVC, ATL, and MFC Spectre-mitigated libraries. The repository's installation check detects Visual Studio 2022 and 2019; installing only Visual Studio 2026 does not satisfy that check.

From the checked-out CloudCode repository, in PowerShell:

```powershell
npm install
npm run compile
.\scripts\code.bat
```

On macOS or Linux, use `./scripts/code.sh` to launch after installing the platform's [Code OSS build prerequisites](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites). For continued editing, leave `npm run watch` running in one terminal, launch from another, and use **Developer: Reload Window** after compilation completes.

The application setting `cloudcode.serverUrl` defaults to `https://app.cloudcompute.ru`. To use a development backend, change it in user settings, for example:

```json
{
  "cloudcode.serverUrl": "http://127.0.0.1:8000"
}
```

Use a server origin without a path, query, or credentials. HTTPS is required except for HTTP loopback origins (`127.0.0.1`, `localhost`, or `[::1]`). Configure the backend's `APP_URL` to the same origin. This is an application setting; a project's workspace settings cannot redirect sign-in or inference. Changing the server signs you out.

## Try a conversation

1. Open **View → CloudCode Chat** and choose **Sign in to CloudCompute**.
2. Sign in in the browser, select the intended team, and approve its CloudCode consent. The account must have that team's `inference.use` permission. The approved team remains attached to the desktop session even if the browser's active team changes later.
3. Return to CloudCode, choose a model, and send a coding question. The Account menu shows the signed-in account and team. A funded balance is needed for inference; an empty balance still allows sign-in and model selection.

Authentication uses S256 PKCE and the fixed callback `http://127.0.0.1:43827/cloudcode/callback`. CloudCode listens on that loopback port only during sign-in, so development builds work without custom-protocol registration. The browser must be on the same machine as the desktop app. If the port is occupied, close the other sign-in attempt and retry.

Credentials remain in the native shared process and use protected secret storage. If secure persistence is unavailable, the panel explains that sign-in will be needed after restarting. **Account → Sign Out** removes the local session and attempts server revocation; if offline, CloudCode explains that server revocation was not confirmed.

**Stop** immediately stops displaying the response and aborts the desktop's HTTP stream. The existing inference gateway may continue collecting the provider's final output and usage for billing; Stop does not guarantee cancellation of generation or its remaining charges. Partial responses stay visible, with an explicit note that the incomplete question/response pair is excluded from subsequent context.

**New Chat** in the chat title bar clears the in-memory conversation and pending attachments. Conversations are also cleared on account/team changes and sign-out. Context is bounded to 32 messages, 32,768 characters per message, and 65,536 UTF-8 content bytes; oversized input is retained as a draft with guidance to shorten it or start a new chat.

## Attach project context

Use **Attach…** above the prompt and choose **Current File**, **Selected Code**, or **Choose Files…**. Active files, selections and already-open chosen files include unsaved editor changes. Files are read only when you explicitly attach them; file contents reach inference only when you send a message.

Each attachment is a snapshot taken when attached. Expand its name to inspect the exact text, or choose **Remove** to exclude it. Reattach the same file or range to refresh a snapshot after editing. Sent messages retain expandable copies of their attachments. Successful turns carry those snapshots into subsequent conversation context; stopped or failed turns are excluded, including their attachments.

Limits are five files/selections per message, 16 KiB per attachment and 24 KiB total, measured as UTF-8. The existing per-message and conversation limits also apply to the serialized text. An oversized request preserves your draft and pending attachments; choose a smaller selection or remove an attachment. Binary files and unsupported resource types are rejected. Attaching and resending source context requires a trusted workspace. For current-file/selection attachments, open the file in a regular text editor rather than a diff view.

Local and remote text files are supported. Active untitled text buffers can also be attached. Labels use workspace-relative paths (with the folder name in multi-root workspaces); explicitly chosen files outside the workspace use their basename. Machine-specific URI identifiers are never included in inference content.

## Propose and review code changes

1. Attach the file or selected code you want to change. Use one attachment per file for an edit request.
2. Switch **Ask** to **Propose Edits** beside the model selector, describe the change and send.
3. Choose **Preview Diff** for a proposed change. The native diff shows the captured file and the proposed result, including surrounding code for a selection.
4. Choose **Accept** or **Reject** for each file. Accept becomes available after its diff opens successfully. Resolve the proposed changes before sending another request.

The model can replace only the attached files or selections. It cannot choose an arbitrary path, create/delete files, run commands or apply changes automatically. Invalid, oversized, stopped or failed responses never produce actionable edits.

Accept applies an ordinary undoable editor change. It does not call Save; normal editor autosave settings still apply. CloudCode checks the full captured file before accepting, including unsaved changes. If that file has changed, trust was revoked, or the file is read-only, the change is refused. Reject it and attach fresh code to request another proposal. New Chat and account changes invalidate pending proposals and any in-flight review.

Edit requests use the current instruction and newly attached snapshots, independently of earlier chat. After accepting edits, subsequent requests start with fresh model context so old source snapshots are not reused. The transcript remains visible; attach updated code for follow-up edits. Proposals and their previews are kept in memory for the current session.

Replacements are limited to 32 KiB each and 48 KiB combined; the full structured response is limited to 64 KiB. Existing input/context limits still apply. Selection edits also require the complete source file to fit within a 1 MiB local snapshot; only the selected text is sent to inference.

## Focused checks

After compiling, run the relevant unit suites without calling a live account or inference provider:

```sh
npm run test-node -- --run src/vs/platform/cloudCode/test/node/cloudCodeProtocol.test.ts
npm run test-node -- --run src/vs/platform/cloudCode/test/node/cloudCodeService.test.ts
npm run test-node -- --run src/vs/workbench/contrib/cloudCode/test/common/cloudCodeChatController.test.ts
npm run test-node -- --run src/vs/workbench/contrib/cloudCode/test/common/cloudCodeChatContext.test.ts
npm run test-node -- --run src/vs/workbench/contrib/cloudCode/test/common/cloudCodeEdits.test.ts
```

The existing component explorer exposes the `cloudCode/` fixtures for signed-out, browser sign-in, model loading, conversation, streaming, error, and stopped states in light and dark themes. Full sign-in verification requires the deployed backend client configured above.

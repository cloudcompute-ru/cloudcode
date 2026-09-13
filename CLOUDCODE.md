# CloudCode development and sign-in

CloudCode opens CloudCompute's existing browser login, requests consent for the selected team, and streams chat responses in **View → CloudCode Chat**. Users do not copy API keys or client secrets into the editor. This iteration supports text conversations; it does not read project files or run agent tools.

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
3. Return to CloudCode, choose a model, and send a coding question. The panel shows the signed-in account and team. A funded balance is needed for inference; an empty balance still allows sign-in and model selection.

Authentication uses S256 PKCE and the fixed callback `http://127.0.0.1:43827/cloudcode/callback`. CloudCode listens on that loopback port only during sign-in, so development builds work without custom-protocol registration. The browser must be on the same machine as the desktop app. If the port is occupied, close the other sign-in attempt and retry.

Credentials remain in the native shared process and use protected secret storage. If secure persistence is unavailable, the panel explains that sign-in will be needed after restarting. **Sign Out** removes the local session and attempts server revocation; if offline, CloudCode explains that server revocation was not confirmed.

**Stop** immediately stops displaying the response and aborts the desktop's HTTP stream. The existing inference gateway may continue collecting the provider's final output and usage for billing; Stop does not guarantee cancellation of generation or its remaining charges. Partial responses stay visible, with an explicit note that the incomplete question/response pair is excluded from subsequent context.

**New Chat** clears the in-memory conversation. Conversations are also cleared on account/team changes and sign-out. Context is bounded to 32 messages, 32,768 characters per message, and 65,536 UTF-8 content bytes; oversized input is retained as a draft with guidance to shorten it or start a new chat.

## Focused checks

After compiling, run the relevant unit suites without calling a live account or inference provider:

```sh
npm run test-node -- --run src/vs/platform/cloudCode/test/node/cloudCodeProtocol.test.ts
npm run test-node -- --run src/vs/platform/cloudCode/test/node/cloudCodeService.test.ts
npm run test-node -- --run src/vs/workbench/contrib/cloudCode/test/common/cloudCodeChatController.test.ts
```

The existing component explorer exposes the `cloudCode/` fixtures for signed-out, browser sign-in, model loading, conversation, streaming, error, and stopped states in light and dark themes. Full sign-in verification requires the deployed backend client configured above.

# CloudCode desktop builds

The **CloudCode Windows** GitHub Actions workflow builds a Windows x64 application ZIP and per-user installer. It runs on relevant pull requests and changes to `main`, and can also be started manually with **Actions → CloudCode Windows → Run workflow** after the workflow is merged into `main`. Select the branch to build when starting it manually.

Open a successful run and use its download link or **Artifacts** section. The artifact contains:

- `CloudCode-<version>-<commit>-win32-x64.zip`: extract the entire archive and run `CloudCode.exe`.
- `CloudCode-<version>-<commit>-win32-x64-user-setup.exe`: install for the current Windows user without administrator access.
- `SHA256SUMS.txt`: checksums for the ZIP and installer.
- `BUILD.txt`: the exact source commit and version.

GitHub requires repository access to download artifacts from this private repository. Artifacts expire after 14 days; these links are for development testing, not the public download page. Pull request runs build GitHub's temporary merge commit; the source commit in `BUILD.txt` identifies the actual code that was packaged.

These builds are unsigned, so Windows may report an unknown publisher. They do not publish a GitHub Release, upload to the marketing site or configure automatic updates. Packaging does not change CloudCode's browser sign-in or inference endpoints.

## Build prerequisites and commands

The workflow uses GitHub's `windows-2022` runner and verifies Visual Studio 2022 C++ tools, the x64/x86 Spectre runtime, ATL and MFC libraries, and Windows SDK 26100. Node comes from `.nvmrc` (currently 24.18.0), and Python 3.12 is installed for node-gyp. The pinned npm dependencies supply the Inno Setup compiler. See the [runner software list](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md) and [Microsoft component IDs](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-build-tools?view=vs-2022).

The workflow uses the existing OSS CI helper to skip installation of the optional Foundry Local dictation native payload, which otherwise needs Microsoft's private NuGet credentials. Other native install scripts run normally. The source package is modified only within the runner checkout; no credentials need to be configured. GitHub's built-in read-only token is used for dependency and built-in extension downloads.

After installing the prerequisites, the same application and installer can be built from PowerShell in the repository:

```powershell
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
$env:NODE_OPTIONS = '--max-old-space-size=4096'
$env:PATH = "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.26100.0\x64;$env:PATH"

node build/azure-pipelines/common/disableFoundryLocalInstall.ts
npm ci
node build/lib/builtInExtensions.ts
npm run typecheck-client
npm run gulp vscode-win32-x64-min
npm run gulp vscode-win32-x64-inno-updater
npm run gulp vscode-win32-x64-user-setup
```

Stop if any command fails. The OSS helper changes the local `package.json` install policy for optional dictation; review that local change before committing unrelated work.

The application is produced in `../VSCode-win32-x64`, and the installer in `.build/win32-x64/user-setup/VSCodeSetup.exe`. The internal upstream output names are retained; the workflow gives the downloads CloudCode filenames. It checks packaged branding, the source commit, Copilot exclusion and CLI startup before uploading the artifacts. A successful packaging run still needs a Windows check of launching the editor, signing in, chatting and accepting an edit before a public release.

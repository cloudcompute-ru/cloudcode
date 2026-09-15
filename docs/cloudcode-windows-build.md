# Build CloudCode for Windows

Run these commands on Windows x64 from the repository root, for example `C:\code\cloudcode`. Use a short path without spaces. Close running CloudCode development windows and stop `npm run watch` before packaging.

## Prerequisites

- The Node 24 version in `.nvmrc` (currently 24.18.0), or a newer Node 24 release.
- Git, Python 3 on PATH, and Visual Studio **2022** Build Tools with Desktop development with C++, a Windows SDK, and x64/x86 MSVC, ATL and MFC Spectre-mitigated libraries. These are the same prerequisites as the development build.
- Internet access for npm, Electron and the built-in debugger extensions.

Use Developer PowerShell for VS 2022. Inno Setup is already included as an npm dependency; a separate installation is unnecessary.

## Prepare the source

After merging the desired PR:

```powershell
cd C:\code\cloudcode
git switch main
git pull --ff-only
npm ci
```

Do not use `--ignore-scripts` for a distributable: the install scripts prepare native dependencies and the extension build directories.

Ensure the Windows SDK signing utility is on PATH. Packaging uses it to inspect and remove existing dependency signatures even for an unsigned build:

```powershell
$cloudCodeSignTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
    Sort-Object FullName -Descending | Select-Object -First 1
if (!$cloudCodeSignTool) { throw 'Install the Windows SDK component in Visual Studio Build Tools.' }
$env:Path = "$($cloudCodeSignTool.DirectoryName);$env:Path"
```

## Compile and package the application

```powershell
npm run copy-policy-dto --prefix build
node build/lib/policies/policyGenerator.ts build/lib/policies/policyData.jsonc win32
npm run gulp -- vscode-win32-x64-min
npm run gulp -- vscode-win32-x64-inno-updater
```

Run each command only after the previous one succeeds. The packaging task compiles the application and bundled extensions; a separate `npm run compile` is not required here. The policy generator may report that policy localization is skipped because no extension gallery is configured; it still generates the English policy files.

The complete application is written to the **sibling directory** `C:\code\VSCode-win32-x64`. The folder name comes from the upstream build tasks; the executable inside is `CloudCode.exe`.

Launch the packaged application before making an installer:

```powershell
& ..\VSCode-win32-x64\CloudCode.exe
```

Check sign-in, opening a project, sending a chat with an inline file attachment, and reopening it after restarting. The packaged application uses its own normal profile, so a development-build login may not carry over. Close it before continuing.

## Create the user installer

```powershell
npm run gulp -- vscode-win32-x64-user-setup
Copy-Item .build\win32-x64\user-setup\VSCodeSetup.exe .build\CloudCodeSetup-x64.exe
Get-FileHash .build\CloudCodeSetup-x64.exe -Algorithm SHA256
```

Upload **`.build\CloudCodeSetup-x64.exe`** to the website. It installs CloudCode for the current Windows user without requiring administrator rights. Keep the SHA-256 hash with the release.

These commands produce an unsigned installer. Windows may show an unknown-publisher or SmartScreen warning. The upstream `--sign` flag uses Microsoft's ESRP signing infrastructure; it is not a general switch for a CloudCompute certificate. Public release signing needs a separate certificate/signing-service setup.

## ZIP alternative

You can distribute the entire packaged application without an installer:

```powershell
Compress-Archive -Path ..\VSCode-win32-x64\* -DestinationPath .build\CloudCode-win-x64.zip -Force
```

Users extract the ZIP and run `CloudCode.exe`. Include the entire folder, including its resources, runtime, extensions and license notices. Do not upload only the executable or the development `out` folder. A ZIP by itself does not enable portable profile storage; the app uses its normal user profile unless a portable `data` directory is explicitly created.

Automatic update delivery is not configured by these build commands. For the initial downloadable release, users can install a newer installer manually.

The commands are based on this fork's checked-in build tasks. The full Windows packaging and installer run must be performed on Windows; browser and TypeScript validation alone do not validate an installer.

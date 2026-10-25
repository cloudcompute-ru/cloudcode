@echo off
setlocal EnableExtensions DisableDelayedExpansion
:: Copyright (c) Microsoft Corporation. All rights reserved.
:: Licensed under the MIT License. See License.txt in the project root for license information.

set "CLOUDCODE_BUILD_ZIP="
set "CLOUDCODE_BUILD_BRAND=cloudcompute"
:parse_arguments
if "%~1"=="" goto arguments_ready
if /i "%~1"=="--help" goto help
if /i "%~1"=="/?" goto help
if /i "%~1"=="--zip" (
    set "CLOUDCODE_BUILD_ZIP=1"
    shift
    goto parse_arguments
)
if /i "%~1"=="--brand" (
    if "%~2"=="" goto invalid_arguments
    set "CLOUDCODE_BUILD_BRAND=%~2"
    shift
    shift
    goto parse_arguments
)
goto invalid_arguments

:arguments_ready
set "CLOUDCODE_BUILD_NAME=CloudCode"
if "%CLOUDCODE_BUILD_BRAND%"=="atmoscode" set "CLOUDCODE_BUILD_NAME=AtmosCode"

pushd "%~dp0.."
if errorlevel 1 exit /b 1

echo Building %CLOUDCODE_BUILD_NAME% for Windows x64 from the current checkout.
echo Close CloudCode windows and stop npm run watch before building.
echo.

set "CLOUDCODE_BUILD_STEP=Checking build tools"
for %%T in (node.exe npm.cmd git.exe powershell.exe) do (
	where %%T >nul 2>nul
	if errorlevel 1 (
		echo Missing %%T on PATH. See docs\cloudcode-windows-build.md. 1>&2
		goto failed
	)
)
node -e "if (process.arch !== 'x64') { console.error('This script requires Windows x64 with x64 Node.js.'); process.exit(1); }"
if errorlevel 1 goto failed

set "CLOUDCODE_BUILD_STEP=Selecting product branding"
node build/cloudcode/brand.mjs --brand "%CLOUDCODE_BUILD_BRAND%"
if errorlevel 1 goto failed

:: Use an existing SDK tool on PATH, or find an installed x64 SDK tool.
where signtool.exe >nul 2>nul
if not errorlevel 1 goto sdk_ready
set "CLOUDCODE_BUILD_SDK="
for /d %%S in ("%ProgramFiles(x86)%\Windows Kits\10\bin\*") do if exist "%%S\x64\signtool.exe" set "CLOUDCODE_BUILD_SDK=%%S\x64"
if not defined CLOUDCODE_BUILD_SDK (
	echo Windows SDK signtool.exe was not found. Install the Windows SDK through Visual Studio 2022 Build Tools. 1>&2
	goto failed
)
set "PATH=%CLOUDCODE_BUILD_SDK%;%PATH%"

:sdk_ready
set "CLOUDCODE_BUILD_STEP=Installing dependencies"
echo [1/7] %CLOUDCODE_BUILD_STEP%
call npm ci
if errorlevel 1 goto failed

set "CLOUDCODE_BUILD_STEP=Preparing policy types"
echo [2/7] %CLOUDCODE_BUILD_STEP%
call npm run copy-policy-dto --prefix build
if errorlevel 1 goto failed

set "CLOUDCODE_BUILD_STEP=Generating Windows policies"
echo [3/7] %CLOUDCODE_BUILD_STEP%
node build/lib/policies/policyGenerator.ts build/lib/policies/policyData.jsonc win32
if errorlevel 1 goto failed

set "CLOUDCODE_BUILD_STEP=Compiling and packaging CloudCode"
echo [4/7] %CLOUDCODE_BUILD_STEP%
call npm run gulp -- vscode-win32-x64-min
if errorlevel 1 goto failed

set "CLOUDCODE_BUILD_STEP=Packaging the installer updater"
echo [5/7] %CLOUDCODE_BUILD_STEP%
call npm run gulp -- vscode-win32-x64-inno-updater
if errorlevel 1 goto failed

set "CLOUDCODE_BUILD_STEP=Creating the user installer"
echo [6/7] %CLOUDCODE_BUILD_STEP%
call npm run gulp -- vscode-win32-x64-user-setup
if errorlevel 1 goto failed

set "CLOUDCODE_BUILD_STEP=Preparing download files"
echo [7/7] %CLOUDCODE_BUILD_STEP%
copy /y ".build\win32-x64\user-setup\VSCodeSetup.exe" ".build\%CLOUDCODE_BUILD_NAME%Setup-x64.exe" >nul
if errorlevel 1 goto failed
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; $hash = Get-FileHash '.build\%CLOUDCODE_BUILD_NAME%Setup-x64.exe' -Algorithm SHA256; ($hash.Hash.ToLowerInvariant() + '  %CLOUDCODE_BUILD_NAME%Setup-x64.exe') | Set-Content -Encoding ascii '.build\%CLOUDCODE_BUILD_NAME%Setup-x64.exe.sha256'"
if errorlevel 1 goto failed
if not defined CLOUDCODE_BUILD_ZIP goto complete

set "CLOUDCODE_BUILD_STEP=Creating the optional ZIP"
echo %CLOUDCODE_BUILD_STEP%
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; Compress-Archive -Path '..\VSCode-win32-x64\*' -DestinationPath '.build\%CLOUDCODE_BUILD_NAME%-win-x64.zip' -Force; $hash = Get-FileHash '.build\%CLOUDCODE_BUILD_NAME%-win-x64.zip' -Algorithm SHA256; ($hash.Hash.ToLowerInvariant() + '  %CLOUDCODE_BUILD_NAME%-win-x64.zip') | Set-Content -Encoding ascii '.build\%CLOUDCODE_BUILD_NAME%-win-x64.zip.sha256'"
if errorlevel 1 goto failed

:complete
echo.
echo Build complete. Installer: "%CD%\.build\%CLOUDCODE_BUILD_NAME%Setup-x64.exe"
echo SHA-256: "%CD%\.build\%CLOUDCODE_BUILD_NAME%Setup-x64.exe.sha256"
if defined CLOUDCODE_BUILD_ZIP echo ZIP: "%CD%\.build\%CLOUDCODE_BUILD_NAME%-win-x64.zip"
echo Test the packaged app and installer before uploading them to the website.
echo This installer is unsigned. Automatic updates are not configured by this script.
popd
exit /b 0

:failed
set "CLOUDCODE_BUILD_EXIT=%errorlevel%"
if "%CLOUDCODE_BUILD_EXIT%"=="0" set "CLOUDCODE_BUILD_EXIT=1"
echo. 1>&2
echo %CLOUDCODE_BUILD_NAME% build failed during: %CLOUDCODE_BUILD_STEP%. See the error above. 1>&2
echo Any existing download files may be from an earlier build. 1>&2
popd
exit /b %CLOUDCODE_BUILD_EXIT%

:invalid_arguments
echo Unsupported arguments. Use --brand cloudcompute or --brand atmoscode, --zip, or --help. 1>&2
exit /b 2

:help
echo Usage: scripts\build-cloudcode-win32.bat [--brand cloudcompute^|atmoscode] [--zip]
echo Run from Developer PowerShell or Developer Command Prompt for VS 2022.
echo Requires the Node version in .nvmrc, Git, Python, VS 2022 C++ Build Tools and Windows SDK.
echo Default brand: cloudcompute. AtmosCode uses separate application and profile identities.
echo Builds the current checkout. Dependencies are installed automatically.
echo Output: .build\%CLOUDCODE_BUILD_NAME%Setup-x64.exe and its SHA-256 checksum.
echo --zip also creates .build\%CLOUDCODE_BUILD_NAME%-win-x64.zip and its checksum.
exit /b 0


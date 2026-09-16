# CloudCode branding

The source mark is [resources/cloudcode/cloudcode.svg](../resources/cloudcode/cloudcode.svg): a navy cloud outline with a circular double-arrow badge. It has transparent space around the white cloud and badge, so it works on both light and dark backgrounds.

Generated assets are checked in. Normal development and installer builds use them directly; they do not require additional Python dependencies.

## Included surfaces

- Windows executable, title bar, taskbar, desktop and Start-menu shortcuts, installer executable and wizard artwork, uninstall entry, and Start tiles.
- macOS application/Dock icon and Linux application/package icons.
- Windows and macOS file-association icons, with distinct language symbols and a small CloudCode badge.
- Web favicon and app icons.
- Workbench welcome/onboarding logo and the empty-editor watermark in light, dark and high-contrast themes; the bundled GitHub authentication page logo.

The existing icon paths remain stable so the platform packaging tasks pick up the new artwork. External product logos and language symbols retain their own identities.

## Regenerate after editing the source

On a machine with Python 3 and Cairo available, install the maintainer dependencies and run:

```sh
python3 -m pip install CairoSVG Pillow
python3 scripts/generate-cloudcode-icons.py
```

The generator exports PNG, multi-size ICO, ICNS, XPM, themed SVG watermarks, and the installer BMPs at their existing dimensions. Document symbols reuse the repository's vector language glyphs in `extensions/theme-modern-icons/fileicons/images`, with simple vector symbols for the remaining types. No font installation or image-generation service is required. Commit the source, generator and regenerated assets together.

Inspect the 16-, 24-, 32- and 256-pixel icons on light and dark backgrounds, the document badges, and the themed watermarks when changing the design. The Windows ICO includes 16, 20, 24, 32, 40, 48, 64, 128 and 256 pixel entries.

## Refresh an existing development runtime

The development launcher caches its Electron executable. To refresh its embedded icon after pulling branding changes, close all development windows and run:

```powershell
npm run electron
.\scripts\code.bat
```

For a distributable, use [the Windows build script](cloudcode-windows-build.md) instead. It packages the new artwork in the application and installer. Application IDs and profile locations do not change with the icon.

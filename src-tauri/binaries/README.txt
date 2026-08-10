Place the PyInstaller onedir sidecar here before packaging:

  civ7-localization-engine-<target-triple>[.exe]
  _internal/   (required next to the .exe — PyInstaller loads python DLL from here)

Example for 64-bit Windows:

  civ7-localization-engine-x86_64-pc-windows-msvc.exe
  _internal/

Use `npm run build:engine` (scripts/build_python.ps1) to populate both.
Development startup does not require this file. Starting a job without it returns
the typed `sidecar_not_found` error. For local engine development, set
`CIV7_LOCALIZATION_ENGINE_PATH` to an absolute onedir executable that already
has `_internal` beside it.

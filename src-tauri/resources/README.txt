Runtime resources copied by the release pipeline belong in this directory.
Do not place API keys or other secrets here.

`_internal/` is the PyInstaller onedir runtime. It must also exist next to the
sidecar executable (see binaries/). `npm run build:engine` populates both.

from pathlib import Path


ENGINE_DIR = Path(SPEC).resolve().parent
hidden_imports = [
    "google.genai",
    "google.genai.errors",
    "google.genai.types",
    "cld3",
    "gcld3",
    "translate_tool.common",
    "translate_tool.civ7",
    "translate_tool.legend",
    "translate_tool.legend_json",
]

a = Analysis(
    [str(ENGINE_DIR / "translate_tool_entry.py")],
    pathex=[str(ENGINE_DIR)],
    binaries=[],
    datas=[],
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="localization-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    # The Tauri orchestrator exchanges JSONL through stdin/stdout.  A Windows
    # "windowed" PyInstaller build replaces those streams with None, so keep
    # console support enabled; Rust starts the process with CREATE_NO_WINDOW.
    console=True,
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    name="localization-engine",
)

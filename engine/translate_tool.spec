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
    console=False,
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

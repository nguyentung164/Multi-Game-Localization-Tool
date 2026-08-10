param(
    [string]$OutputDirectory = "",
    [switch]$SkipInstall,
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EngineRoot = Join-Path $ProjectRoot "engine"
$VenvRoot = Join-Path $EngineRoot ".venv-build"
$Python = Join-Path $VenvRoot "Scripts\python.exe"
$Spec = Join-Path $EngineRoot "civ7_tool.spec"
$Work = Join-Path $EngineRoot "build\pyinstaller"
$TauriRoot = Join-Path $ProjectRoot "src-tauri"
$SidecarDirectory = Join-Path $TauriRoot "binaries"
# PyInstaller onedir requires `_internal` next to the .exe (not only under resources/).
$SidecarRuntimeDirectory = Join-Path $SidecarDirectory "_internal"
$ResourceRuntimeDirectory = Join-Path $TauriRoot "resources\_internal"

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $EngineRoot "dist"
}

$env:PYTHONUTF8 = "1"

if (-not (Test-Path $Python)) {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        py -3 -m venv $VenvRoot
    } else {
        python -m venv $VenvRoot
    }
}

if (-not $SkipInstall) {
    & $Python -m pip install --upgrade pip
    & $Python -m pip install -r (Join-Path $EngineRoot "requirements-build.txt")
}

if (-not $SkipTests) {
    & $Python -m compileall -q (Join-Path $EngineRoot "civ7_tool")
    & $Python -m pytest (Join-Path $ProjectRoot "tests\python") -q
}

& $Python -m PyInstaller `
    --clean `
    --noconfirm `
    --distpath $OutputDirectory `
    --workpath $Work `
    $Spec

$Executable = Join-Path $OutputDirectory "civ7-tool-engine\civ7-tool-engine.exe"
if (-not (Test-Path $Executable)) {
    throw "PyInstaller không tạo được executable: $Executable"
}

$RuntimeSource = Join-Path $OutputDirectory "civ7-tool-engine\_internal"
$Sidecar = Join-Path $SidecarDirectory "civ7-localization-engine-x86_64-pc-windows-msvc.exe"

New-Item -ItemType Directory -Force $SidecarDirectory | Out-Null
New-Item -ItemType Directory -Force (Split-Path -Parent $ResourceRuntimeDirectory) | Out-Null
Copy-Item -Force $Executable $Sidecar

foreach ($RuntimeDirectory in @($SidecarRuntimeDirectory, $ResourceRuntimeDirectory)) {
    if (Test-Path $RuntimeDirectory) {
        Remove-Item -Recurse -Force $RuntimeDirectory
    }
    Copy-Item -Recurse -Force $RuntimeSource $RuntimeDirectory
}

# Stamp file watched by src-tauri/build.rs (avoid cargo watching the whole _internal tree).
$Stamp = Join-Path $SidecarDirectory ".engine-runtime-stamp"
$StampPayload = @(
    (Get-Item $Executable).LastWriteTimeUtc.ToString("o")
    (Get-ChildItem -Recurse -File $RuntimeSource | Measure-Object -Property Length -Sum).Sum
) -join "`n"
Set-Content -Path $Stamp -Value $StampPayload -Encoding utf8

Write-Output $Sidecar

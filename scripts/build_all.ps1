param(
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $ProjectRoot
try {
    Write-Host "==> Build Python engine sidecar"
    $engineArgs = @("-ExecutionPolicy", "Bypass", "-File", (Join-Path $ProjectRoot "scripts\build_python.ps1"))
    if ($SkipTests) {
        $engineArgs += "-SkipTests"
    }
    & powershell @engineArgs

    if (-not $SkipTests) {
        Write-Host "==> Frontend check (lint + test + build)"
        npm run check

        Write-Host "==> Rust tests"
        Push-Location (Join-Path $ProjectRoot "src-tauri")
        cargo test
        Pop-Location
    }

    Write-Host "==> Tauri release bundle (NSIS)"
    # PyInstaller onedir needs `_internal` next to the sidecar in the installed app.
    # Keep it out of the base tauri.conf so `tauri dev` does not rescan ~100MB each rebuild.
    $runtime = Join-Path $ProjectRoot "src-tauri\binaries\_internal"
    if (-not (Test-Path $runtime)) {
        throw "Thiếu $runtime — chạy scripts/build_python.ps1 trước."
    }

    # Stale junction from `tauri dev` / prior builds aliases binaries/_internal and
    # collides with Tauri resource embedding (Windows os error 32).
    Push-Location (Join-Path $ProjectRoot "src-tauri")
    try {
        $CargoMetadata = cargo metadata --format-version 1 --no-deps | ConvertFrom-Json
        $CargoTargetDirectory = [string]$CargoMetadata.target_directory
    }
    finally {
        Pop-Location
    }
    if (-not $CargoTargetDirectory) {
        throw "Không xác định được Cargo target directory."
    }
    $releaseRoot = Join-Path $CargoTargetDirectory "release"
    $releaseInternal = Join-Path $releaseRoot "_internal"
    if (Test-Path $releaseInternal) {
        Write-Host "Removing stale $releaseInternal"
        cmd /c "rmdir `"$releaseInternal`""
        if (Test-Path $releaseInternal) {
            Remove-Item -LiteralPath $releaseInternal -Force -Recurse -ErrorAction SilentlyContinue
        }
    }

    $releaseConfig = Join-Path $ProjectRoot "src-tauri\tauri.release.conf.json"
    npm run tauri build -- --config $releaseConfig
    if ($LASTEXITCODE -ne 0) {
        throw "tauri build failed with exit code $LASTEXITCODE"
    }

    $nsi = Join-Path $releaseRoot "nsis\x64\installer.nsi"
    if (-not (Test-Path $nsi) -or -not (Select-String -Path $nsi -Pattern '_internal' -Quiet)) {
        throw "Installer NSIS thiếu _internal — kiểm tra tauri.release.conf.json / bundle resources."
    }

    $installer = Join-Path $releaseRoot "bundle\nsis\Multi-Game Localization Tool_1.1.0_x64-setup.exe"
    if (-not (Test-Path $installer)) {
        throw "Không tìm thấy installer: $installer"
    }

    Write-Host ""
    Write-Host "Hoàn tất. Installer:"
    Write-Host $installer
}
finally {
    Pop-Location
}

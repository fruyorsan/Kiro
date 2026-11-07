# Builds Kiro from the current working tree, uninstalls the copy in $InstallDir,
# installs the fresh build, and launches it. This is the "install every change"
# helper: run it once after editing, and the laptop matches the repository.
#
#   powershell -ExecutionPolicy Bypass -File scripts/install-local.ps1
#
# Pass -NoLaunch to skip starting the app, or -InstallDir to target a different
# folder. Settings live in %APPDATA%\com.fruyorsan.kiro and are never touched.

param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Kiro"),
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot/.."
Set-Location $root

function Wait-For([scriptblock]$condition, [int]$seconds, [string]$what) {
    for ($i = 0; $i -lt ($seconds * 2); $i++) {
        if (& $condition) { return $true }
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for $what"
}

Write-Host "==> Stopping running Kiro" -ForegroundColor Cyan
Get-Process kiro -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host "==> Building app and installer payload" -ForegroundColor Cyan
& (Join-Path $root "installer-app/scripts/build-payload.ps1")
if ($LASTEXITCODE -ne 0) { throw "build-payload.ps1 failed (exit $LASTEXITCODE)" }

Write-Host "==> Building installer" -ForegroundColor Cyan
Push-Location (Join-Path $root "installer-app")
try {
    & bun run tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "installer build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

$installer = Join-Path $root "installer-app/src-tauri/target/release/kiro-installer.exe"
if (-not (Test-Path $installer)) { throw "Installer not found at $installer" }

$uninstaller = Join-Path $InstallDir "uninstall.exe"
if (Test-Path $uninstaller) {
    Write-Host "==> Removing the old install in $InstallDir" -ForegroundColor Cyan
    $old = Start-Process -FilePath $uninstaller -ArgumentList "--auto-uninstall" -PassThru
    $old.WaitForExit(120000) | Out-Null
    # The file cleanup runs in a detached PowerShell that waits for the
    # uninstaller to exit. If it is still sitting on a dialog, end it so the
    # cleanup can finish instead of blocking the install.
    if (-not $old.HasExited) { Stop-Process -Id $old.Id -Force -ErrorAction SilentlyContinue }
    Wait-For { -not (Test-Path (Join-Path $InstallDir "kiro.exe")) } 60 "the old install to be removed"
}

Write-Host "==> Installing the fresh build into $InstallDir" -ForegroundColor Cyan
$setup = Start-Process -FilePath $installer -ArgumentList "--auto-install", "--install-dir=`"$InstallDir`"" -PassThru
$registry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Kiro"
Wait-For { Test-Path $registry } 180 "the installer to register Kiro"
Wait-For { (Get-ItemProperty $registry -ErrorAction SilentlyContinue).DisplayVersion } 60 "the uninstall entry to be written"
Start-Sleep -Seconds 2
if (-not $setup.HasExited) { $setup.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 1 }
if (-not $setup.HasExited) { Stop-Process -Id $setup.Id -Force -ErrorAction SilentlyContinue }

$exe = Join-Path $InstallDir "kiro.exe"
$version = (Get-ItemProperty $registry).DisplayVersion
Write-Host "==> Installed Kiro $version at $exe" -ForegroundColor Green

& $exe agent install-hooks | Out-Null

if (-not $NoLaunch) {
    Write-Host "==> Launching Kiro" -ForegroundColor Cyan
    Start-Process -FilePath $exe
}

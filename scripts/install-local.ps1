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

    # Two separate traps here, both of which made this script print success
    # while nothing was on screen:
    #
    # 1. A plain Start-Process makes Kiro a child of this script, and it dies
    #    with the script's process tree once the script exits. Launching through
    #    explorer.exe hands the launch to the shell, so Kiro outlives us. The
    #    installer does the same thing when it runs elevated.
    # 2. The installer can start its own copy, which loses the single-instance
    #    race and exits within a second. "A process appeared" is therefore not
    #    the same as "Kiro is running", so the wait below checks that the same
    #    pid is still alive a few seconds later.
    $launch = { Start-Process -FilePath "explorer.exe" -ArgumentList "`"$exe`"" }
    $alive = {
        param($processId)
        $processId -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)
    }

    $running = $null
    # The installer may have already started Kiro while it was finishing. If
    # that copy is stable, launching another one would only trip the
    # single-instance path and pop the settings window open for no reason.
    $existing = Get-Process kiro -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existing) {
        Start-Sleep -Seconds 3
        if (& $alive $existing.Id) { $running = $existing }
    }

    for ($attempt = 0; $attempt -lt 2 -and -not $running; $attempt++) {
        if ($attempt -gt 0) { Start-Sleep -Seconds 2 }
        & $launch

        $candidate = $null
        for ($i = 0; $i -lt 30; $i++) {
            $candidate = Get-Process kiro -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($candidate) { break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $candidate) { continue }

        # Still starting up at this point is normal; still alive after 5 s means
        # it won the single-instance mutex and stayed.
        Start-Sleep -Seconds 5
        if (& $alive $candidate.Id) { $running = $candidate }
    }

    if ($running) {
        Write-Host "==> Kiro is running (pid $($running.Id))" -ForegroundColor Green
    } else {
        Write-Warning "Kiro did not stay running. Start $exe manually and check $env:APPDATA\com.fruyorsan.kiro\logs\kiro.log"
    }
}

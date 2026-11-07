<#
.SYNOPSIS
  Measures the memory of a running Kiro instance, broken down per process.

.DESCRIPTION
  Reports private working set (what Task Manager shows as the app's "Memory"),
  commit and total working set for kiro.exe and every WebView2 process it
  owns. Samples are averaged because a WebView2 app's numbers move for a few
  seconds after startup.

.PARAMETER Samples
  Number of samples to average. Default: 3

.PARAMETER IntervalSeconds
  Seconds between samples. Default: 2

.PARAMETER Detail
  Print the per-process breakdown of the last sample.

.EXAMPLE
  .\scripts\measure-ram.ps1 -Detail
#>
[CmdletBinding()]
param(
  [int]$Samples = 3,
  [double]$IntervalSeconds = 2,
  [switch]$Detail
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\kiro-mem.ps1"

# Note: not `$samples` -- PowerShell variable names are case-insensitive, so it
# would be the same variable as the [int]$Samples parameter.
$collected = @()
for ($i = 0; $i -lt $Samples; $i++) {
  $sample = Get-KiroProcessTree
  if ($null -eq $sample) {
    Write-Host "kiro is not running." -ForegroundColor Yellow
    return
  }
  $collected += $sample
  if ($i -lt $Samples - 1) { Start-Sleep -Seconds $IntervalSeconds }
}

$last = $collected[-1]
$ws = $collected | Measure-Object PrivateWS -Average -Minimum -Maximum
$commit = $collected | Measure-Object PrivateBytes -Average -Minimum -Maximum

Write-Host ""
Write-Host ("=== Kiro memory @ {0:HH:mm:ss} ({1} samples) ===" -f (Get-Date), $Samples) -ForegroundColor Cyan
Show-KiroMemory -Sample $last -Detail:$Detail
Write-Host ""
Write-Host ("  private WS  avg : {0}  [min {1} / max {2}]" -f (Format-MemMB $ws.Average), (Format-MemMB $ws.Minimum), (Format-MemMB $ws.Maximum))
Write-Host ("  commit      avg : {0}  [min {1} / max {2}]" -f (Format-MemMB $commit.Average), (Format-MemMB $commit.Minimum), (Format-MemMB $commit.Maximum))

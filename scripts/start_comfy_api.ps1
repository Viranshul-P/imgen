<#
.SYNOPSIS
  Launch / stop / check the headless ComfyUI API server used by PersonaForge.

.DESCRIPTION
  Reads COMFY_ROOT, COMFY_PYTHON, COMFY_HOST, COMFY_PORT and COMFY_FLAGS from
  .env.local (repo root). Default mode runs ComfyUI in the foreground. -Background
  detaches it, writes logs to logs\comfy.out.log / logs\comfy.err.log, records the
  PID in logs\comfy.pid, and waits until GET /system_stats answers.

.EXAMPLE
  .\scripts\start_comfy_api.ps1                 # foreground
  .\scripts\start_comfy_api.ps1 -Background     # detached, waits until ready
  .\scripts\start_comfy_api.ps1 -Background -LowVram
  .\scripts\start_comfy_api.ps1 -Status
  .\scripts\start_comfy_api.ps1 -Stop
  .\scripts\start_comfy_api.ps1 -Restart
#>
[CmdletBinding()]
param(
  [switch]$Background,
  [switch]$Stop,
  [switch]$Restart,
  [switch]$Status,
  [switch]$LowVram,
  [int]$TimeoutSec = 180,
  [string]$EnvFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path $PSScriptRoot -Parent
if (-not $EnvFile) { $EnvFile = Join-Path $RepoRoot '.env.local' }
$LogDir = Join-Path $RepoRoot 'logs'
$PidFile = Join-Path $LogDir 'comfy.pid'

function Read-DotEnv([string]$Path) {
  $vars = @{}
  if (-not (Test-Path $Path)) { throw "Missing $Path - run Phase 0 setup or copy .env.example to .env.local" }
  foreach ($line in Get-Content $Path) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $idx = $t.IndexOf('=')
    if ($idx -lt 1) { continue }
    $k = $t.Substring(0, $idx).Trim()
    $v = $t.Substring($idx + 1).Trim().Trim('"')
    $vars[$k] = $v
  }
  return $vars
}

$cfg = Read-DotEnv $EnvFile
$ComfyRoot = $cfg['COMFY_ROOT']
$Python = $cfg['COMFY_PYTHON']
$HostAddr = if ($cfg['COMFY_HOST']) { $cfg['COMFY_HOST'] } else { '127.0.0.1' }
$Port = if ($cfg['COMFY_PORT']) { $cfg['COMFY_PORT'] } else { '8188' }
$Flags = if ($cfg['COMFY_FLAGS']) { $cfg['COMFY_FLAGS'] } else { '--normalvram --reserve-vram 0.8 --disable-auto-launch' }
$BaseUrl = "http://${HostAddr}:$Port"

function Get-SystemStats {
  try { return Invoke-RestMethod -Uri "$BaseUrl/system_stats" -TimeoutSec 3 } catch { return $null }
}

function Show-Stats($s) {
  $dev = $s.devices | Select-Object -First 1
  $vt = [math]::Round($dev.vram_total / 1GB, 2); $vf = [math]::Round($dev.vram_free / 1GB, 2)
  $rt = [math]::Round($s.system.ram_total / 1GB, 2); $rf = [math]::Round($s.system.ram_free / 1GB, 2)
  Write-Host "ComfyUI $($s.system.comfyui_version) | python $($s.system.python_version.Split(' ')[0]) | torch $($s.system.pytorch_version)"
  Write-Host "Device : $($dev.name)"
  Write-Host "VRAM   : $vf GB free / $vt GB"
  Write-Host "RAM    : $rf GB free / $rt GB"
}

function Stop-Comfy {
  if (Test-Path $PidFile) {
    $procId = [int](Get-Content $PidFile)
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p) { Stop-Process -Id $procId -Force; Write-Host "Stopped ComfyUI (PID $procId)" }
    else { Write-Host "PID $procId not running" }
    Remove-Item $PidFile -Force
  }
  else { Write-Host 'No PID file - nothing to stop (a foreground instance must be closed with Ctrl+C).' }
}

if ($Status) {
  $s = Get-SystemStats
  if ($s) { Write-Host "UP at $BaseUrl" -ForegroundColor Green; Show-Stats $s; exit 0 }
  Write-Host "DOWN at $BaseUrl" -ForegroundColor Yellow; exit 1
}
if ($Stop) { Stop-Comfy; exit 0 }
if ($Restart) { Stop-Comfy; Start-Sleep -Seconds 2; $Background = $true }

if (-not (Test-Path $Python)) { throw "COMFY_PYTHON not found: $Python" }
$MainPy = Join-Path $ComfyRoot 'ComfyUI\main.py'
if (-not (Test-Path $MainPy)) { throw "ComfyUI main.py not found: $MainPy" }

if (Get-SystemStats) { Write-Host "ComfyUI already running at $BaseUrl" -ForegroundColor Green; Show-Stats (Get-SystemStats); exit 0 }

if ($LowVram) { $Flags = ($Flags -replace '--normalvram', '').Trim() + ' --lowvram' }
$argList = @('-s', "`"$MainPy`"", '--listen', $HostAddr, '--port', $Port) + ($Flags -split '\s+' | Where-Object { $_ })

Write-Host "Launching: $Python $($argList -join ' ')" -ForegroundColor Cyan

if (-not $Background) {
  Push-Location $ComfyRoot
  try { & $Python @argList } finally { Pop-Location }
  exit $LASTEXITCODE
}

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force $LogDir | Out-Null }
$out = Join-Path $LogDir 'comfy.out.log'
$err = Join-Path $LogDir 'comfy.err.log'
$proc = Start-Process -FilePath $Python -ArgumentList $argList -WorkingDirectory $ComfyRoot `
  -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
Set-Content -Path $PidFile -Value $proc.Id
Write-Host "Started PID $($proc.Id); logs in $LogDir. Waiting for $BaseUrl/system_stats ..."

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) {
    Write-Host "ComfyUI exited early (code $($proc.ExitCode)). Last log lines:" -ForegroundColor Red
    Get-Content $err -Tail 30
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
  }
  $s = Get-SystemStats
  if ($s) { Write-Host 'ComfyUI API is UP' -ForegroundColor Green; Show-Stats $s; exit 0 }
  Start-Sleep -Seconds 2
}
Write-Host "Timed out after $TimeoutSec s waiting for ComfyUI. See $err" -ForegroundColor Red
exit 1

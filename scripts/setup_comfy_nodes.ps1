<#
.SYNOPSIS
  PersonaForge Phase 1 - install the custom node packs PersonaForge needs into the
  PersonaForge ComfyUI (COMFY_ROOT in .env.local) and resolve Windows dependencies.

.DESCRIPTION
  - Backs up `pip freeze` and the custom_nodes list to logs\ before changing anything.
  - Clones missing node repos (shallow) into ComfyUI\custom_nodes. Existing clones are
    left alone unless -Update is passed (then: git pull --ff-only).
  - Installs each repo's requirements.txt with the ComfyUI embedded Python.
  - Installs ComfyUI-Manager the way ComfyUI >= 0.4 expects (pip package from
    manager_requirements.txt, enabled at launch with --enable-manager).
  - Windows wheel gotchas: insightface is installed from a prebuilt wheel matching
    the embedded Python's ABI when no compatible wheel is on PyPI; onnxruntime-gpu,
    gguf, ultralytics, opencv-python-headless, Pillow, numpy, huggingface_hub are
    pinned into one resolver pass so they do not fight each other.
  - Finishes with `pip check` and an import smoke test.

.EXAMPLE
  .\scripts\setup_comfy_nodes.ps1
  .\scripts\setup_comfy_nodes.ps1 -Update
  .\scripts\setup_comfy_nodes.ps1 -SkipReactor
#>
[CmdletBinding()]
param(
  [switch]$Update,
  [switch]$SkipReactor,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path $PSScriptRoot -Parent
$LogDir = Join-Path $RepoRoot 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force $LogDir | Out-Null }

function Read-DotEnv([string]$Path) {
  $vars = @{}
  foreach ($line in Get-Content $Path) {
    $t = $line.Trim(); if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('='); if ($i -lt 1) { continue }
    $vars[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim().Trim('"')
  }
  return $vars
}

$cfg = Read-DotEnv (Join-Path $RepoRoot '.env.local')
$ComfyRoot = $cfg['COMFY_ROOT']
$Python = $cfg['COMFY_PYTHON']
$ComfyDir = Join-Path $ComfyRoot 'ComfyUI'
$NodesDir = Join-Path $ComfyDir 'custom_nodes'
if (-not (Test-Path $Python)) { throw "COMFY_PYTHON not found: $Python" }
if (-not (Test-Path $NodesDir)) { throw "custom_nodes not found: $NodesDir" }

# Spec section 4. URLs verified against the GitHub API on 2026-11-11.
$Repos = @(
  @{ name = 'ComfyUI-GGUF';                  url = 'https://github.com/city96/ComfyUI-GGUF' },
  @{ name = 'ComfyUI_IPAdapter_plus';        url = 'https://github.com/cubiq/ComfyUI_IPAdapter_plus' },
  @{ name = 'ComfyUI-Impact-Pack';           url = 'https://github.com/ltdrdata/ComfyUI-Impact-Pack' },
  @{ name = 'ComfyUI-Impact-Subpack';        url = 'https://github.com/ltdrdata/ComfyUI-Impact-Subpack' },
  @{ name = 'comfyui_controlnet_aux';        url = 'https://github.com/Fannovel16/comfyui_controlnet_aux' },
  @{ name = 'ComfyUI-Inpaint-CropAndStitch'; url = 'https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch' },
  @{ name = 'ComfyUI-ReActor';               url = 'https://github.com/Gourieff/ComfyUI-ReActor'; optional = $true }
)

# Prebuilt insightface wheels (insightface has no Windows wheels on PyPI).
$InsightfaceWheelBase = 'https://github.com/Gourieff/Assets/raw/main/Insightface'

function Invoke-Step([string]$Label, [scriptblock]$Body) {
  Write-Host "`n>> $Label" -ForegroundColor Cyan
  if ($DryRun) { Write-Host '   (dry run - skipped)'; return }
  & $Body
}

# Windows PowerShell 5.1 turns any native stderr output into a terminating error when
# $ErrorActionPreference is 'Stop'. Native tools (pip, git, python) write warnings to stderr,
# so run them with 'Continue' and judge success by exit code only.
function Invoke-Native([scriptblock]$Cmd) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Cmd 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
}

function Test-PyImport([string]$Module) {
  [void](Invoke-Native { & $Python -s -c "import $Module" })
  return ($LASTEXITCODE -eq 0)
}

function Invoke-Pip([string[]]$PipArgs) {
  $extra = @('--disable-pip-version-check')
  if ($PipArgs[0] -eq 'install') { $extra += '--no-warn-script-location' }
  Invoke-Native { & $Python -s -m pip @PipArgs @extra } | Write-Host
  if ($LASTEXITCODE -ne 0) { throw "pip $($PipArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

# ------------------------------------------------------------------ backup
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Invoke-Step 'Backing up pip freeze and custom_nodes list' {
  Invoke-Native { & $Python -s -m pip freeze --disable-pip-version-check } | Out-File -Encoding utf8 (Join-Path $LogDir "comfy_pip_backup-$stamp.txt")
  Get-ChildItem $NodesDir -Directory | Select-Object -ExpandProperty Name | Out-File -Encoding utf8 (Join-Path $LogDir "custom_nodes_backup-$stamp.txt")
  Write-Host "   saved to logs\comfy_pip_backup-$stamp.txt"
}

$pyTag = ((Invoke-Native { & $Python -c "import sys;print(f'cp{sys.version_info.major}{sys.version_info.minor}')" }) | Select-Object -Last 1).Trim()
Write-Host "Embedded Python ABI: $pyTag"

# ------------------------------------------------------------------ clone
foreach ($r in $Repos) {
  if ($SkipReactor -and $r.ContainsKey('optional')) { continue }
  $dest = Join-Path $NodesDir $r.name
  if (Test-Path (Join-Path $dest '.git')) {
    if ($Update) { Invoke-Step "Updating $($r.name)" { Invoke-Native { git -C $dest pull --ff-only } | Write-Host } }
    else { Write-Host "   [ok] $($r.name) already present" }
    continue
  }
  Invoke-Step "Cloning $($r.url)" {
    Invoke-Native { git clone --depth 1 $r.url $dest } | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "git clone failed for $($r.url)" }
  }
}

# ------------------------------------------------------------------ manager
Invoke-Step 'Installing ComfyUI-Manager (pip package, enabled with --enable-manager)' {
  $req = Join-Path $ComfyDir 'manager_requirements.txt'
  if (Test-Path $req) { Invoke-Pip @('install', '-r', $req) }
  else { Write-Host '   manager_requirements.txt not present in this ComfyUI version - skipping' -ForegroundColor Yellow }
}

# ------------------------------------------------------------------ insightface
Invoke-Step 'Installing insightface (built from source against the embedded numpy)' {
  if (Test-PyImport 'insightface.app') { Write-Host '   insightface already importable'; return }
  # insightface has no Windows wheels on PyPI, and the community prebuilt wheels are compiled
  # against numpy 1.x, which fails on ComfyUI's numpy 2.x ("numpy.dtype size changed").
  # The embedded Python has no C headers, so build the wheel with a host CPython of the same
  # ABI (pip wheel uses an isolated build env - nothing is installed into the host Python).
  $verDot = $pyTag.Substring(2, 1) + '.' + $pyTag.Substring(3)
  $hostPy = $null
  foreach ($cand in @($env:PF_HOST_PYTHON, "C:\Program Files\Python$($pyTag.Substring(2))\python.exe",
      "$env:LOCALAPPDATA\Programs\Python\Python$($pyTag.Substring(2))\python.exe")) {
    if ($cand -and (Test-Path $cand)) { $hostPy = $cand; break }
  }
  if (-not $hostPy) {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
      $p = (Invoke-Native { & py "-$verDot" -c "import sys;print(sys.executable)" }) | Select-Object -Last 1
      if ($LASTEXITCODE -eq 0 -and $p -and (Test-Path $p.Trim())) { $hostPy = $p.Trim() }
    }
  }
  $wheelDir = Join-Path $LogDir 'wheels'
  if (-not (Test-Path $wheelDir)) { New-Item -ItemType Directory -Force $wheelDir | Out-Null }
  if ($hostPy) {
    Write-Host "   building insightface wheel with host Python $hostPy (requires MSVC Build Tools)"
    Invoke-Native { & $hostPy -m pip wheel insightface==0.7.3 --no-deps -w $wheelDir --disable-pip-version-check } | Write-Host
    if ($LASTEXITCODE -ne 0) { throw 'insightface source build failed - install Visual Studio Build Tools (C++ workload)' }
    $wheel = Get-ChildItem $wheelDir -Filter "insightface-0.7.3-$pyTag-*.whl" | Select-Object -First 1
    Invoke-Pip @('install', '--force-reinstall', $wheel.FullName)
  }
  else {
    Write-Host "   no host Python $verDot found - falling back to prebuilt wheel (numpy 1.x ABI)" -ForegroundColor Yellow
    Invoke-Pip @('install', "$InsightfaceWheelBase/insightface-0.7.3-$pyTag-$pyTag-win_amd64.whl")
  }
}

# ------------------------------------------------------------------ core shared deps
Invoke-Step 'Installing shared Windows-sensitive dependencies in one resolver pass' {
  # No numpy/Pillow pins: keep the versions ComfyUI ships with; pip check below catches real conflicts.
  Invoke-Pip @('install', 'onnxruntime-gpu', 'gguf>=0.13', 'ultralytics', 'opencv-python-headless',
    'Pillow', 'numpy', 'huggingface_hub', 'segment-anything', 'piexif', 'scikit-image')
}

# ------------------------------------------------------------------ per-repo requirements
foreach ($r in $Repos) {
  if ($SkipReactor -and $r.ContainsKey('optional')) { continue }
  $dest = Join-Path $NodesDir $r.name
  $req = Join-Path $dest 'requirements.txt'
  if (-not (Test-Path $req)) { continue }
  Invoke-Step "requirements.txt for $($r.name)" {
    # insightface is already satisfied from the wheel; let pip see it as installed.
    Invoke-Pip @('install', '-r', $req)
  }
}

# comfyui_controlnet_aux uses albumentationsx (maintained fork); ReActor's "albumentations>=1.4.16"
# pulls the legacy package, which pins an old albucore and overwrites the same import namespace,
# breaking insightface. Keep only albumentationsx (it provides `import albumentations`).
Invoke-Step 'Resolving albumentations / albumentationsx namespace clash' {
  [void](Invoke-Native { & $Python -s -m pip show albumentationsx --disable-pip-version-check })
  if ($LASTEXITCODE -ne 0) { Write-Host '   albumentationsx not installed - nothing to resolve'; return }
  [void](Invoke-Native { & $Python -s -m pip show albumentations --disable-pip-version-check })
  if ($LASTEXITCODE -eq 0) { Invoke-Pip @('uninstall', '-y', 'albumentations') }
  $ver = ((Invoke-Native { & $Python -s -m pip show albumentationsx --disable-pip-version-check }) |
      Select-String '^Version:\s*(.+)$' | Select-Object -First 1).Matches[0].Groups[1].Value.Trim()
  Invoke-Pip @('install', '--force-reinstall', '--no-deps', "albumentationsx==$ver")
  Invoke-Pip @('install', "albumentationsx==$ver")   # restores its pinned albucore
}

# A node may pull CPU-only onnxruntime, which shadows onnxruntime-gpu: keep only the GPU build.
Invoke-Step 'Ensuring onnxruntime-gpu is the active onnxruntime' {
  [void](Invoke-Native { & $Python -s -m pip show onnxruntime --disable-pip-version-check })
  if ($LASTEXITCODE -eq 0) {
    Invoke-Pip @('uninstall', '-y', 'onnxruntime')
    Invoke-Pip @('install', '--force-reinstall', '--no-deps', 'onnxruntime-gpu')
  }
}

# ------------------------------------------------------------------ verification
Invoke-Step 'pip check' {
  Invoke-Native { & $Python -s -m pip check --disable-pip-version-check } | Write-Host
  if ($LASTEXITCODE -ne 0) { Write-Host '   pip check reported conflicts (see above)' -ForegroundColor Yellow }
}

Invoke-Step 'Import smoke test' {
  $code = @'
import importlib, sys
mods = ["torch", "insightface.app", "onnxruntime", "gguf", "ultralytics", "cv2", "PIL", "numpy", "huggingface_hub", "segment_anything"]
bad = 0
for m in mods:
    try:
        mod = importlib.import_module(m)
        print(f"   ok   {m:18s} {getattr(mod, '__version__', '')}")
    except Exception as e:
        bad += 1
        print(f"   FAIL {m:18s} {type(e).__name__}: {e}")
import onnxruntime as ort
print("   onnxruntime providers:", ", ".join(ort.get_available_providers()))
sys.exit(1 if bad else 0)
'@
  # PS 5.1 mangles embedded double quotes in native args, so run the probe from a file.
  $probe = Join-Path $LogDir 'import_smoke.py'
  [System.IO.File]::WriteAllText($probe, $code, (New-Object System.Text.UTF8Encoding($false)))
  Invoke-Native { & $Python -s $probe } | Write-Host
  if ($LASTEXITCODE -ne 0) { throw 'Import smoke test failed' }
}

Write-Host "`nPhase 1 node setup finished. Restart ComfyUI and run scripts\check_nodes.ps1." -ForegroundColor Green

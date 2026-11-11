<#
.SYNOPSIS
  PersonaForge Phase 0 - discover existing ComfyUI installs / model folders and
  (optionally) bind them to a target ComfyUI via extra_model_paths.yaml.

.DESCRIPTION
  Read-only by default. Scans user profiles (that this account can read), the Public
  profile, drive roots and common download locations for ComfyUI installs (main.py +
  folder_paths.py) and Fooocus model folders. Prints a report and can write it as JSON.

  With -WriteExtraModelPaths it writes <ComfyRoot>\ComfyUI\extra_model_paths.yaml that
  maps every discovered models directory into the target install. Source installs are
  never modified; an existing yaml is backed up first. Never changes ACLs.

.EXAMPLE
  .\scripts\discover_comfy.ps1
  .\scripts\discover_comfy.ps1 -JsonOut docs\discovery.json
  .\scripts\discover_comfy.ps1 -WriteExtraModelPaths -ComfyRoot ..\ComfyUI_windows_portable
#>
[CmdletBinding()]
param(
  [string[]]$ExtraSearchRoots = @(),
  [switch]$Deep,
  [string]$JsonOut,
  [switch]$WriteExtraModelPaths,
  [string]$ComfyRoot,
  [string[]]$ExcludeRoots = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ComfyUI folder names that may appear under a models directory.
$KnownModelFolders = @(
  'checkpoints', 'clip', 'text_encoders', 'clip_vision', 'configs', 'controlnet',
  'diffusers', 'diffusion_models', 'unet', 'embeddings', 'gligen', 'hypernetworks',
  'loras', 'photomaker', 'style_models', 'upscale_models', 'vae', 'vae_approx',
  'ipadapter', 'insightface', 'instantid', 'ultralytics', 'sams', 'facerestore_models',
  'facedetection', 'inpaint', 'model_patches', 'audio_encoders'
)

function Test-Readable([string]$Path) {
  try { $null = Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop | Select-Object -First 1; return $true }
  catch { return $false }
}

function Get-SearchRoots {
  $roots = New-Object System.Collections.Generic.List[string]
  foreach ($u in Get-ChildItem C:\Users -Directory -Force -ErrorAction SilentlyContinue) {
    if ($u.Name -in @('Default', 'Default User', 'All Users')) { continue }
    if (Test-Readable $u.FullName) { $roots.Add($u.FullName) }
    else { Write-Host "  [skip] $($u.FullName) (not readable by this account; ACLs left untouched)" -ForegroundColor DarkYellow }
  }
  foreach ($d in Get-PSDrive -PSProvider FileSystem) {
    foreach ($p in 'ComfyUI', 'ComfyUI_windows_portable', 'AI', 'StabilityMatrix', 'Fooocus') {
      $full = Join-Path $d.Root $p
      if (Test-Path -LiteralPath $full) { $roots.Add($full) }
    }
  }
  foreach ($r in $ExtraSearchRoots) { if (Test-Path -LiteralPath $r) { $roots.Add((Resolve-Path $r).Path) } }
  return $roots | Select-Object -Unique
}

function Test-Excluded([string]$Path) {
  if ($Path -match '\\\$Recycle\.Bin\\|\\node_modules\\|\\site-packages\\|\\\.git\\') { return $true }
  foreach ($x in $ExcludeRoots) {
    $rx = (Resolve-Path -LiteralPath $x -ErrorAction SilentlyContinue)
    if ($rx -and $Path.StartsWith($rx.Path, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Find-ComfyRoots([string[]]$Roots) {
  $depth = if ($Deep) { 8 } else { 5 }
  $found = New-Object System.Collections.Generic.List[string]
  foreach ($r in $Roots) {
    Get-ChildItem -LiteralPath $r -Filter 'folder_paths.py' -Recurse -Depth $depth -File -Force -ErrorAction SilentlyContinue |
      Where-Object { -not (Test-Excluded $_.FullName) -and (Test-Path (Join-Path $_.DirectoryName 'main.py')) -and (Test-Path (Join-Path $_.DirectoryName 'comfy')) } |
      ForEach-Object { $found.Add($_.DirectoryName) }
  }
  return $found | Select-Object -Unique
}

function Find-FooocusModelDirs([string[]]$Roots) {
  $found = New-Object System.Collections.Generic.List[string]
  foreach ($r in $Roots) {
    Get-ChildItem -LiteralPath $r -Filter 'entry_with_update.py' -Recurse -Depth 5 -File -Force -ErrorAction SilentlyContinue |
      Where-Object { -not (Test-Excluded $_.FullName) } |
      ForEach-Object { $m = Join-Path $_.DirectoryName 'models'; if (Test-Path $m) { $found.Add($m) } }
  }
  return $found | Select-Object -Unique
}

function Get-PythonInfo([string]$ComfyDir) {
  $parent = Split-Path $ComfyDir -Parent
  $candidates = @(
    (Join-Path $parent 'python_embeded\python.exe'),
    (Join-Path $ComfyDir '.venv\Scripts\python.exe'),
    (Join-Path $ComfyDir 'venv\Scripts\python.exe'),
    (Join-Path $parent '.venv\Scripts\python.exe')
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) {
      $ver = (& $c -c "import sys;print(sys.version.split()[0])" 2>$null)
      $torch = (& $c -c "import torch;print(torch.__version__, 'cuda=' + str(torch.cuda.is_available()))" 2>$null)
      return [ordered]@{ exe = $c; version = "$ver"; torch = $(if ($torch) { "$torch" } else { 'not installed' }) }
    }
  }
  return [ordered]@{ exe = $null; version = $null; torch = $null }
}

function Get-ModelInventory([string]$ModelsDir) {
  $inv = [ordered]@{}
  foreach ($sub in Get-ChildItem -LiteralPath $ModelsDir -Directory -ErrorAction SilentlyContinue) {
    $files = @(Get-ChildItem -LiteralPath $sub.FullName -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in '.safetensors', '.gguf', '.ckpt', '.pt', '.pth', '.bin', '.onnx' })
    if ($files.Count -gt 0) {
      $inv[$sub.Name] = @($files | ForEach-Object {
          [ordered]@{ file = $_.FullName.Substring($sub.FullName.Length + 1); gb = [math]::Round($_.Length / 1GB, 3) }
        })
    }
  }
  return $inv
}

function Get-ComfyReport([string]$ComfyDir) {
  $versionFile = Join-Path $ComfyDir 'comfyui_version.py'
  $version = $null
  if (Test-Path $versionFile) {
    $m = Select-String -Path $versionFile -Pattern '__version__\s*=\s*"([^"]+)"' | Select-Object -First 1
    if ($m) { $version = $m.Matches[0].Groups[1].Value }
  }
  $nodes = @(Get-ChildItem -LiteralPath (Join-Path $ComfyDir 'custom_nodes') -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notin '__pycache__', '.disabled' } | Select-Object -ExpandProperty Name)
  $modelsDir = Join-Path $ComfyDir 'models'
  return [ordered]@{
    root         = $ComfyDir
    version      = $version
    python       = Get-PythonInfo $ComfyDir
    models_dir   = $modelsDir
    custom_nodes = $nodes
    models       = Get-ModelInventory $modelsDir
  }
}

function ConvertTo-YamlPath([string]$p) { return ($p -replace '\\', '/') }

function Write-ExtraModelPaths([string]$TargetComfyDir, [object[]]$Sources) {
  $yamlPath = Join-Path $TargetComfyDir 'extra_model_paths.yaml'
  if (Test-Path $yamlPath) {
    $bak = "$yamlPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $yamlPath $bak
    Write-Host "  backed up existing yaml -> $bak"
  }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('# Generated by persona-forge/scripts/discover_comfy.ps1')
  [void]$sb.AppendLine('# Maps existing model folders into this ComfyUI without copying any weights.')
  foreach ($s in $Sources) {
    $allowed = if ($s.PSObject.Properties['folders'] -and $s.folders) { $s.folders } else { $KnownModelFolders }
    $folders = @(Get-ChildItem -LiteralPath $s.path -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in $allowed } | Select-Object -ExpandProperty Name)
    if ($folders.Count -eq 0) { continue }
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("$($s.key):")
    [void]$sb.AppendLine("    base_path: $(ConvertTo-YamlPath $s.path)")
    foreach ($f in $folders) {
      # ComfyUI treats 'clip' and 'text_encoders' as one category, likewise 'unet'/'diffusion_models'.
      [void]$sb.AppendLine("    ${f}: $f")
    }
  }
  [System.IO.File]::WriteAllText($yamlPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  wrote $yamlPath" -ForegroundColor Green
  return $yamlPath
}

# ---------------------------------------------------------------- main
Write-Host '== PersonaForge ComfyUI discovery ==' -ForegroundColor Cyan
$roots = Get-SearchRoots
Write-Host "Search roots: $($roots -join ', ')"

$excludeTarget = @()
if ($ComfyRoot) { $excludeTarget = @((Resolve-Path $ComfyRoot).Path) }
$script:ExcludeRoots = @($ExcludeRoots + $excludeTarget)

$comfyDirs = @(Find-ComfyRoots $roots)
$fooocusDirs = @(Find-FooocusModelDirs $roots)

$report = [ordered]@{
  scanned_at      = (Get-Date).ToString('s')
  comfy_installs  = @($comfyDirs | ForEach-Object { Get-ComfyReport $_ })
  fooocus_models  = @($fooocusDirs | ForEach-Object { [ordered]@{ models_dir = $_; models = Get-ModelInventory $_ } })
}

foreach ($c in $report.comfy_installs) {
  Write-Host ''
  Write-Host "ComfyUI  $($c.root)  (v$($c.version))" -ForegroundColor Green
  Write-Host "  python : $($c.python.exe)  [$($c.python.version)]  torch $($c.python.torch)"
  Write-Host "  nodes  : $($c.custom_nodes -join ', ')"
  foreach ($k in $c.models.Keys) { foreach ($m in $c.models[$k]) { Write-Host ("  {0,8:N2} GB  {1}\{2}" -f $m.gb, $k, $m.file) } }
}
foreach ($f in $report.fooocus_models) {
  Write-Host ''
  Write-Host "Fooocus models  $($f.models_dir)" -ForegroundColor Green
  foreach ($k in $f.models.Keys) { foreach ($m in $f.models[$k]) { Write-Host ("  {0,8:N2} GB  {1}\{2}" -f $m.gb, $k, $m.file) } }
}
if ($report.comfy_installs.Count -eq 0) { Write-Host 'No ComfyUI installs found.' -ForegroundColor Yellow }

if ($JsonOut) {
  $dir = Split-Path $JsonOut -Parent
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $report | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 $JsonOut
  Write-Host "Report written to $JsonOut"
}

if ($WriteExtraModelPaths) {
  if (-not $ComfyRoot) { throw '-WriteExtraModelPaths requires -ComfyRoot <portable root or ComfyUI dir>' }
  $target = (Resolve-Path $ComfyRoot).Path
  if (Test-Path (Join-Path $target 'ComfyUI\main.py')) { $target = Join-Path $target 'ComfyUI' }
  if (-not (Test-Path (Join-Path $target 'main.py'))) { throw "No ComfyUI main.py under $ComfyRoot" }

  $sources = New-Object System.Collections.Generic.List[object]
  $i = 0
  foreach ($c in $report.comfy_installs) {
    $i++; $sources.Add([pscustomobject]@{ key = "shared_comfy_$i"; path = $c.models_dir; folders = $null })
  }
  $i = 0
  foreach ($f in $report.fooocus_models) {
    # Fooocus keeps Fooocus-only files in upscale_models/controlnet/vae_approx; share only portable folders.
    $i++; $sources.Add([pscustomobject]@{ key = "shared_fooocus_$i"; path = $f.models_dir; folders = @('checkpoints', 'loras', 'embeddings') })
  }
  Write-Host ''
  Write-Host "Binding $($sources.Count) model source(s) into $target" -ForegroundColor Cyan
  [void](Write-ExtraModelPaths $target $sources)
}

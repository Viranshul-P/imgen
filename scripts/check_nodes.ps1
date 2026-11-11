<#
.SYNOPSIS
  PersonaForge Phase 1 verification - confirm every ComfyUI node class_type the
  workflows need is registered on the live server (GET /object_info).

.DESCRIPTION
  Each requirement lists one or more acceptable class_type names (node packs rename
  classes between versions; the first registered alternative wins). Writes
  logs\node_check.json with the resolved names so later phases can use them, and
  reports custom-node import failures found in the ComfyUI log.

.EXAMPLE
  .\scripts\check_nodes.ps1            # uses a running server
  .\scripts\check_nodes.ps1 -Restart   # restart ComfyUI first so new nodes load
#>
[CmdletBinding()]
param([switch]$Restart)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot -Parent
$LogDir = Join-Path $RepoRoot 'logs'

$envFile = Join-Path $RepoRoot '.env.local'
$url = 'http://127.0.0.1:8188'
foreach ($line in Get-Content $envFile) { if ($line -match '^\s*COMFY_URL\s*=\s*(.+)$') { $url = $Matches[1].Trim() } }

if ($Restart) {
  & (Join-Path $PSScriptRoot 'start_comfy_api.ps1') -Restart -TimeoutSec 300
  if ($LASTEXITCODE -ne 0) { throw 'ComfyUI failed to restart' }
}

# pack, purpose, required?, acceptable class names (first match wins)
$Requirements = @(
  @{ pack = 'core'; use = 'SDXL checkpoint loader';      req = $true;  names = @('CheckpointLoaderSimple') },
  @{ pack = 'core'; use = 'LoRA (model+clip)';           req = $true;  names = @('LoraLoader') },
  @{ pack = 'core'; use = 'LoRA (model only, Flux)';     req = $true;  names = @('LoraLoaderModelOnly') },
  @{ pack = 'core'; use = 'text encode';                 req = $true;  names = @('CLIPTextEncode') },
  @{ pack = 'core'; use = 'Flux guidance';               req = $true;  names = @('FluxGuidance') },
  @{ pack = 'core'; use = 'basic guider';                req = $true;  names = @('BasicGuider') },
  @{ pack = 'core'; use = 'random noise';                req = $true;  names = @('RandomNoise') },
  @{ pack = 'core'; use = 'sampler select';              req = $true;  names = @('KSamplerSelect') },
  @{ pack = 'core'; use = 'basic scheduler';             req = $true;  names = @('BasicScheduler') },
  @{ pack = 'core'; use = 'SD3/Flux empty latent';       req = $true;  names = @('EmptySD3LatentImage') },
  @{ pack = 'core'; use = 'SDXL empty latent';           req = $true;  names = @('EmptyLatentImage') },
  @{ pack = 'core'; use = 'custom sampler';              req = $true;  names = @('SamplerCustomAdvanced') },
  @{ pack = 'core'; use = 'KSampler';                    req = $true;  names = @('KSampler') },
  @{ pack = 'core'; use = 'VAE loader';                  req = $true;  names = @('VAELoader') },
  @{ pack = 'core'; use = 'VAE decode';                  req = $true;  names = @('VAEDecode') },
  @{ pack = 'core'; use = 'VAE encode';                  req = $true;  names = @('VAEEncode') },
  @{ pack = 'core'; use = 'load image';                  req = $true;  names = @('LoadImage') },
  @{ pack = 'core'; use = 'load mask image';             req = $true;  names = @('LoadImageMask') },
  @{ pack = 'core'; use = 'grow mask';                   req = $true;  names = @('GrowMask') },
  @{ pack = 'core'; use = 'save image';                  req = $true;  names = @('SaveImage') },
  @{ pack = 'core'; use = 'inpaint conditioning';        req = $true;  names = @('InpaintModelConditioning') },
  @{ pack = 'core'; use = 'differential diffusion';      req = $true;  names = @('DifferentialDiffusion') },
  @{ pack = 'core'; use = 'masked composite';            req = $true;  names = @('ImageCompositeMasked') },
  @{ pack = 'core'; use = 'ControlNet loader';           req = $true;  names = @('ControlNetLoader') },
  @{ pack = 'core'; use = 'ControlNet apply';            req = $true;  names = @('ControlNetApplyAdvanced') },
  @{ pack = 'core'; use = 'CLIP vision loader';          req = $true;  names = @('CLIPVisionLoader') },
  @{ pack = 'core'; use = 'upscale model loader';        req = $true;  names = @('UpscaleModelLoader') },
  @{ pack = 'core'; use = 'upscale with model';          req = $true;  names = @('ImageUpscaleWithModel') },
  @{ pack = 'core'; use = 'image scale';                 req = $true;  names = @('ImageScale') },
  @{ pack = 'ComfyUI-GGUF'; use = 'Flux GGUF unet';      req = $true;  names = @('UnetLoaderGGUF') },
  @{ pack = 'ComfyUI-GGUF'; use = 'T5 GGUF + clip_l';    req = $true;  names = @('DualCLIPLoaderGGUF') },
  @{ pack = 'IPAdapter_plus'; use = 'FaceID apply';      req = $true;  names = @('IPAdapterFaceID') },
  @{ pack = 'IPAdapter_plus'; use = 'FaceID unified loader'; req = $true; names = @('IPAdapterUnifiedLoaderFaceID') },
  @{ pack = 'IPAdapter_plus'; use = 'IPAdapter model loader'; req = $true; names = @('IPAdapterModelLoader') },
  @{ pack = 'IPAdapter_plus'; use = 'InsightFace loader'; req = $true; names = @('IPAdapterInsightFaceLoader') },
  @{ pack = 'Impact-Pack'; use = 'FaceDetailer';         req = $true;  names = @('FaceDetailer') },
  @{ pack = 'Impact-Pack'; use = 'SAM loader';           req = $true;  names = @('SAMLoader') },
  @{ pack = 'Impact-Pack'; use = 'gaussian blur mask';   req = $true;  names = @('ImpactGaussianBlurMask') },
  @{ pack = 'Impact-Subpack'; use = 'YOLO detector';     req = $true;  names = @('UltralyticsDetectorProvider') },
  @{ pack = 'controlnet_aux'; use = 'OpenPose (DWPose)'; req = $true;  names = @('DWPreprocessor') },
  @{ pack = 'controlnet_aux'; use = 'depth map';         req = $true;  names = @('DepthAnythingV2Preprocessor', 'DepthAnythingPreprocessor', 'Zoe-DepthMapPreprocessor') },
  @{ pack = 'Inpaint-CropAndStitch'; use = 'inpaint crop';   req = $true; names = @('InpaintCropImproved', 'InpaintCrop') },
  @{ pack = 'Inpaint-CropAndStitch'; use = 'inpaint stitch'; req = $true; names = @('InpaintStitchImproved', 'InpaintStitch') },
  @{ pack = 'ReActor'; use = 'face swap (optional)';     req = $false; names = @('ReActorFaceSwap') }
)

# The HTTP server answers /system_stats before custom nodes finish importing; first start can
# take minutes (e.g. ReActor downloads face-restore weights). Poll /object_info patiently.
Write-Host "Fetching $url/object_info (waits for custom nodes to finish loading) ..."
$info = $null
$deadline = (Get-Date).AddMinutes(15)
while (-not $info) {
  try { $info = Invoke-RestMethod -Uri "$url/object_info" -TimeoutSec 60 }
  catch {
    if ((Get-Date) -gt $deadline) { throw "GET /object_info did not answer within 15 minutes: $($_.Exception.Message)" }
    Write-Host '  still loading...'; Start-Sleep -Seconds 10
  }
}
$registered = @{}
foreach ($p in $info.PSObject.Properties) { $registered[$p.Name] = $true }
Write-Host "Registered node classes: $($registered.Count)"

$resolved = [ordered]@{}
$missingRequired = 0
foreach ($r in $Requirements) {
  $hit = $r.names | Where-Object { $registered.ContainsKey($_) } | Select-Object -First 1
  if ($hit) {
    $resolved[$r.names[0]] = $hit
    Write-Host ("  OK    {0,-28} {1,-22} {2}" -f $hit, $r.pack, $r.use) -ForegroundColor Green
  }
  elseif ($r.req) {
    $missingRequired++
    Write-Host ("  MISS  {0,-28} {1,-22} {2}" -f ($r.names -join ' | '), $r.pack, $r.use) -ForegroundColor Red
  }
  else {
    Write-Host ("  skip  {0,-28} {1,-22} {2}" -f ($r.names -join ' | '), $r.pack, $r.use) -ForegroundColor Yellow
  }
}

$errLog = Join-Path $LogDir 'comfy.err.log'
$importFailures = @()
if (Test-Path $errLog) {
  $importFailures = @(Select-String -Path $errLog -Pattern '\(IMPORT FAILED\)' | ForEach-Object { $_.Line.Trim() })
  if ($importFailures.Count -gt 0) {
    Write-Host "`nCustom node import failures reported by ComfyUI:" -ForegroundColor Yellow
    $importFailures | ForEach-Object { Write-Host "  $_" }
  }
}

$report = [ordered]@{
  checked_at       = (Get-Date).ToString('s')
  server           = $url
  registered_count = $registered.Count
  resolved         = $resolved
  missing_required = $missingRequired
  import_failures  = $importFailures
}
$report | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 (Join-Path $LogDir 'node_check.json')

if ($missingRequired -gt 0) { Write-Host "`n$missingRequired required node class(es) missing." -ForegroundColor Red; exit 1 }
Write-Host "`nAll required node classes registered." -ForegroundColor Green

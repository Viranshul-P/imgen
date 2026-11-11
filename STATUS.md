# STATUS — PersonaForge build log

## Phase 0 — Discovery, Safe Binding & Environment Verification ✅ COMPLETE (2026-11-11)
**Completed**
- Hardware and software inventory → `docs/SYSTEM.md`
- `scripts/discover_comfy.ps1`: a read-only scanner (installs, Python and torch, custom nodes, model inventory, JSON report). With `-WriteExtraModelPaths` it binds the discovered model folders into a target ComfyUI. It never changes ACLs; unreadable profiles are skipped and reported.
- Found an existing ComfyUI v0.3.66 at `C:\Users\Public\ComfyUI_windows_portable` (copied in from another account) and Fooocus models (Juggernaut XL v8).
- **Option 1 chosen by user:** a clean ComfyUI **v0.45.0** portable (`nvidia_cu126` build, matching driver 560.94 / CUDA 12.6) at `C:\Users\viranshul\imgen\ComfyUI_windows_portable`. The archive was SHA-256 verified against the GitHub release digest.
- `extra_model_paths.yaml` written. It shares all Public-ComfyUI model folders, plus Fooocus `checkpoints`, `loras` and `embeddings`. No weights were copied, and the source installs are untouched.
- `.env.local` written (gitignored); `.env.example` committed.
- `scripts/start_comfy_api.ps1`: foreground / `-Background` / `-Status` / `-Stop` / `-Restart` / `-LowVram`; waits on `/system_stats`.
- Baseline → `docs/BENCHMARKS.md`

**Verified checks**
- `GET http://127.0.0.1:8188/system_stats` → 200 (ComfyUI 0.45.0, torch 2.14.1+cu126, RTX 4060 Laptop, 6.93 GB VRAM free)
- `GET /models/checkpoints` lists `juggernautXL_v8Rundiffusion` and `realisticVisionV60B1`; `/models/text_encoders` lists `clip_l` and `t5xxl_fp8`; `/models/vae` lists `ae`; `sams` and `insightface` models are visible

**Deviations from spec**
- `--normalvram` was removed in ComfyUI ≥ 0.4 (argparse rejects it), and normal VRAM mode is now the default. Default flags are now `--reserve-vram 0.8 --disable-auto-launch`, and the launcher strips `--normalvram` if it appears in `.env.local`.

**Pending / notes**
- ~~The Flux `.gguf` is not listed until ComfyUI-GGUF is installed~~ → resolved in Phase 1.
- System RAM is very low (0.75 GB free). Free it up before Engine A runs (see BENCHMARKS.md).

## Phase 1 — Custom Nodes & Windows Dependency Resolution ✅ COMPLETE (2026-11-11)
**Completed**
- `scripts/setup_comfy_nodes.ps1`: an idempotent installer.
  - Backs up `pip freeze` and the custom_nodes list first.
  - Shallow-clones the missing packs and installs each pack's `requirements.txt` with the embedded Python.
  - Ends with `pip check` and an import smoke test.
- Packs installed in `ComfyUI\custom_nodes` (all repos verified live via the GitHub API):
  - city96/ComfyUI-GGUF
  - cubiq/ComfyUI_IPAdapter_plus
  - ltdrdata/ComfyUI-Impact-Pack
  - ltdrdata/ComfyUI-Impact-Subpack
  - Fannovel16/comfyui_controlnet_aux
  - lquesada/ComfyUI-Inpaint-CropAndStitch
  - Gourieff/ComfyUI-ReActor
- ComfyUI-Manager: `ltdrdata/ComfyUI-Manager` has moved to `Comfy-Org/ComfyUI-Manager`. In ComfyUI ≥ 0.4 it ships as the pip package `comfyui_manager==4.2.2` (from `manager_requirements.txt`) and is enabled with `--enable-manager`. It is installed but not enabled by default, which keeps headless startup fast.
- `scripts/check_nodes.ps1`: verifies the live `/object_info`, resolves renamed classes, and writes `logs/node_check.json`.

**Windows dependency gotchas resolved**
1. **insightface vs numpy 2:** the community prebuilt cp312 wheel is compiled against numpy 1.x and fails on ComfyUI's numpy 2.5.4 ("numpy.dtype size changed"). The embedded Python has no C headers, so the installer builds the wheel with the host CPython 3.12 (same ABI, isolated `pip wheel` build, MSVC Build Tools 2022) and installs that. The prebuilt wheel is used only as a fallback.
2. **albumentations namespace clash:** controlnet_aux needs `albumentationsx` (albucore 0.3.5), while ReActor's `albumentations>=1.4.16` pulls the legacy package (albucore 0.0.24). That overwrites the same import namespace and breaks insightface. The installer keeps only albumentationsx, which provides `import albumentations`.
3. **PowerShell 5.1 native stderr:** a native command writing to stderr became a terminating error under `ErrorActionPreference=Stop`. Native calls are now wrapped (`Invoke-Native`) and judged by exit code.
4. onnxruntime-gpu stays the active onnxruntime. Its providers are TensorRT, CUDA and CPU.

**Verified checks**
- Import smoke test: torch 2.14.1+cu126, insightface.app, onnxruntime 1.31.1 (CUDA), gguf, ultralytics 8.4.210, cv2 5.0.0, Pillow 13.0, numpy 2.5.4, huggingface_hub 2.3.0, segment_anything all OK
- `/object_info`: 1385 classes registered. **All 43 required classes present**, plus optional ReActorFaceSwap. No `IMPORT FAILED` lines.
  - Resolved renames: depth → `DepthAnythingV2Preprocessor`; crop/stitch → `InpaintCropImproved` / `InpaintStitchImproved`
- `UnetLoaderGGUF` lists `flux1-dev-Q4_K_S.gguf` (shared from the Public install)

**Notes**
- Remaining `pip check` lines are cosmetic. They are web-UI template media packages (not shipped with the portable build) and insightface's distribution-name check for `albumentations` (the import is provided by albumentationsx).
- On first start ReActor downloads face-restore weights (~1.25 GB) into the local `models\facerestore_models` because it ignores `extra_model_paths.yaml`. The first cold start takes a few minutes.

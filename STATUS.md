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

## Phase 2 — Free Resumable Model Downloader ✅ COMPLETE (2026-11-11)
**Completed**
- `scripts/download_models.py` (stdlib only), with `--check-only`, `--download-core` and `--custom-manifest custom_models.json`.
  - Inventories every folder ComfyUI searches: local `models/` plus each `extra_model_paths.yaml` base path, with the unet/diffusion_models and clip/text_encoders aliases. Files already present are skipped.
  - Checks free disk space and prints the total download size before starting.
  - Resumes interrupted downloads (`.part` files + HTTP Range), retries with backoff (12 attempts, up to 2 min apart), and verifies SHA-256 against the Hugging Face LFS object id.
  - `custom_models.json` holds `{ name, url, target_dir }` entries (https only, plain filenames, whitelisted target dirs). Optional `HF_TOKEN` / `CIVITAI_TOKEN` are sent only to their own hosts.
- Reused from shared folders (not downloaded): `flux1-dev-Q4_K_S.gguf`, `clip_l.safetensors`, `ae.safetensors`, `juggernautXL_v8Rundiffusion.safetensors`.
- Downloaded and SHA-256 verified (14 files, 20.5 GiB):
  - T5 Q5_K_M GGUF
  - sdxl_vae (fp16-fix)
  - RealVisXL V5.0 fp16
  - ControlNet OpenPose (twins) and Depth SDXL
  - IP-Adapter FaceID Plus v2 + its LoRA
  - CLIP-ViT-H-14 (safetensors)
  - face_yolov8m and hand_yolov8n
  - XLabs Flux Realism LoRA
  - Amateur Photography Flux LoRA
  - 4x-UltraSharp and RealESRGAN_x2

**Verified checks**
- A second `--check-only` reports `Total to download: 0 B in 0 file(s)`.
- A Wi-Fi/DNS outage mid-run (`getaddrinfo failed`) failed 3 files. Re-running resumed them from their `.part` files, and all 3 verified OK.

**Deviations from spec (URLs verified via the HF API, rule 5)**
- `black-forest-labs/FLUX.1-schnell/ae.safetensors` now returns 401 (gated). The ungated mirror `ffxvs/vae-flux` hosts the byte-identical file (same LFS sha256 `afc8e282…`) and is used as the fallback.
- The xinsir OpenPose file is now `diffusion_pytorch_model_twins.safetensors` (underscore instead of the spec's dot).
- CLIP-ViT-H: the repo publishes a real `open_clip_model.safetensors`. That file is used instead of renaming the `.bin` pickle to `.safetensors`, which would not load.
- Amateur Photography LoRA: `ujouy/Amateur_Photography_FluxDev` → `amateurphoto-v6-forcu.safetensors`, saved as `flux_amateur_photography.safetensors`. The `isaiahbjork` mirror is kept as a fallback.

## Phase 3 — Live-Schema Workflow Templates & Smoke Validator ✅ COMPLETE (2026-11-11)
**Completed**
- Six API-format templates in `workflows/`, built only from the live `GET /object_info` schema (every class_type and input name dumped and checked first):
  - `engine_a_flux_lifestyle`: UnetLoaderGGUF → LoRA chain → DualCLIPLoaderGGUF(flux) → FluxGuidance 2.6 → BasicGuider/RandomNoise/KSamplerSelect(euler)/BasicScheduler(beta, 24) → EmptySD3LatentImage 896×1152 → SamplerCustomAdvanced → VAEDecode → optional FaceDetailer (0.28) → optional upscale/downscale → SaveImage
  - `engine_b_sdxl_editorial`: checkpoint → LoRA chain → pos/neg → optional ControlNet (DWPose or Depth Anything V2 variant, strength 0.70, end 0.82) → optional IP-Adapter FaceID Plus v2 → KSampler (28, cfg 5, dpmpp_2m_sde/karras) → FaceDetailer (0.30) → optional hand detailer (0.35) → optional upscale → SaveImage
  - `engine_c_wardrobe_inpaint`: LoadImage + LoadImageMask → GrowMask 12 → ImpactGaussianBlurMask → InpaintCropImproved → InpaintModelConditioning(noise_mask) → DifferentialDiffusion → KSampler (denoise 0.75) → InpaintStitchImproved → ImageCompositeMasked pixel lock → SaveImage
  - `genesis_master_face_candidates`, `genesis_dataset` (IP-Adapter FaceID Plus v2 from master_face), `cross_engine_face_lock` (SDXL FaceDetailer 0.35)
- `src/lib/workflowInjector.ts`: variants, removal of disabled optional blocks with declared bypass rewiring, native `LoraLoader` / `LoraLoaderModelOnly` chains (any count, weights −1..2), typed and range-checked placeholders, forced `batch_size = 1`
- `src/lib/comfySchema.ts`: prompt validation against `/object_info` (class registered, required inputs, enums, numeric ranges, link output types)
- `scripts/validate_workflows.ts`: static matrix plus 256×256 / 2-step smoke runs, with `POST /free` between engine switches

**Verified checks**
- Static: **15/15** feature × variant combinations valid against the live schema
- Smoke (2 steps, 256×256, with a LoRA in each chain): face_lock 4.2 s ✅ · *flush SDXL→Flux* · engine_a 25.8 s ✅ · *flush Flux→SDXL* · engine_b 6.8 s ✅ · engine_c 3.8 s ✅ · master_face_candidates 0.8 s ✅
- **Engine C pixel lock measured:** 37,376 px outside mask + 32 px feather margin, **0 changed (max diff 0)**. The masked region was repainted (mean diff 114).
- `genesis_dataset` was validated statically only: IP-Adapter FaceID raises on synthetic input without a face. It gets an end-to-end run in Phase 7 with a real master_face.png.

**Notes**
- ReActor is installed but deliberately not wired into any graph (`enableReactorSwap: true` is rejected). Identity comes from the Character LoRA and IP-Adapter FaceID.

## Phase 4 — Next.js Studio & Background Queue Worker ✅ COMPLETE (2026-11-11)
**Completed**
- Stack: Next.js 16.4.6 (App Router, Turbopack), React 19.3, TypeScript 5.9 strict, Tailwind v4, shadcn/ui-style primitives (cva + tailwind-merge, written in-repo the way the shadcn CLI copies them), lucide-react, Prisma 6.19.3 + SQLite, `concurrently` (`npm run dev` = web + worker)
- `prisma/schema.prisma`: Character, Campaign, Job (`queued|running|done|failed|cancelled`), Asset, Arc, WorkerState
- `worker/queueWorker.ts`:
  - claims jobs atomically (priority, then FIFO) and uploads inputs
  - injects the workflow and validates it against the live schema before queueing
  - **VRAM guard:** `POST /free` + 1.5 s pause on any engine or model switch
  - live WebSocket progress written to the DB, peak-VRAM sampling, cancel → `/interrupt`
  - saves outputs to `data/raw/`, auto-queues the cross-engine face lock, re-queues stuck jobs after a restart
- API routes: `comfy/status|models|free`, `jobs` (+ cancel/retry), `jobs/stream` (SSE), `characters`, `campaigns` (+ arcs: "Generate Full Progression Arc"), `datasets`, `uploads`, `assets`, `files/[...path]` (traversal-safe)
- Lib: `promptBuilder` (Flux prose / SDXL tags, studio-sheen detector), `sceneKits` (6 amateur phone kits), `modelDiscovery` (all dropdowns from `/object_info`), `jobPlanner` (N candidates → N batch_size=1 jobs, 35-frame dataset variations, face-lock follow-ups)
- UI: SystemStatusHeader, ShootGenerator (+ LoraStack, AssetPicker), ArcProgressionBuilder, WardrobeMaskCanvas, CharacterDNAEditor, DatasetCurator, ContentVault (+ before/after slider, quality checklist), JobQueue

**Verified checks**
- `tsc --noEmit` (strict + noUncheckedIndexedAccess): 0 errors · `npm run lint`: 0 errors / 0 warnings · `npm run build`: success, 0 warnings
- Live end-to-end via the running studio:
  - character created → Engine B shot queued over the API → worker ran it → SSE streamed progress ("FaceDetailer 16/20" …) → `data/raw/<job>_0.png` saved and registered as an Asset
  - **33.1 s, peak 7,041 MB VRAM** at 832×1216 + FaceDetailer
- `/api/files` serves outputs (200) and rejects traversal (403). `enableReactorSwap: true` is rejected with 400.

**Deferred / notes**
- The optional SAM auto-segment helper (top/bottom/outfit/body) is not included: it needs a clothing-segmentation model that is not in the Phase 2 model set. Masks are painted manually.
- Phone Look Finisher toggle and Vault/dataset export buttons are wired in Phases 5–6.
- `npm audit` reports advisories only in dev tooling (Prisma CLI config loader, ESLint's typescript-estree minimatch). Not shipped at runtime; `--force` would change Prisma's major version.

---
## ▶ RESUME HERE (paused 2026-11-11 after Phase 4)
**Next:** Phase 5 → 6 → 7 (spec sections 7 and 8). Nothing for Phase 5 has been written yet.
1. **Phase 5:** `scripts/realism_finish.py`, the 6-stage smartphone ISP finisher (Pillow + numpy + opencv from ComfyUI's embedded Python).
   - Stages: tone curve + WB + highlight bloom → 0.5px softening + 6–10% vignette + 0.5px radial CA → unsharp mask (r 1.1, amt 0.35, thr 2) → shadow-weighted luma noise 1.8–3.0% + 0.4% low-freq chroma → crop to 1080×1350 / 1080×1920 → JPEG q92 4:2:0.
   - Presets: `iphone_indoor_warm`, `iphone_mirror_selfie`, `iphone_flash_night`, `iphone_dim_bedroom_high_iso`, `iphone_daylight`, `raw_unfiltered`. Master intensity 0–1 plus per-stage weights.
   - Then: a `src/lib/finisher.ts` spawn helper, a worker hook (when `options.enablePhoneFinisher` is set → `data/finished/*.jpg` Asset with `sourceId` = raw), `POST /api/vault/export` (finish + zip bundle), and a Vault export button. `docs/REALISM_GUIDE.md`.
2. **Phase 6:** `docs/TRAINING.md` (Recipe A SDXL LoRA on 8 GB via OneTrainer/kohya, Recipe B Flux LoRA NF4/FluxGym split mode, JSON config presets) and `scripts/prepare_dataset.py` (`<repeats>_<trigger> woman/` + `.txt` captions from approved dataset frames). Add a dataset export action to `/api/datasets` and a button in DatasetCurator.
3. **Phase 7:** `npm run build` + `npm run lint`, `npm run validate:workflows`, one full-size render each on Engine A, B and C through the worker (log speed + peak VRAM in `docs/BENCHMARKS.md`, confirm the /free flush between A and B), and the finisher on the outputs with `iphone_indoor_warm` + `iphone_dim_bedroom_high_iso`; check the before/after slider in the Vault. Also run `genesis_dataset` end to end with a real master_face. **Close Chrome and other heavy apps before Engine A** (Flux needs ~10 GB free RAM).

**How to start everything again**
- ComfyUI: `powershell -ExecutionPolicy Bypass -File scripts\start_comfy_api.ps1 -Background` (check with `-Status`)
- Studio + worker: `npm run dev` → http://localhost:3000
- Test data in the DB: character "Test Vira" (`pf_test_vira`) and one Engine B render in `data/raw/`.

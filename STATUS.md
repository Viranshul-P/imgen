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

## Phase 5 — Smartphone ISP Visual Finisher ✅ COMPLETE (2026-11-11)
**Completed**
- `scripts/realism_finish.py` (Pillow + numpy + OpenCV, from ComfyUI's embedded Python), with all 6 stages:
  1. tone: luminance-preserving WB, S-curve, lifted blacks, highlight shoulder, bloom
  2. lens: 0.5px softening, 6–10% vignette, 0.5px radial CA
  3. sharpen: luma unsharp mask r1.1 / 0.35 / thr 2
  4. noise: shadow-weighted luma grain 1.8–3.0% + 0.4% low-frequency chroma
  5. crop to 1080×1350 / 1080×1920 + JPEG q92 4:2:0 (JFIF only, no EXIF spoofing)
  6. presets: all six from the spec
- Master intensity 0–1 × per-stage weights (`--weights tone=,lens=,sharpen=,noise=`); `--size auto|4:5|9:16|original`, `--bundle zip`, `--list-presets`. The noise seed is deterministic (from the image bytes).
- `src/lib/finisher.ts`: spawns `COMFY_PYTHON -I`, validates settings, and creates or refreshes `finished` Assets (`sourceId` = raw)
- Worker hook: when `options.enablePhoneFinisher` is set → `data/finished/*.jpg`, written right after the raw is saved. It never fails the job. Dataset frames are skipped; Flux renders that will be face-locked are skipped, and the locked result is finished instead.
- `POST /api/vault/export` (finish + zip in `data/exports/` with `finish_settings.json`)
- Vault: Phone Look panel (preset, size, master intensity, per-stage sliders), "Apply <preset>" on the inspected image, "Finish & export N as zip" + download link, a version picker when several presets exist, cache-busted slider URLs
- Shoot tab: Phone Look intensity slider
- `docs/REALISM_GUIDE.md`

**Verified checks**
- All 6 presets on the real Engine B render: ~0.6 s per image at 1080×1350
  - measured shadow grain 1.77% (daylight) → 2.99% (dim bedroom); highlights ~⅓ of that
  - corner luma 0.86–0.96 of raw
  - JPEG sampling 4:2:0, no EXIF; raw_unfiltered = crop/encode only
- Live API: export with zip → 200, zip holds JPEG + settings, `/api/files/exports/*.zip` serves `application/zip`
  - second preset export without bundle → 200; the raw asset now lists 2 derived finished versions, newest first
  - bad id / intensity 3 / unknown stage → 400 with a clear message
- `tsc --noEmit` 0 errors · `npm run lint` 0 errors / 0 warnings

**Deviations / notes**
- Order: the stage-5 crop/resize runs *before* stages 1–4 (JPEG stays last), so the pixel radii and grain size are exact at the delivered 1080-wide resolution. Upscaling after the grain would smear it.
- **The embedded Python must run with `-I`.** Without it, an older numpy 2.1.1 / Pillow 12.3 in the Windows user site-packages shadows the embedded numpy 2.5.4 / Pillow 13.0.
- The worker hook is exercised on full-size renders in Phase 7 (ComfyUI was not running during Phase 5).

## Phase 6 — Free Local 8 GB LoRA Training ✅ COMPLETE (2026-11-11)
**Completed**
- `scripts/prepare_dataset.py` (stdlib + Pillow, embedded Python `-I`): approved frames (from a studio manifest or straight from `prisma/dev.db`) produce:
  - `img/<repeats>_<trigger> woman/NNNN.png + .txt`
  - kohya `dataset_sdxl.toml` / `dataset_flux.toml` (explicit `num_repeats`)
  - rendered `train_sdxl.ps1` / `train_flux.ps1` (+ `.json`)
  - OneTrainer `sdxl_lora.json` / `flux_lora_nf4.json` / `concepts.json` (config v11 / concept v2)
  - `README.txt`, `export.json`, optional zip
  - Captions: `<trigger> woman, <framing, angle, light, expression>`; fixed identity traits are left out on purpose, and Curator caption overrides are respected. Duplicates and missing files are skipped with warnings.
  - Model paths are resolved through `extra_model_paths.yaml` (character checkpoint → RealVisXL → Juggernaut; clip_l, t5xxl_fp8, ae). Trained LoRAs save straight into `ComfyUI\models\loras`.
  - Refuses to overwrite a folder that isn't a previous export.
- `training/presets/`: `onetrainer_sdxl_lora_8gb.json`, `onetrainer_flux_lora_8gb_nf4.json`, `kohya_sdxl_lora_8gb.json`, `kohya_flux_lora_8gb.json`
- `POST /api/datasets {action:"export", characterId, repeats}` (`src/lib/datasetExport.ts`) plus Dataset Curator controls: a repeats slider, an "Export N approved frames for training" button, a zip download and warnings
- `src/lib/python.ts`: shared isolated-Python runner (the finisher now uses it too); script input errors map to HTTP 400
- `docs/TRAINING.md`:
  - Recipe A, SDXL: Adafactor, grad checkpointing, bf16, cached latents + TE outputs, dim/alpha 16, 1024, bs 1, 1400 steps
  - Recipe B, Flux: OneTrainer NF4 + offload / kohya fp8 + blocks_to_swap 28 / FluxGym 12G, rank 16, adafactor, 512 buckets
  - install steps, the Cross-Engine Face Lock explanation, and the sources checked

**Verified checks**
- Config formats checked against current upstream source (2026-11-11): OneTrainer `TrainConfig.py` v11, `ConceptConfig.py`, enum files and official presets; sd-scripts SDXL/FLUX/config docs; FluxGym `app.py`
- Manifest export of 7 test images (+1 missing):
  - 7 written, captions correct, override kept, missing file warned
  - only FLUX_DEV flagged unresolved (expected: full flux1-dev isn't downloaded)
  - both `.toml` files parse (tomllib), all OneTrainer JSON parses, both `.ps1` launchers parse with 0 PowerShell errors
- DB mode: 0 approved → clean exit 2; unknown trigger → exit 2
- Live API with a temporary approved frame: export 201, zip served (200, application/zip); repeats 0 / unknown character → 400; Vault finisher still OK after the refactor. Temporary rows and files removed afterwards.
- `tsc` 0 errors · `npm run lint` 0 · `npm run build` success, 0 warnings · `py_compile` OK

**Deviations / notes**
- sd-scripts marks `--split_mode` as deprecated in favour of `--blocks_to_swap`; its 8 GB row is `--blocks_to_swap 28` + fp8, which the kohya Flux preset uses. FluxGym's lowest option is 12G (its 8G branch is commented out); TRAINING.md says so.
- With `--dataset_config`, kohya ignores repeats in folder names, so `num_repeats` is written into the TOML (the folder still follows the convention for GUI users).
- Prodigy: OneTrainer `PRODIGY` is documented in TRAINING.md. The sd-scripts Prodigy optimizer string is not in its docs, so the kohya presets ship Adafactor only.
- OneTrainer `prompt_source` is left at its default `"sample"` (per-image `.txt`). The other accepted values could not be read upstream.
- Recipe B needs the full FLUX.1-dev weights (gated, free licence, ~24 GB). They are not downloaded automatically.
- No actual LoRA training run yet: it needs a real approved genesis dataset (Phase 7) and a trainer installed outside ComfyUI.

## Phase 7 — End-to-End Verification ✅ COMPLETE (2026-11-11)
**Verified checks**
- `npm run build` ✅ (0 warnings) · `npm run lint` ✅ 0/0 · `tsc --noEmit` ✅ 0 errors
- `npm run validate:workflows` against live ComfyUI: **15/15 static, 5/5 smoke** (genesis_dataset skipped by design: it was run for real below). Re-run after the Engine C fix: still 15/15 and 5/5.
- Full-size renders through the queue worker, Phone Look Finisher on (details in `docs/BENCHMARKS.md`):
  - **Engine B** 33.2 s
  - **Engine C** 22.6 s
  - **Engine A** 165.1 s (with Chrome open, ~5 GB RAM free)
  - all under 8 GB, peak 6.7–7.8 GB device-wide
- **VRAM flush:** the worker logged `SDXL -> FLUX_GGUF` before Engine A and `FLUX_GGUF -> SDXL` right after it (flushCount 2). Same-engine jobs reuse the resident model.
- **Finisher:** the worker auto-finished every render (indoor_warm / mirror_selfie). `iphone_indoor_warm` and `iphone_dim_bedroom_high_iso` were also run over the A/B/C outputs via `/api/vault/export` (3 images each + zip, ~2.3 s).
- **Engine C pixel lock at full size:** 0 of 633,286 pixels outside the mask (+ feather margin) changed.
- **Genesis end to end:**
  - 4 master-face candidates (1024², ~31 s each) → one set as master_face
  - 6 IP-Adapter FaceID dataset frames (~43.5 s each after a 71.5 s first load): identity consistent across frames
  - all approved → `/api/datasets` export → 6 images + correct captions + configs + zip

**Fixed during Phase 7**
- **Engine C painted a second face into the clothing area at denoise 0.9.** Causes:
  - the prompt carried the character's identity descriptors into a torso-only crop
  - the crop context (1.2×) hid the real head
  - Fix: Engine C prompts now describe only the garment, plus a wardrobe negative (`face, head, eyes, portrait, extra person…`), and `context_from_mask_extend_factor` went 1.2 → 1.6. The re-test gave a clean black turtleneck on the same person, still with 0 changed outside pixels.
  - Also observed: at the default 0.75 denoise the garment changes but keeps the original colour. For colour changes use 0.85–0.92 (the slider allows up to 0.92).

**Observations (not bugs)**
- IP-Adapter FaceID pulls faces toward frontal, so "profile" frames often come out near-frontal, and it can exaggerate freckles or redness. TRAINING.md now tells you to fix angle words in captions or reject such frames before export.
- The first 7 dataset frames share one lighting setup by design (lighting rotates every 7 frames). A full 35-frame run covers all 5.

**Pending**
- Before/after slider in the Vault: the Claude-in-Chrome extension was not connected, so this needs a manual check in the browser (the data side is verified: raw assets list their finished versions, files are served).

---
## ▶ STATUS: all phases (0–7) complete — 2026-11-11
**Build is done.** What remains is using the studio (and one manual check):
1. Manual: open http://localhost:3000 → Vault → click a render with the "phone" badge → drag the Raw/Phone Look slider.
2. `git push` the local commits (the user pushes).
3. Real character workflow:
   - create the character
   - Character tab → generate master-face candidates → pick one
   - generate the 35-frame dataset → approve and fix captions → Export
   - train Recipe A in OneTrainer/kohya (`docs/TRAINING.md`)
   - set the LoRA on the character → shoot
4. Known gaps carried from Phase 4: no SAM auto clothing segmentation (needs a clothing-seg model not in the spec's model set). Masks are painted by hand.

**How to start everything again**
- ComfyUI: `powershell -ExecutionPolicy Bypass -File scripts\start_comfy_api.ps1 -Background` (check with `-Status`, stop with `-Stop`)
- Studio + worker: `npm run dev` → http://localhost:3000. Stop the dev server before `npm run build`: it locks Prisma's engine DLL.
- Close heavy apps before Flux (Engine A) runs. ~10 GB free RAM gives the fastest loads.
- Test data in the DB: character "Test Vira" (`pf_test_vira`) with a master face, 6 approved dataset frames, Phase 7 renders + finished versions.

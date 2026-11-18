# PersonaForge

A local studio for generating candid, phone-style lifestyle photos of a single **fictional** AI character. It runs on a consumer RTX 4060 (8 GB VRAM) using free, open-source weights, and can optionally borrow a rented cloud GPU for heavier work.

PersonaForge is built for original, invented characters. The character's face is always a generated asset, never a real person's photo, and a content-safety guard blocks sexual prompts that involve minors.

## What it does

| Tab | Purpose |
|---|---|
| **Prompt** | Send a prompt as written to Flux or SDXL. No rewriting. |
| **Shoot** | Plan and render a themed photo set for the character: location, outfit, mood, lighting and phone style. |
| **Progression Arc** | Build a sequence of frames that follows the character through a story or a day. |
| **Character & Dataset** | Edit the character's DNA, pick a master face, curate a training dataset and export it for LoRA training. |
| **Vault** | Browse, filter, finish and export everything that has been generated. |

A header bar shows ComfyUI status and switches between the **Local** GPU and a **Remote** cloud GPU. A job queue shows progress live.

## Engines

- **Engine A**: Flux.1-dev (GGUF Q4_K_S locally, native FP16 on a cloud GPU) with a T5 text encoder, for natural skin and indoor light.
- **Engine B**: SDXL checkpoints with LoRA chaining, OpenPose/Depth ControlNet and IP-Adapter FaceID.
- **Engine C**: SDXL masked inpainting (crop-and-stitch) for pixel-locked, multi-stage wardrobe sets, with SegFormer auto-masking.

Optional passes, each switchable per job:

- **Detail Daemon** sampler wrapper for finer detail
- **Structure Clone**: reuse the layout of a reference photo while the character and style change
- **ReActor master-face swap**: the character's own generated face only, blended 60% over the original, then FaceDetailer
- **Hi-res second pass**
- **Smartphone ISP finisher** (`scripts/realism_finish.py`): tone curve, lens softness, vignette, chromatic aberration, sensor noise and JPEG recompression

## Architecture

```
Next.js studio (src/)  ──►  Prisma + SQLite job queue  ──►  queue worker (worker/)
                                                                  │  one job at a time,
                                                                  │  flushes VRAM between engines
                                                                  ▼
                                                  ComfyUI (headless, HTTP/WebSocket API)
```

- **Studio**: Next.js (App Router), React, TypeScript, Tailwind, Prisma with SQLite
- **Worker**: serializes jobs, follows the Local/Remote switch, saves outputs to `data/`
- **Workflows**: ComfyUI API-format templates in `workflows/`, built from the live `/object_info` schema and checked by `npm run validate:workflows`

## Layout

```
persona-forge/
  docs/        system inventory, benchmarks, training, realism and cloud guides
  scripts/     ComfyUI launch and setup, model downloader, dataset prep, validators, finisher, cloud setup
  workflows/   ComfyUI API workflow templates
  worker/      background job runner
  src/         Next.js app (API routes, components, lib)
  prisma/      SQLite schema
  training/    LoRA training presets and the cloud training script template
```

ComfyUI itself lives outside the repo, in a sibling `ComfyUI_windows_portable` folder. Model weights are shared from existing folders through `extra_model_paths.yaml` and are never committed.

## Quick start (Windows)

You need Node 22.4 or newer, an NVIDIA GPU, and a portable ComfyUI install.

1. Copy `.env.example` to `.env.local` and set `COMFY_ROOT` and `COMFY_PYTHON`. The Hugging Face and Civitai tokens are optional.
2. Install dependencies and create the database:
   ```
   npm install
   npm run db:push
   ```
3. Start ComfyUI in the background:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\start_comfy_api.ps1 -Background
   ```
   Use `-Status` to check it and `-Stop` to stop it.
4. Start the studio and the queue worker:
   ```
   npm run dev
   ```
5. Open http://localhost:3000.

Stop the dev server before running `npm run build`, because it locks Prisma's engine DLL on Windows. Use `npm run typecheck`, `npm run lint` and `npm run validate:workflows` to check your changes.

On an 8 GB GPU, run only one heavy tool at a time (the studio, or another image generator, but not both).

## Cloud GPU

The header can switch between the laptop GPU and a rented cloud GPU reached through an SSH tunnel. In Remote mode the 8 GB limits are off, so the native FP16 Flux template and larger sizes are used. See [`docs/CLOUD.md`](docs/CLOUD.md) and `scripts/vultr_cloud_setup.sh`.

The dataset exporter also writes a cloud training bundle (ai-toolkit Flux, kohya SDXL and OneTrainer configs, plus `run_cloud_training.sh`). Cloud runs use rank 32, batch 2 and 1200 steps, keep the checkpoints from step 600 on, and print the command to copy the results back.

## Documentation

- [`STATUS.md`](STATUS.md): phase-by-phase build log, decisions and verification notes
- [`docs/SYSTEM.md`](docs/SYSTEM.md): hardware and software inventory
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md): render times and VRAM use
- [`docs/TRAINING.md`](docs/TRAINING.md): training the character LoRA
- [`docs/REALISM_GUIDE.md`](docs/REALISM_GUIDE.md): the phone-photo look
- [`docs/CLOUD.md`](docs/CLOUD.md): remote GPU and cloud training

## License and model terms

Each model, node pack and LoRA keeps its own license. Check them before any commercial use. Flux.1-dev, for example, has a non-commercial license.

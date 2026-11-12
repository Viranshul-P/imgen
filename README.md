# PersonaForge

A local studio for generating candid, phone-style lifestyle photos of a single **fictional** AI character. It runs entirely on a consumer RTX 4060 (8 GB VRAM) using free, open-source weights.

The stack:
- **ComfyUI (headless)**, driven over its HTTP/WebSocket API
- **Engine A**: Flux.1-dev GGUF (Q4_K_S) with a T5 GGUF encoder, for natural skin and indoor light
- **Engine B**: SDXL checkpoints with LoRA chaining, OpenPose/Depth ControlNet and IP-Adapter FaceID
- **Engine C**: SDXL masked inpainting (crop-and-stitch) for pixel-locked multi-stage wardrobe sets
- **Next.js + TypeScript + Prisma/SQLite** studio UI, with a background queue worker that serializes jobs and flushes VRAM between engines
- **Smartphone ISP finisher** (`scripts/realism_finish.py`): tone curve, lens softness, vignette, chromatic aberration, sensor noise and JPEG recompression

## Layout
```
persona-forge/
  docs/        system inventory, benchmarks, training & realism guides
  scripts/     ComfyUI discovery/launch, node setup, model downloader, validators, finisher
  workflows/   ComfyUI API-format workflow templates (built from the live /object_info schema)
  worker/      background job runner
  src/         Next.js app (API routes, components, lib)
  prisma/      SQLite schema
```

ComfyUI itself lives outside the repo, in `../ComfyUI_windows_portable`. Model weights are shared from existing folders through `extra_model_paths.yaml` and are never committed.

## Cloud GPU
The header can switch between the laptop GPU and a rented cloud GPU reached through an SSH tunnel. See [`docs/CLOUD.md`](docs/CLOUD.md) and `scripts/vultr_cloud_setup.sh`.

## Status
See [`STATUS.md`](STATUS.md) for the phase-by-phase build log.

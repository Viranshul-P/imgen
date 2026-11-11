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
- The Flux `.gguf` is not listed under `diffusion_models` until ComfyUI-GGUF is installed (Phase 1).
- System RAM is very low (0.75 GB free). Free it up before Engine A runs (see BENCHMARKS.md).

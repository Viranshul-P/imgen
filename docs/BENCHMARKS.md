# BENCHMARKS — RTX 4060 Laptop (8 GB) measurements

## Baseline (Phase 0, 2026-11-11, ComfyUI idle, no models loaded)
| Metric | Value |
|---|---|
| ComfyUI | 0.45.0 portable (cu126), Python 3.12.10, torch 2.14.1+cu126, allocator `cudaMallocAsync` |
| Launch flags | `--listen 127.0.0.1 --port 8188 --reserve-vram 0.8 --disable-auto-launch` |
| VRAM free | 6.93 GB / 8.00 GB (the desktop compositor and browsers hold ~1.1 GB) |
| System RAM free | **0.75 GB / 15.73 GB**; commit charge 28.0 / 37.7 GB (22 GB pagefile) |
| Cold start to `/system_stats` | < 15 s (no custom nodes) |

**RAM note:** the big users at capture time were svchost (2.1 GB), Chrome (1.5 GB), Edge WebView2 (1.4 GB), Explorer (1.3 GB), VS Code (0.9 GB), ChatGPT (0.9 GB), LM Studio (0.4 GB) and WhatsApp. A second Windows user session was also signed in. Flux Q4_K_S plus T5 needs roughly 10 GB of RAM headroom for model offload, so before Engine A benchmarks: sign out other Windows users and close LM Studio, ChatGPT and other heavy apps.

## Download throughput
- GitHub release download: 1.96 GB in 278 s (avg 7.0 MB/s ≈ 56 Mbps)

## Engine timings
Smoke runs (Phase 3, 256×256, 2 steps): face lock 4.2 s · Engine A 25.8 s (incl. Flux + T5 load) · Engine B 6.8 s · Engine C 3.8 s · genesis faces 0.8 s.

Full-size runs (Phase 7, 2026-11-11, through the queue worker, Phone Look Finisher on):

| Job | Resolution | Steps | Time | Peak VRAM* | Notes |
|---|---|---|---|---|---|
| B — SDXL RealVisXL V5 + FaceDetailer | 832×1216 | 28 + 20 | **33.2 s** | 7,598 MB | first job after ComfyUI start (incl. checkpoint load) |
| C — SDXL wardrobe inpaint (crop → stitch) | 832×1216 (1024² crop) | 28 | **22.6 s** / 21.7 s / 23.1 s | 7,557–7,699 MB | denoise 0.75 / 0.9 / 0.9 after the prompt fix; pixel lock 0 of 633,286 outside px changed |
| A — Flux GGUF Q4_K_S + T5 Q5_K_M + realism LoRAs + FaceDetailer | 896×1152 | 24 + 20 | **165.1 s** | 6,726 MB | incl. SDXL→Flux flush + Flux/T5 load with only ~5 GB RAM free (Chrome open) |
| Genesis master-face candidate | 1024×1024 | 28 | 36.1 s first, then ~31 s | 6,527–7,692 MB | first one incl. Flux→SDXL flush + reload |
| Genesis dataset frame (IP-Adapter FaceID Plus v2) | 832×1216 | 28 + 20 | 71.5 s first, then ~43.5 s | 7,437–7,773 MB | first one incl. insightface + IP-Adapter load |
| Phone Look Finisher | → 1080×1350 JPEG | — | ~0.6 s/img in-process; 2.2–2.5 s for 3 imgs via `/api/vault/export` (incl. zip) | CPU | both `iphone_indoor_warm` and `iphone_dim_bedroom_high_iso` |

\*Device-wide peak sampled every 2 s from `/system_stats` (total − free), so it includes the desktop's share (~0.1–1 GB). Every job stayed under the 8 GB card limit with `--reserve-vram 0.8`; no OOM, no fallback to `--lowvram`.

**VRAM flush guard verified:** the worker logged `VRAM flush: SDXL:RealVisXL_V5.0_fp16 -> FLUX_GGUF:flux1-dev-Q4_K_S` before Engine A, and `FLUX_GGUF -> SDXL` straight after it (`WorkerState.flushCount` = 2). Same-engine jobs reused the loaded model without flushing (the 2nd–4th face candidates are ~5 s faster than the 1st).

**Engine A RAM note:** with Chrome open (≈4–5 GB RAM free) the Flux job took 165 s end-to-end, partly page-file bound while loading. With ~10 GB free, expect noticeably faster loads. The sampling itself kept the GPU at ~97 %.

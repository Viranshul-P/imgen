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

Full-size runs:

| Engine | Resolution | Steps | Time | Peak VRAM | Notes |
|---|---|---|---|---|---|
| A — Flux GGUF Q4_K_S | 896×1152 | 24 | | | |
| B — SDXL RealVisXL V5 + FaceDetailer (via worker) | 832×1216 | 28 + 20 | 33.1 s | 7,041 MB | first run incl. model load, 2026-11-11 |
| C — SDXL inpaint | crop | 28 | | | |

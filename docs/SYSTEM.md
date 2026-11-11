# SYSTEM — PersonaForge host inventory

Captured: 2026-11-11 (Phase 0 discovery)

## Hardware
| Item | Value |
|---|---|
| GPU | NVIDIA GeForce RTX 4060 **Laptop** GPU, 8188 MiB VRAM (~1.2 GB in use by desktop at idle) |
| NVIDIA driver | 560.94 |
| CUDA (driver max) | 12.6 |
| CPU | Intel Core i7-14650HX |
| System RAM | 15.7 GB total (~3.4 GB free at capture time) |
| Disk | C:\ — 311.1 GB free / 951.6 GB total (only fixed drive; no D:\) |

## Software
| Item | Value |
|---|---|
| OS | Windows 11 Home Single Language, 64-bit, build 10.0.26300 |
| User | local standard user (non-admin workflow) |
| Node.js | v22.14.0 |
| npm | 10.9.2 |
| Git | 2.51.2.windows.1 |
| System Python | 3.12.5 (`C:\Program Files\Python312\python.exe`), no PyTorch installed |
| VC++ Build Tools | Visual Studio Build Tools 2022 17.14 at `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools` (`cl.exe` not on PATH by default; available through the VS dev shell) |
| VC++ Redistributables | 2008–2022 x86/x64 present |

## ComfyUI discovery
Searched: every `C:\Users\*` profile I can read (common ComfyUI, portable and Desktop paths), `C:\ComfyUI*`, plus a full recursive `C:\*comfy*` folder scan. Two other local user profiles are not readable by this account, and I did not try to change their permissions.

| Finding | Detail |
|---|---|
| Active ComfyUI install | **None found** |
| ComfyUI Desktop app | Not installed (`AppData\Local\Programs\ComfyUI` and `AppData\Roaming\ComfyUI` absent) |
| Deleted copy | `C:\$Recycle.Bin\...\$RR6JHO0\ComfyUI`, a git checkout of v0.3.57 with no venv, no custom nodes and about 20 MB of models. Not worth restoring. |

## Existing ComfyUI in C:\Users\Public (copied in from another local account)
`C:\Users\Public\ComfyUI_windows_portable` (30.4 GB, writable by this account). There is also an unextracted `ComfyUI_windows_portable_nvidia (1).7z` (1.95 GB).

| Item | Value |
|---|---|
| ComfyUI | v0.3.66 (portable build) |
| Python | `python_embeded\python.exe`, 3.13.6 |
| PyTorch | 2.8.0+cu129, CUDA available, detects the RTX 4060 Laptop |
| Key packages | insightface 0.7.3 (cp313 wheel already built), onnxruntime-gpu 1.23.2, gguf 0.17.1, opencv 4.12, numpy 2.2.6, Pillow 12.0, huggingface_hub 0.35.3, segment-anything 1.0. **ultralytics is missing.** |
| extra_model_paths.yaml | none |

**Custom nodes installed:** ComfyUI-GGUF, comfyui-impact-pack, comfyui-manager, comfyui-reactor-node, comfyui_controlnet_aux, plus cg-use-everywhere, comfy-mtb, art-venture, easy-use, kjnodes, quadmoons, various, Comfyroll, essentials, tinyterra, ultimatesdupscale, efficiency-nodes, rgthree, sdxl-adherence, sdxl_prompt_styler, was-node-suite and x-flux-comfyui.
**Spec nodes missing:** ComfyUI_IPAdapter_plus, ComfyUI-Impact-Subpack, ComfyUI-Inpaint-CropAndStitch.

**Models and how they map to the spec:**
| File | Size | Spec use |
|---|---|---|
| `unet\flux1-dev-Q4_K_S.gguf` | 6.34 GB | ✅ Engine A base |
| `diffusion_models\flux1-dev-Q4_K_S.gguf` | 6.34 GB | duplicate of the above (a separate copy, not a hard link) |
| `clip\clip_l.safetensors` | 0.23 GB | ✅ Engine A |
| `vae\ae.safetensors` | 0.31 GB | ✅ Engine A |
| `clip\t5xxl_fp8_e4m3fn.safetensors` | 4.56 GB | usable fallback; the spec asks for the T5 Q5_K_M GGUF (smaller, better for 16 GB RAM) |
| `checkpoints\realisticVisionV60B1_v51HyperVAE.safetensors` | 1.99 GB | ❌ SD 1.5 model, so it can't be used by the SDXL Engines B/C |
| `insightface\models\buffalo_l\*` | 0.32 GB | ✅ needed by IP-Adapter FaceID |
| `insightface\inswapper_128.onnx` | 0.52 GB | ✅ optional ReActor |
| `sams\sam_vit_b_01ec64.pth` | 0.35 GB | ✅ SAM auto-segment in the mask canvas |
| `facerestore_models\*`, `facedetection\*` | ~1.8 GB | ReActor extras |

## Reusable model weights already on disk (Fooocus)
Fooocus 2.5.0 at `C:\Users\viranshul\Downloads\Fooocus_win64_2-5-0\Fooocus_win64_2-5-0\Fooocus\models` (embedded Python 3.10.9):

| File | Size | ComfyUI folder |
|---|---|---|
| `checkpoints\juggernautXL_v8Rundiffusion.safetensors` | 6.62 GB | checkpoints |
| `loras\sd_xl_offset_example-lora_1.0.safetensors` | 0.05 GB | loras |
| `upscale_models\fooocus_upscaler_s409985e5.bin` | 0.03 GB | Fooocus-specific, not usable by ComfyUI |

Hugging Face cache (`~\.cache\huggingface\hub`) holds only small unrelated timm models.

## Constraints noted for later phases
- **Laptop 4060:** it has a lower power limit than the desktop card, so expect Flux timings toward the slow end of the spec's 1.5–3 min range.
- **16 GB system RAM is tight** for Flux Q4_K_S (~6.8 GB) plus T5 Q5_K_M (~3.4 GB) once the OS, browser and Next.js are running. Model offload will page to disk. Engine A benchmarks should run with other apps closed, and the `--lowvram` / Q3_K_S fallback ladder may be needed.
- There is only one drive. The core model set in Phase 2 is about 30 GB, which fits easily in 311 GB free.

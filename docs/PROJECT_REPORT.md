# PersonaForge Project Report

A free, local web studio that makes candid, handheld-phone-style photos of one fictional AI character, running on a laptop RTX 4060 with 8 GB of VRAM.

Build dates: 2026-11-11 to 2026-11-12 · 42 commits · phases 0 to 7 complete · about 7,100 lines of code

| Facts | |
|---|---|
| Image engines | 3 (Flux, SDXL, SDXL inpaint) |
| ComfyUI workflow templates | 6 |
| Required ComfyUI node classes | 43, all present |
| Models downloaded | 20.5 GiB, checksum-verified |
| Paid services used | 0 |

---

## 1. What this project is

The goal came from a spec my friend wrote (`SPEC.md`, about 30 KB). Every image must look like a casual, unretouched photo taken at home on a phone, never like a studio portrait or a glossy AI render. Everything uses free open-source weights and runs locally. No paid API, cloud GPU or subscription is involved.

It has three parts:

- **ComfyUI** runs headless as the image engine, driven over its HTTP and WebSocket API.
- **A Next.js web studio** (TypeScript, Prisma, SQLite) is the interface for characters, shoots, wardrobe sequences, datasets and a gallery.
- **A background worker** pulls jobs from the database one at a time and manages the small GPU's memory.

The work followed the spec phase by phase (0 to 7). After each phase there was a verification step, a commit, and a note in `STATUS.md`. Two features were added after the spec at my request: a free-text Prompt tab and a hi-res second pass. A minor-safety guard was added afterward.

## 2. Where advice would help most

1. **Identity.** Is the plan of IP-Adapter FaceID to make 35 frames, then train an SDXL LoRA, then use it on Flux renders through a face-lock pass, sound? Or is training a Flux LoRA worth the 24 GB base download?
2. **Realism.** SDXL output still reads "AI-ish". Flux at 1344x1728 reads as a real phone photo but takes about 6 minutes. Is there a cheaper route to Flux-level realism on 8 GB (smaller quant, other realism LoRAs, a different sampler)?
3. **Speed on 16 GB RAM.** Flux plus the T5 encoder pages to disk. Would a 32 GB machine, a smaller T5 quant, or a different offload setup help more?
4. **Wardrobe sequences.** Engine C keeps the original garment colour at the default denoise and needs 0.85 to 0.92 for colour changes. Is there a better inpainting recipe or model?
5. **Auto masks.** Clothing auto-segmentation was left out because no clothing-segmentation model was in the spec's model list. Which model would you pick?

## 3. Hardware and environment

| Item | Value |
|---|---|
| GPU | NVIDIA RTX 4060 **Laptop**, 8 GB VRAM, driver 560.94, CUDA 12.6 |
| CPU / RAM | Intel Core i7-14650HX, 15.7 GB RAM (often under 5 GB free with a browser open) |
| Disk | One drive, about 311 GB free |
| OS | Windows 11 Home, standard (non-admin) user |
| Tooling | Node 22, Git 2.51, Python 3.12, Visual Studio Build Tools 2022 |
| ComfyUI | v0.45.0 portable build (cu126), torch 2.14.1, Python 3.12 embedded |

The laptop 4060 has a lower power limit than the desktop card, and 16 GB of RAM is tight for Flux. Both shaped the design: one image at a time, with models unloaded whenever the engine changes.

## 4. Architecture

```
Studio UI (Next.js)  --REST-->  API routes  -->  SQLite (Prisma)
 Prompt, Shoot, Arc,                              Character, Campaign, Job,
 Character, Vault        <--SSE progress--        Asset, Arc, WorkerState
                                                       ^
Queue worker (Node/tsx) --claims jobs------------------+
   |
   +--> workflowInjector + live schema check
   |        |
   |        +--HTTP + WebSocket--> ComfyUI (headless, port 8188)
   |                                   |
   |                                   +--> shared model folders (extra_model_paths.yaml)
   |
   +--> data/raw/ (PNG)  --optional-->  realism_finish.py  -->  data/finished/ (JPEG)
```

### Key design decisions

- **Fresh ComfyUI, shared models (Option 1).** The machine already had an older ComfyUI copy and Fooocus models. A clean ComfyUI was installed, and `extra_model_paths.yaml` points at the existing model folders. No weights were duplicated and the old installs were not touched.
- **Workflows come from the live schema.** No node or input name was guessed. Every template was built from `GET /object_info`, and every job is re-validated against it before queueing.
- **Templates plus an injector.** Each workflow is a JSON file with placeholders. `workflowInjector.ts` fills values, chains LoRAs, and removes disabled optional blocks while rewiring the graph around them.
- **One image per job.** `batch_size` is always 1. A 10-image shoot becomes 10 queued jobs.
- **VRAM guard.** Whenever the next job changes engine (Flux or SDXL) or checkpoint, the worker calls `POST /free` and waits 1.5 s before dispatching.
- **Local only.** Downloads use public Hugging Face files and verify SHA-256 checksums.

## 5. The three engines

| Engine | Model | Job | Measured |
|---|---|---|---|
| **A** | Flux.1-dev GGUF Q4_K_S, T5-XXL Q5_K_M GGUF encoder, realism LoRAs | Natural skin, indoor light, candid shots | 165 s at 896x1152; 350 s with hi-res to 1344x1728 |
| **B** | SDXL (RealVisXL V5.0, Juggernaut XL v8), LoRA chain, optional pose or depth ControlNet, optional IP-Adapter FaceID | Fast renders, pose control, dataset generation | 33 s at 832x1216 with FaceDetailer |
| **C** | SDXL masked inpaint (crop and stitch, DifferentialDiffusion) | Wardrobe changes in the same room | 22 s per stage |
| **Face lock** | SDXL FaceDetailer with the character LoRA, denoise 0.35 | Puts the trained face onto a Flux render | about 4 s in smoke test |

Engine C pastes only the feathered painted area back onto the original, so the face, bed and lighting outside the mask stay identical. Measured at full size: 0 of 633,286 outside pixels changed.

### Hi-res second pass (added after the spec)

Plain upscaling only sharpens. The hi-res pass runs 4x-UltraSharp, scales to 1.5x, and re-samples at denoise 0.35 so skin, eyes and fabric are redrawn at the larger size. FaceDetailer then runs on the larger face. It is on by default for Engines A and B.

## 6. Keeping one face across images

The spec avoids stacking many face-locking tools, since that damages skin texture. The tiers are:

1. **Character LoRA** (strength 0.80 to 0.95) with a unique trigger word, once trained. This is the main identity layer.
2. **Bootstrap:** IP-Adapter FaceID Plus v2 builds the 35-image training set from one chosen `master_face.png`.
3. **FaceDetailer** at denoise 0.28 to 0.35 for eyes, lips and hands without erasing pores.
4. **Cross-engine face lock:** a Flux render is followed by an automatic SDXL pass that applies the trained SDXL LoRA to the face. Flux supplies body and light, SDXL supplies the locked face.

ReActor (face swap) is installed but deliberately not connected to any workflow. The studio rejects `enableReactorSwap: true`.

## 7. The realism stack

### At generation time

- Flux guidance 2.6 (lower than typical, to avoid glossy output), euler sampler, beta scheduler, 24 steps.
- SDXL: dpmpp_2m_sde with karras, 28 steps, CFG 5.
- Free amateur-photo LoRAs (XLabs Flux Realism, Amateur Photography) chained at 0.55 to 0.75.
- Phone aspect ratios: 4:5 and 9:16.
- **Six scene kits** that add handheld quirks: bedroom mirror selfie, high-angle bed selfie, POV down-angle close-up, bathroom vanity mirror, night flash, couch lounge.
- A soft warning badge appears if a prompt contains "studio sheen" words such as masterpiece, 8k, flawless skin or bokeh.

### After generation: the phone finisher

`realism_finish.py` imitates a phone camera's image pipeline in six stages:

| Stage | What it does |
|---|---|
| Tone | White balance, gentle S-curve, lifted shadows, highlight roll-off and bloom |
| Lens | 0.5 px softening, 6 to 10% vignette, 0.5 px radial chromatic aberration |
| Sharpen | Mild luma unsharp mask (radius 1.1, amount 0.35) |
| Noise | Shadow-weighted luminance grain (1.8 to 3.0%) plus 0.4% colour noise |
| Crop | 1080x1350 or 1080x1920 JPEG at q92 with 4:2:0 chroma. No EXIF is faked. |
| Presets | iphone_indoor_warm, iphone_mirror_selfie, iphone_flash_night, iphone_dim_bedroom_high_iso, iphone_daylight, raw_unfiltered |

The crop runs first so grain and sharpening radii are exact at the delivered size. It takes about 0.6 s per image. Raw PNGs are always kept.

## 8. The studio and worker

Stack: Next.js 16 (App Router), React 19, TypeScript strict, Tailwind v4, shadcn-style components, Prisma 6 with SQLite. `npm run dev` starts the site and the worker together.

| Tab / module | Purpose |
|---|---|
| Prompt (default) | Sends text to Flux or SDXL exactly as typed, with no hidden character text, scene text or default negatives. Optional extras are labelled. |
| System header | Live VRAM and RAM bars, active engine, queue length, Free VRAM and Refresh Models buttons |
| Shoot | Engine and checkpoint choice, multi-LoRA stack with weight sliders (-1 to 2), scene kits, pose reference, 1 to 20 candidates |
| Arc builder | 5 to 10 stage wardrobe sequence in one room. Mode 1: inpaint a base frame. Mode 2: pose-guided. "Generate Full Progression Arc" queues every stage. |
| Mask canvas | Brush and eraser, feather preview, undo and redo, invert, exports a mask PNG |
| Character | Trigger word, locked descriptors, master-face candidates, 35-frame dataset, approve and reject grid, export for training |
| Vault | Gallery filtered by campaign and stage, raw vs finished slider, quality checklist, bulk finish and zip export |

### Worker behaviour

- Claims jobs atomically (priority, then oldest first) and re-queues jobs stuck after a restart.
- Tracks live step progress over WebSocket and streams it to the browser through server-sent events.
- Samples peak VRAM every 2 s, supports cancel through `/interrupt`, and saves outputs to `data/raw/`.
- Queues the face-lock follow-up and runs the finisher after each render. A finisher failure never fails the job.

### Minor-safety guard

Added at the end. `contentSafety.ts` runs on every prompt path. It blocks sexual terms combined with any cue suggesting a minor, and blocks "girl" or "boy" in a sexual prompt without a stated adult age. Characters are fictional adults only. Non-sexual prompts are unaffected.

## 9. Workflow templates

| File | Chain |
|---|---|
| `engine_a_flux_lifestyle` | GGUF UNet, LoRA chain, dual CLIP, FluxGuidance, custom sampler, VAE decode, hi-res pass, FaceDetailer, save |
| `engine_b_sdxl_editorial` | Checkpoint, LoRA chain, prompts, optional ControlNet (DWPose or Depth Anything V2), optional IP-Adapter FaceID, KSampler, hi-res, FaceDetailer, optional hand detailer, save |
| `engine_c_wardrobe_inpaint` | Image and mask, grow 12 px, blur, crop, inpaint conditioning, DifferentialDiffusion, KSampler (denoise 0.75), stitch, composite pixel lock, save |
| `genesis_master_face_candidates` | Generates N front-facing amateur portraits of the fictional character to pick from |
| `genesis_dataset` | Uses the master face and IP-Adapter FaceID Plus v2 to make varied angle, light and framing frames |
| `cross_engine_face_lock` | SDXL FaceDetailer at 0.35 over a Flux image |

A validator script checks every feature and variant combination against the live schema (15 combinations, all valid) and runs tiny 256x256, 2-step smoke renders on the GPU (5 of 5 passed).

## 10. Local LoRA training (8 GB)

The studio exports approved dataset frames in the layout trainers expect (`<repeats>_<trigger> woman/` with `.txt` captions), plus ready configs for OneTrainer and kohya_ss. Captions contain framing, angle, light and expression, and leave out the fixed identity traits on purpose.

| Recipe | Settings |
|---|---|
| **A: SDXL character LoRA** (about 25 min) | Adafactor, gradient checkpointing, bf16, cached latents and text-encoder outputs, rank and alpha 16, 1024 px, batch 1, 1400 steps |
| **B: Flux character LoRA** | OneTrainer NF4 with offload, or kohya fp8 with `blocks_to_swap 28`, rank 16, Adafactor, 512 px buckets. Needs the full gated FLUX.1-dev weights (about 24 GB), not downloaded. |

No LoRA has been trained yet. That needs a real approved dataset and a trainer installed outside ComfyUI.

## 11. Build log by phase

| Phase | What was done |
|---|---|
| 0 Discovery | Hardware inventory, found an old ComfyUI 0.3.66 and Fooocus models, installed clean ComfyUI 0.45.0 with shared model paths, wrote launcher scripts |
| 1 Nodes | Installed 7 custom node packs with an idempotent installer. All 43 required classes registered. |
| 2 Models | Resumable downloader with disk check and SHA-256 verify. 14 files, 20.5 GiB. Survived a mid-run network outage. |
| 3 Workflows | Six templates, injector, schema validator, smoke tests |
| 4 Studio | Database, API routes, worker, all UI modules. First live end-to-end render. |
| 5 Finisher | Six-stage ISP script, six presets, Vault export and before/after slider |
| 6 Training | Dataset exporter, four trainer presets, TRAINING.md |
| 7 Verification | Build and lint clean, full-size renders on all engines, VRAM flush verified, genesis pipeline run for real |
| After spec | Prompt tab, hi-res second pass, history race fix, minor-safety guard |

## 12. Verified results

| Job | Size | Time | Peak VRAM |
|---|---|---|---|
| Engine B, SDXL + FaceDetailer | 832x1216 | 33.2 s | 7.6 GB |
| Engine C, inpaint | 832x1216 | 22.6 s | 7.6 to 7.7 GB |
| Engine A, Flux (about 5 GB RAM free) | 896x1152 | 165.1 s | 6.7 GB |
| Engine A with hi-res | 1344x1728 | 350 s | 6.6 GB |
| Master-face candidate | 1024x1024 | about 31 s | 6.5 to 7.7 GB |
| Dataset frame (IP-Adapter) | 832x1216 | about 43.5 s | 7.4 to 7.8 GB |
| Phone finisher | 1080x1350 | about 0.6 s | CPU only |

- Peak VRAM is measured device-wide, so it includes the desktop's share. No job ran out of memory.
- The VRAM flush ran correctly in both directions (SDXL to Flux, Flux to SDXL). Same-engine jobs reuse the loaded model.
- `tsc` strict, `npm run lint` and `npm run build` all pass with 0 errors and 0 warnings.
- I checked the Vault before/after slider by hand.

## 13. Problems found and solved

- **Spec details that were out of date.** `--normalvram` no longer exists. The Flux VAE repo is now gated, so a byte-identical ungated mirror was used. The OpenPose filename and CLIP-ViT-H format had changed. ComfyUI-Manager moved organisations. Each fix was checked against the live source.
- **insightface vs numpy 2.** The prebuilt wheel crashed. The installer builds it from source against the matching Python.
- **Two albumentations packages** shared one import name and broke face detection. Only the maintained one is kept.
- **Wrong numpy and Pillow loaded.** A user-site install shadowed the embedded Python's packages, so the embedded Python always runs with `-I`.
- **Engine C painted a second face** into the clothing area at high denoise. Identity text was reaching a torso-only crop and the crop context hid the real head. Garment-only prompts, a wardrobe negative, and a wider crop context fixed it.
- **A successful long Flux render looked like a failure** because outputs were not yet in history. The client now retries history for up to 10 s.
- **SDXL output looked low-res and "AI-ish",** which led to the hi-res second pass and a recommendation to use Flux for real-looking posts.

## 14. Known gaps

- No automatic clothing segmentation. Masks are painted by hand.
- No LoRA is trained yet, so the face lock has only been tested structurally.
- IP-Adapter FaceID pulls faces toward frontal, so "profile" frames often come out near-frontal. It can also exaggerate freckles. Bad frames should be rejected or recaptioned.
- The first 7 dataset frames share one lighting setup by design. A full 35-frame run covers all five.
- At default denoise, Engine C keeps the old garment colour. Use 0.85 to 0.92 for colour changes.
- Flux speed depends heavily on free RAM. Close other apps first.
- `npm audit` reports advisories only in dev tooling that is not shipped.

## 15. What comes next

1. Create the real fictional character (no reference to any real person's face).
2. Generate master-face candidates and pick one.
3. Generate the full 35-frame dataset, approve the good frames and fix captions.
4. Export, then train Recipe A in OneTrainer or kohya.
5. Set the trained LoRA on the character and start shooting, using the face lock on Flux renders.

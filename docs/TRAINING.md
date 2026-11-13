# Training the Character LoRA locally (RTX 4060, 8 GB VRAM, $0)

Every tool here is free, open source and runs on this laptop. No cloud GPUs, no paid APIs.

```
master_face.png ──► Genesis dataset (35 frames, IP-Adapter FaceID Plus v2, Engine B)
                ──► Dataset Curator: approve the best 25–40, fix captions
                ──► "Export approved frames for training"  (scripts/prepare_dataset.py)
                ──► Recipe A (SDXL LoRA, ~25–40 min)  ──► Engines B/C + Cross-Engine Face Lock on Flux
                ──► Recipe B (Flux LoRA, optional, hours) ──► Engine A
```

## 1. Export the dataset

In **Character & Dataset → Dataset Curator**, tick (✓) the good frames and reject (✗) the bad ones: wrong face, broken hands, duplicate pose. Set *repeats* (10 by default), then press **Export N approved frames for training**. The export also comes as a zip you can download.

The export goes to `data/exports/datasets/<trigger>_<time>/`:

| Path | For |
|---|---|
| `img/<repeats>_<trigger> woman/0001.png + 0001.txt` | the images and captions (kohya folder convention; OneTrainer reads the same folder) |
| `kohya/dataset_sdxl.toml`, `dataset_flux.toml` | sd-scripts `--dataset_config` (1024 px / 512 px buckets, `num_repeats` written explicitly) |
| `kohya/train_sdxl.ps1`, `train_flux.ps1` (+ `.json`) | ready-to-run sd-scripts launchers, with every path filled in |
| `onetrainer/sdxl_lora.json`, `flux_lora_nf4.json`, `concepts.json` | OneTrainer configs (config version 11), loaded with **Load config** |
| `README.txt`, `export.json` | the exact numbers for this export, plus warnings |

The CLI does the same from the studio database:

```powershell
..\ComfyUI_windows_portable\python_embeded\python.exe -I scripts\prepare_dataset.py --db prisma\dev.db --trigger v1ra_person --out data\exports\datasets\v1ra --zip
```

**Captions** always start with the trigger, then the frame's bucket sub-token (if it has a bucket), then the class word:
`v1ra_person, v1ra_person_face, woman, waist-up shot, three-quarter view from the left, warm bedside lamp light, soft smile`
(untagged frames: `v1ra_person, woman, ...`).
- They name only what *changes* between frames: framing, angle, light and expression.
- Fixed traits (eye colour, freckles, hair texture) are left out on purpose, so the LoRA binds them to the trigger token.
- A caption typed in the Curator replaces the automatic one. The trigger and sub-token are always moved to the front (and the class word added if missing).

**Check the angle words before exporting.** IP-Adapter FaceID pulls faces toward the camera, so a frame generated for "left profile" often comes out nearly frontal (seen in the Phase 7 test). A caption that names the wrong angle teaches the LoRA the wrong thing, so fix it in the frame's caption box (e.g. `front view` instead of `right profile`) or reject the frame. FaceID can also exaggerate freckles or redness; reject frames whose skin doesn't match the master face.

**Trained LoRAs** are saved straight into `ComfyUI\models\loras`. Press **Refresh Models** in the studio, then pick the file as the character's SDXL (or Flux) LoRA in the Character DNA editor. The default strength is 0.85 (spec: 0.80–0.95).

**Steps:** 35 images × 10 repeats = 350 steps per epoch.
- SDXL: kohya stops at `max_train_steps = 1400`, and OneTrainer is set to `ceil(1400 / 350) = 4` epochs.
- Flux: 1200 steps.

---

## 2. Install a trainer (one time, separate from ComfyUI)

Install the trainer in **its own folder and Python environment**. Never `pip install` it into ComfyUI's `python_embeded`: that would break the node pack fixes from Phase 1.

**OneTrainer (recommended: GUI, best 8 GB memory handling)**: https://github.com/Nerogar/OneTrainer
```powershell
git clone https://github.com/Nerogar/OneTrainer C:\AI\OneTrainer
cd C:\AI\OneTrainer
.\install.bat        # creates its own venv with the CUDA build of torch
.\start-ui.bat
```

**kohya-ss sd-scripts (command line)**: https://github.com/kohya-ss/sd-scripts
Follow the README's Windows install. It creates a `venv`, installs the CUDA torch build it names, then runs `pip install -r requirements.txt` and `accelerate config`; answer *This machine / No distributed / bf16*. The generated `train_*.ps1` takes the folder as `-SdScripts`:
```powershell
powershell -ExecutionPolicy Bypass -File data\exports\datasets\<export>\kohya\train_sdxl.ps1 -SdScripts C:\AI\sd-scripts
```

**Before training:** stop ComfyUI (`scripts\start_comfy_api.ps1 -Stop`) and the studio worker, and close Chrome. The trainer needs all 8 GB of VRAM and as much of the 16 GB RAM as possible.

---

## 3. Recipe A: SDXL Character LoRA on 8 GB (~25–40 min, $0)

The base model is the character's SDXL checkpoint, resolved automatically. Without one it falls back to `RealVisXL_V5.0_fp16.safetensors`, then `juggernautXL_v8Rundiffusion`. Train on the same checkpoint you render with.

| Setting | Value | Why |
|---|---|---|
| Optimizer | **Adafactor** (`relative_step=False, scale_parameter=False, warmup_init=False`), LR **1e-4**, constant with 100 warmup steps | fixed-LR Adafactor keeps optimizer state tiny (8 GB) |
| Rank / alpha | **16 / 16** | enough capacity for one face; small file (~90 MB) |
| Resolution | **1024×1024** buckets (640–1536, step 64) | SDXL native; the 832×1216 frames bucket without cropping |
| Batch size | **1** | 8 GB |
| Steps | **1400** | ~40 passes over each image |
| Precision | **bf16** mixed precision, fp16 save | RTX 40-series supports bf16 natively |
| Gradient checkpointing | **on** | the biggest VRAM saver |
| Latents | **cached to disk** | the VAE leaves the GPU during training |
| Text encoders | **frozen**; outputs **cached to disk** (kohya) | saves ~1.5 GB; the trigger is learned by the UNet |
| Attention | SDPA | no xformers build needed |

**OneTrainer** (`onetrainer/sdxl_lora.json`):
- `model_type STABLE_DIFFUSION_XL_10_BASE`, `training_method LORA`
- `unet {train: true, weight_dtype FLOAT_16, gradient_checkpointing: true}`
- `text_encoder` / `text_encoder_2 {train: false}`, `vae FLOAT_32`
- `train_dtype BFLOAT_16`, `lora_rank 16`, `lora_alpha 16`, `layer_filter_preset "attn-mlp"`
- `optimizer ADAFACTOR`, `latent_caching true`
- `resolution "1024"`, `batch_size 1`, `epochs` = enough for ~1400 steps

OneTrainer config v11 has no separate "cache text encoder outputs" switch; the text encoders are simply frozen.

**kohya** (`kohya/train_sdxl.ps1`):
```
sdxl_train_network.py --network_module networks.lora --network_dim 16 --network_alpha 16
  --network_train_unet_only --cache_text_encoder_outputs --cache_text_encoder_outputs_to_disk
  --cache_latents --cache_latents_to_disk --gradient_checkpointing --mixed_precision bf16
  --save_precision fp16 --optimizer_type Adafactor
  --optimizer_args relative_step=False scale_parameter=False warmup_init=False
  --learning_rate 1e-4 --lr_scheduler constant_with_warmup --lr_warmup_steps 100 --max_grad_norm 0.0
  --train_batch_size 1 --max_train_steps 1400 --save_every_n_steps 200 --sdpa --no_half_vae
```
`--cache_text_encoder_outputs` requires `--network_train_unet_only` (sd-scripts docs).

**Prodigy instead of Adafactor?** OneTrainer: set `optimizer` to `PRODIGY` and `learning_rate` to `1.0`. Prodigy's extra state costs roughly another 1 GB, so watch VRAM. kohya: the Prodigy optimizer string is not documented in sd-scripts' docs, so these presets ship Adafactor only.

**Judging the result:** a checkpoint is saved every 200 steps. Load the 1000-, 1200- and 1400-step files in Engine B at 0.85 with a scene kit:
- **Face drifts?** Use a later checkpoint.
- **Same pose and lighting in every shot, or burnt colours?** Use an earlier one, or drop to 1000 steps.

---

## 4. Recipe B: Flux Character LoRA on 8 GB (optional, experimental)

**What 8 GB really means:**
- sd-scripts' own table lists 8 GB as `--blocks_to_swap 28` with fp8 base weights.
- FluxGym's lowest supported option is **12 GB**; its 8 GB branch is commented out in `app.py`.
- On this laptop (8 GB VRAM, 15.7 GB RAM) Flux training works by streaming most transformer blocks through system RAM. Expect **several hours** for 1200 steps at 512 px. Use Windows' page file and close everything else.
- Recipe A plus the Face Lock (below) is the practical path. Recipe B is the upgrade.

**Extra download (free, but gated):**
- Flux training needs the **full FLUX.1-dev weights**. The Q4 GGUF used by Engine A cannot be trained on.
- Accept the licence at https://huggingface.co/black-forest-labs/FLUX.1-dev with a free account, and put your token in `HF_TOKEN` in `.env.local`.
- OneTrainer then downloads the diffusers version itself.
- For kohya, place `flux1-dev.safetensors` (~23.8 GB) in `ComfyUI\models\diffusion_models` and re-export.
- `clip_l`, `t5xxl_fp8_e4m3fn` and `ae` are already present.

| Setting | OneTrainer (`flux_lora_nf4.json`) | kohya sd-scripts (`train_flux.ps1`) |
|---|---|---|
| Base weights | transformer **NFLOAT_4** (NF4), T5 NFLOAT_4, CLIP-L bf16 | `--fp8_base` |
| Fitting in 8 GB | transformer `offload_fraction 0.5` + `activation_offloading` | `--blocks_to_swap 28` (replaces the deprecated `--split_mode`) |
| Trained part | transformer only (text encoders frozen) | `--network_train_unet_only`, rank 16 |
| Optimizer | ADAFACTOR, LR 3e-4 | adafactor (same args), LR 4e-4, `--max_grad_norm 0.0` |
| Caching | latents cached | `--cache_latents_to_disk --cache_text_encoder_outputs_to_disk` |
| Resolution | 512 buckets (384–768) | 512 buckets (384–768) |
| Flux specifics | `timestep_distribution LOGIT_NORMAL`, dynamic shifting | `--timestep_sampling shift --discrete_flow_shift 3.1582 --model_prediction_type raw --guidance_scale 1.0` |
| Steps | ~1200 | 1200 |

**Even smaller:** train fewer blocks, in the spirit of the spec's `train_single_blocks_only`. sd-scripts documents `--network_args "train_double_block_indices=..." "train_single_block_indices=..."` (index lists and ranges such as `3,10,20-25,37`; see `docs/flux_train_network.md` for disabling a whole group), and you can drop to rank 8. FluxGym's `train_blocks=single` string is not documented in sd-scripts, so these presets don't use it.

**FluxGym** (https://github.com/cocktailpeanut/fluxgym) also works if you prefer its UI. Choose **12G** (it adds `--split_mode --network_args train_blocks=single` + Adafactor). It runs on 8 GB only through Windows shared GPU memory, which is very slow. Point it at this export's images and captions.

---

## 5. Why you don't have to wait for a Flux LoRA: the Cross-Engine SDXL Face Lock

Engine A (Flux) gives the best candid scenes, but without a Flux LoRA it doesn't know your character. The studio bridges that:

1. Engine A renders the scene (Flux GGUF + realism LoRAs).
2. The worker sees `enableCrossEngineFaceLock` and queues a follow-up job.
3. Before that job, it runs `POST /free` to unload Flux and pauses, so the 8 GB VRAM rule is never broken.
4. The `cross_engine_face_lock` workflow loads your SDXL checkpoint plus **your SDXL Character LoRA**, detects the face (`face_yolov8m`), and re-details only that crop at **denoise 0.35**.
5. Composition, lighting, body and background stay Flux; the face becomes your character. The Phone Look Finisher then runs on the locked image.

So as soon as Recipe A finishes (~30 min), every Engine A render can carry the character's face. Train a Flux LoRA later only if you want the identity built into the whole Flux generation: body proportions, hair in motion, faces at a distance.

In the Shoot tab, tick **Cross-Engine SDXL Face Lock**. It is enabled once the character has an SDXL LoRA set.

---

## 6. Sources checked (2026-11-11)
- OneTrainer `master`:
  - `training_presets/SDXL/#sdxl 1.0 LoRA.json` and `training_presets/Flux Dev.1/#flux LoRA.json`
  - `modules/util/config/TrainConfig.py` (config version 11, per-part `gradient_checkpointing` / `offload_fraction` / `weight_dtype`)
  - `ConceptConfig.py` (v2, `balancing` + `REPEATS`)
  - enums `Optimizer` (`ADAFACTOR`, `PRODIGY`), `DataType` (`NFLOAT_4`, `FLOAT_8`), `LearningRateScheduler`
- kohya-ss/sd-scripts `main`:
  - `docs/sdxl_train_network.md`, `docs/flux_train_network.md` (VRAM table; `--split_mode` deprecated → `--blocks_to_swap`), `docs/config_README-en.md`
  - with `--dataset_config`, folder-name repeats are ignored, so `num_repeats` is written into the TOML
- cocktailpeanut/fluxgym `app.py` (VRAM options 20G/16G/12G, generated flags).

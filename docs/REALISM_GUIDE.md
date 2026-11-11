# Realism Guide — making renders read as casual phone photos

PersonaForge pushes realism at three points. Use all three; the finisher alone cannot rescue a glossy render.

| Where | What | File |
|---|---|---|
| Generation | Amateur/realism LoRAs (0.55–0.75 Flux, 0.40–0.65 SDXL), low Flux guidance (2.6), phone aspect ratios | `workflows/`, Shoot tab |
| Prompt | Amateur Phone Camera Kits + "studio AI sheen" word warning | `src/lib/sceneKits.ts`, `src/lib/promptBuilder.ts` |
| Post | 6-stage smartphone ISP finisher | `scripts/realism_finish.py` |

## The Phone Look Finisher (`scripts/realism_finish.py`)

It changes only the pixels. It does not fake EXIF or camera-model tags: the JPEG has a plain JFIF header. The raw PNG always stays in `data/raw/`, and the finished JPEG goes to `data/finished/<raw-stem>_<preset>.jpg`, linked to the raw asset in the database.

### Stages

| # | Stage | What it does | Spec value |
|---|---|---|---|
| 1 | Tone | Luminance-preserving white-balance shift (warm tungsten or cool flash), monotone S-curve, lifted blacks, smooth highlight shoulder, highlight bloom (screen blend of blurred highlights) | gentle S, lifted shadows |
| 2 | Lens | Gaussian micro-softening, corner vignette, radial chromatic aberration (red grows, blue shrinks, 0 at the centre and the full shift at the corners) | 0.5 px, 6–10 %, 0.5 px |
| 3 | Sharpen | Unsharp mask on luma only, with a soft threshold so flat skin is not crunched | r 1.1, amount 0.35, thr 2 |
| 4 | Noise | Luma grain (slightly correlated, ~1.5 px like demosaiced sensor noise) weighted to shadows/midtones (highlights get ~35 %), plus low-frequency colour blotches | 1.8–3.0 % σ, 0.4 % chroma |
| 5 | Crop + JPEG | Cover-scale and centre-crop to 1080×1350 (4:5) or 1080×1920 (9:16), then JPEG q92 with 4:2:0 chroma subsampling | — |
| 6 | Presets | see below | — |

**Order note:** the crop/resize (stage 5) runs before stages 1–4 and the JPEG encode runs last. The pipeline then works at the delivered resolution, so the 0.5 px softening, the 1.1 px sharpening radius and the grain size are exactly what you see on the phone. If the grain were added first, upscaling an 832×1216 render to 1080 wide would smear it into blobs.

**Intensity:** each of stages 1–4 is scaled by `master intensity × stage weight` (both 0–1). The spec ranges above are the values at intensity 1. The default is 0.7.

**Determinism:** the noise seed comes from the image bytes plus the preset, so re-finishing the same render gives an identical file. Pass `--seed` to override it.

### Presets

| Preset | Use it for | Character |
|---|---|---|
| `iphone_indoor_warm` | Lamp-lit rooms, couch, kitchen | WB 1.05/0.92, S 0.18, grain 2.2 %, vignette 8 % |
| `iphone_mirror_selfie` | Bedroom/bathroom mirror | Flatter, softer (0.6 px), vignette 6 % |
| `iphone_flash_night` | LED-flash snapshots | Cool cast, harsh S 0.28, strong specular bloom, vignette 10 % (flash falloff) |
| `iphone_dim_bedroom_high_iso` | Dim bedside lamp | Warmest, milky lifted blacks, desaturated, grain 3.0 % |
| `iphone_daylight` | Window light | Neutral-cool, crisper, fine grain 1.8 % |
| `raw_unfiltered` | Comparison or delivery as-is | Only crop + JPEG |

Each Amateur Phone Camera Kit pre-selects a matching preset (`sceneKits.ts`).

Measured on a real Engine B render at intensity 1 (high-pass residual vs. the raw):

| Preset | Shadow grain | Highlight grain | Corner luma vs raw |
|---|---|---|---|
| daylight | 1.77 % | 0.65 % | 0.92 |
| indoor_warm | 2.18 % | 0.78 % | 0.93 |
| mirror_selfie | 1.99 % | 0.72 % | 0.96 |
| flash_night | 2.53 % | 0.94 % | 0.86 |
| dim_bedroom_high_iso | 2.99 % | 1.06 % | 0.94 |

The JPEG sampling is verified 2×2,1×1,1×1 (4:2:0), with no EXIF.

## Using it

**Automatically:** in the Shoot tab, tick *Phone Look Finisher* and pick a preset and intensity. The worker finishes each render right after saving it. The job is never failed by a finisher error: the error appears in the job's status text and the raw image is kept.
- Dataset frames (`genesis_dataset`) are never finished, because training wants clean renders.
- Flux renders with the Cross-Engine Face Lock are not finished until the lock runs. The locked SDXL result is finished instead.

**From the Vault:** set the preset, intensity, per-stage weights and size in the Phone Look panel.
- *Apply <preset>* finishes the image you are inspecting.
- *Finish & export N as zip* finishes the ticked images and writes `data/exports/vault_<time>_<preset>.zip`, containing the JPEGs plus `finish_settings.json`.
- When an image has several finished versions, choose which one the before/after slider shows.

**API:** `POST /api/vault/export`
```json
{ "assetIds": ["..."], "preset": "iphone_indoor_warm", "intensity": 0.7,
  "weights": { "tone": 1, "lens": 1, "sharpen": 1, "noise": 1 }, "size": "auto", "bundle": true }
```

**CLI** (always use the embedded Python with `-I`. Without it, an older numpy/Pillow in the Windows user site-packages shadows the embedded ones):
```powershell
..\ComfyUI_windows_portable\python_embeded\python.exe -I scripts\realism_finish.py data\raw\x.png --out-dir data\finished --preset iphone_dim_bedroom_high_iso --intensity 0.8 --weights lens=0.6
..\ComfyUI_windows_portable\python_embeded\python.exe -I scripts\realism_finish.py --list-presets
```
Options: `--size auto|4:5|9:16|original`, `--quality 92`, `--seed N`, `--output file.jpg` (single input), `--bundle out.zip`.

## Tuning tips
- **Use Flux (Engine A) for anything that should pass as a real photo.** SDXL renders (832×1216) look smooth and "2023 AI", with a small, mushy face. Flux + the two amateur/realism LoRAs + the **hi-res pass** (1344×1728 re-sample, default on) is the realistic setup. It takes ~4–6 min per image on this laptop; generate drafts on SDXL, then final posts on Flux.
- **Still looks "AI"?** Fix it at generation time first: lower Flux guidance (2.2–2.6), raise the amateur LoRA, remove the words flagged by the sheen warning, and use a scene kit with clutter in the background. The finisher is the last 20 %.
- **Grain too visible on social media?** Instagram re-compresses, so keep the intensity at 0.6–0.8 rather than 1.0.
- **Skin looks waxy after finishing?** Raise `sharpen` and lower `lens`. Lens softening comes before sharpening on purpose: it removes synthetic edges, and the sharpen stage then restores phone-style edge crunch.
- **Flash shots:** the strong vignette plus contrast already gives the falloff, so don't pair `iphone_flash_night` with a dark scene kit and intensity 1.

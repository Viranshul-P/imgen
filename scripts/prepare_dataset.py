#!/usr/bin/env python3
"""PersonaForge Phase 6 - caption generator and OneTrainer / kohya_ss dataset exporter.

Takes the *approved* genesis dataset frames of one character and writes a ready-to-train folder:

  <out>/
    img/<repeats>_<trigger> <class>/0001.png + 0001.txt    kohya folder convention (repeats in the name)
    kohya/dataset_sdxl.toml, dataset_flux.toml            --dataset_config (num_repeats set explicitly)
    kohya/train_sdxl.ps1, train_flux.ps1                  launch scripts rendered from training/presets
    onetrainer/concepts.json, sdxl_lora.json, flux_lora_nf4.json   loadable OneTrainer configs (v11)
    README.txt, export.json

Captions: "<trigger> <class>, <what varies in this frame>". Fixed identity traits (eye colour,
beauty marks...) are deliberately left OUT of the captions so the LoRA binds them to the trigger.

Inputs (one of):
  --manifest export_manifest.json   written by POST /api/datasets {action:"export"}
  --db prisma/dev.db --trigger v1ra_person   read approved frames straight from the studio database

Run with ComfyUI's embedded Python in isolated mode:
  python -I scripts/prepare_dataset.py --db prisma/dev.db --trigger v1ra_person --out data/exports/datasets/v1ra
Prints one JSON summary line on stdout. Stdlib only (Pillow is used for image checks when present).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shlex
import shutil
import sqlite3
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
PROJECT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))  # -I drops the script directory from sys.path
from download_models import ModelRoots, read_dotenv, resolve_comfy_dir  # noqa: E402

PRESETS = PROJECT / "training" / "presets"
TARGET_STEPS_SDXL = 1400
TARGET_STEPS_FLUX = 1200
# Cloud bundle (48 GB / 80 GB cards): rank 32, alpha 32, 2000 steps, a checkpoint every 250 steps, lr 1e-4, bf16.
CLOUD_FULL_TIERS = ("48gb", "80gb")
CLOUD_RANK = 32
CLOUD_STEPS = 2000
CLOUD_SAVE_EVERY = 250
MIN_SIDE = 512
TRIGGER_RE = re.compile(r"^[A-Za-z0-9_]{3,40}$")


class PrepareError(Exception):
    pass


@dataclass
class Frame:
    image: Path
    hint: str  # varying content: framing, angle, lighting, expression
    override: str  # manual caption from the Dataset Curator ("" = auto)
    bucket: str | None = None  # multi-bucket category: face | body | chest | lower (None = general)


BUCKETS = ("face", "body", "chest", "lower")
SUB_TOKEN_RE = re.compile(r"^[a-z0-9_]{3,48}$")
MAX_IMAGES = 50


def clean_bucket(value: object) -> str | None:
    return value if isinstance(value, str) and value in BUCKETS else None


def sub_token_for(trigger: str, bucket: str | None, custom: dict[str, str]) -> str | None:
    """Sub-token for a bucket: the character's own, else '<trigger>_<bucket>'; None for general frames."""
    if bucket is None:
        return None
    own = custom.get(bucket, "")
    return own if SUB_TOKEN_RE.match(own) else f"{trigger}_{bucket}"


# ----------------------------------------------------------------------------- inputs
def frames_from_manifest(path: Path) -> tuple[str, str, str | None, list[Frame], dict[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("items")
    if not isinstance(items, list):
        raise PrepareError("manifest needs an items array")
    frames = [Frame(Path(i["image"]), str(i.get("hint", "")), str(i.get("caption", "")), clean_bucket(i.get("bucket"))) for i in items]
    sub_tokens = {k: v for k, v in (data.get("sub_tokens") or {}).items() if k in BUCKETS and isinstance(v, str)}
    return str(data.get("trigger", "")), str(data.get("class_word", "woman")), data.get("sdxl_checkpoint"), frames, sub_tokens


def frames_from_db(db: Path, trigger: str, data_dir: Path) -> tuple[str | None, list[Frame], dict[str, str]]:
    if not db.is_file():
        raise PrepareError(f"database not found: {db}")
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        char = con.execute('SELECT id, sdxlCheckpoint, subTokens FROM "Character" WHERE triggerToken = ?', (trigger,)).fetchone()
        if not char:
            raise PrepareError(f"no character with trigger token '{trigger}'")
        rows = con.execute(
            'SELECT a.path, a.caption, j.label, a.bucket FROM "Asset" a LEFT JOIN "Job" j ON a.jobId = j.id '
            "WHERE a.kind = 'dataset' AND a.approved = 1 AND a.characterId = ? ORDER BY a.createdAt",
            (char[0],),
        ).fetchall()
    finally:
        con.close()
    frames = [
        Frame(data_dir / p, label.split(": ", 1)[1] if label and ": " in label else "", caption or "", clean_bucket(bucket))
        for p, caption, label, bucket in rows
    ]
    try:
        custom = {k: v for k, v in json.loads(char[2] or "{}").items() if k in BUCKETS and isinstance(v, str)}
    except json.JSONDecodeError:
        custom = {}
    return char[1], frames, custom


# ----------------------------------------------------------------------------- captions
def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\n", " ")).strip(" ,")


def make_caption(trigger: str, class_word: str, frame: Frame, sub_token: str | None = None) -> str:
    """Every caption starts "<trigger>, <bucket sub-token>, <class word>, ..." (no sub-token for untagged frames).

    A Curator override keeps its wording, but any trigger / sub-token it already contains is moved to the front
    so the tokens are never duplicated or buried mid-caption.
    """
    lead = [trigger] + ([sub_token] if sub_token else [])
    body = clean(frame.override) if frame.override.strip() else clean(frame.hint)
    for token in sorted(lead, key=len, reverse=True):
        body = re.sub(rf"(?<![A-Za-z0-9_]){re.escape(token)}(?![A-Za-z0-9_])", "", body)
    phrases = [re.sub(r"\s+", " ", ph).strip() for ph in body.split(",")]
    phrases = [ph for ph in phrases if ph]
    if not any(re.search(rf"\b{re.escape(class_word)}\b", ph, re.I) for ph in phrases):
        phrases.insert(0, class_word)
    return ", ".join(lead + phrases)


def check_image(path: Path) -> tuple[int, int] | None:
    try:
        from PIL import Image  # embedded ComfyUI Python has Pillow
    except ImportError:
        return None
    with Image.open(path) as im:
        return im.size


# ----------------------------------------------------------------------------- rendering
def fill(value: object, subs: dict[str, object]) -> object:
    """Replace {{NAME}} placeholders; a string that is exactly one placeholder takes the raw value."""
    if isinstance(value, dict):
        return {k: fill(v, subs) for k, v in value.items()}
    if isinstance(value, list):
        return [fill(v, subs) for v in value]
    if isinstance(value, str):
        whole = re.fullmatch(r"\{\{([A-Z0-9_]+)\}\}", value)
        if whole and whole.group(1) in subs:
            return subs[whole.group(1)]
        return re.sub(r"\{\{([A-Z0-9_]+)\}\}", lambda m: str(subs.get(m.group(1), m.group(0))), value)
    return value


def toml_str(value: str) -> str:
    return "'" + value.replace("\\", "/") + "'" if "'" not in value else json.dumps(value.replace("\\", "/"))


def dataset_toml(subsets: list[tuple[str, str]], repeats: int, ds: dict[str, int]) -> str:
    """One kohya [[datasets.subsets]] block per training folder: (image_dir, class_tokens)."""
    blocks: list[str] = []
    for image_dir, class_tokens in subsets:
        blocks += [
            "  [[datasets.subsets]]",
            f"  image_dir = {toml_str(image_dir)}",
            f"  class_tokens = {toml_str(class_tokens)}",
            f"  num_repeats = {repeats}",
            "",
        ]
    return "\n".join([
        "# kohya sd-scripts --dataset_config (generated by PersonaForge prepare_dataset.py)",
        "[general]",
        "shuffle_caption = false",
        "caption_extension = '.txt'",
        "keep_tokens = 1",
        "",
        "[[datasets]]",
        f"resolution = {ds['resolution']}",
        "batch_size = 1",
        "enable_bucket = true",
        f"min_bucket_reso = {ds['min_bucket_reso']}",
        f"max_bucket_reso = {ds['max_bucket_reso']}",
        "bucket_reso_steps = 64",
        "",
        *blocks,
    ])


def ps_quote(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def kohya_ps1(preset: dict, title: str) -> str:
    lines = [
        f"# {title} - generated by PersonaForge prepare_dataset.py",
        "# Usage: powershell -ExecutionPolicy Bypass -File <this file> -SdScripts C:\\path\\to\\sd-scripts",
        "param([Parameter(Mandatory = $true)][string]$SdScripts)",
        "$ErrorActionPreference = 'Stop'",
        "$accelerate = Join-Path $SdScripts 'venv\\Scripts\\accelerate.exe'",
        "if (-not (Test-Path $accelerate)) { $accelerate = 'accelerate' }",
        "Set-Location $SdScripts",
        "$launch = @(" + ", ".join(ps_quote(a) for a in preset["launch"][1:]) + ")",
        "$trainArgs = @(",
    ]
    for key, value in preset["args"].items():
        if value is False or value is None:
            continue
        if value is True:
            lines.append(f"  '--{key}'")
        elif isinstance(value, list):
            lines.append(f"  '--{key}', " + ", ".join(ps_quote(v) for v in value))
        else:
            lines.append(f"  '--{key}', {ps_quote(value)}")
    lines.append(")")
    lines.append(f"& $accelerate @launch {ps_quote(preset['script'])} @trainArgs")
    lines.append("exit $LASTEXITCODE")
    return "\n".join(lines) + "\n"


def find_model(roots: ModelRoots | None, category: str, names: list[str]) -> str | None:
    if roots is None:
        return None
    for name in names:
        for d in roots.dirs_for(category):
            if (d / name).is_file():
                return str(d / name)
    return None


# ----------------------------------------------------------------------------- main
def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Export approved dataset frames for OneTrainer / kohya_ss")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--manifest", type=Path)
    src.add_argument("--db", type=Path)
    ap.add_argument("--trigger", help="character trigger token (required with --db)")
    ap.add_argument("--class-word", default="woman")
    ap.add_argument("--data-dir", type=Path, default=PROJECT / "data", help="DATA_DIR for --db mode")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--repeats", type=int, default=10)
    ap.add_argument("--lora-dir", type=Path, help="where trained LoRAs are saved (default: ComfyUI models/loras)")
    ap.add_argument("--zip", action="store_true", help="also write <out>.zip")
    ap.add_argument("--cloud", action="store_true", help="write a cloud training bundle (ai-toolkit Flux 24/48/80 GB + kohya/OneTrainer SDXL) instead of local configs")
    ap.add_argument("--cloud-root", default="/workspace/personaforge", help="folder the bundle is unzipped into on the cloud machine")
    args = ap.parse_args(argv)

    try:
        if args.manifest:
            trigger, class_word, sdxl_ckpt, frames, custom_tokens = frames_from_manifest(args.manifest)
            trigger = trigger or (args.trigger or "")
        else:
            if not args.trigger:
                raise PrepareError("--trigger is required with --db")
            trigger, class_word = args.trigger, args.class_word
            sdxl_ckpt, frames, custom_tokens = frames_from_db(args.db, trigger, args.data_dir)
        if not TRIGGER_RE.match(trigger):
            raise PrepareError(f"trigger token '{trigger}' must be 3-40 letters, digits or underscores")
        if not re.fullmatch(r"[a-z ]{2,20}", class_word):
            raise PrepareError("class word must be plain lowercase words, e.g. 'woman'")
        if not 1 <= args.repeats <= 100:
            raise PrepareError("--repeats must be 1..100")
        if not frames:
            raise PrepareError("no approved dataset frames - approve frames in the Dataset Curator first")

        out = args.out.resolve()
        if out.exists():
            if not (out / "export.json").is_file():
                raise PrepareError(f"{out} exists and is not a previous PersonaForge export; refusing to overwrite")
            shutil.rmtree(out)
        class_tokens = f"{trigger} {class_word}"
        img_root = out / "img"
        img_root.mkdir(parents=True)
        # One training folder per bucket: "<repeats>_<sub-token> <class>" (general frames use the main trigger).
        folders: dict[str | None, Path] = {}

        def folder_for(bucket: str | None) -> Path:
            if bucket not in folders:
                token = sub_token_for(trigger, bucket, custom_tokens) or trigger
                folders[bucket] = img_root / f"{args.repeats}_{token} {class_word}"
                folders[bucket].mkdir(parents=True)
            return folders[bucket]

        warnings: list[str] = []
        seen: set[str] = set()
        written = 0
        per_bucket: dict[str, int] = {}
        for frame in frames:
            if not frame.image.is_file():
                warnings.append(f"missing image skipped: {frame.image.name}")
                continue
            digest = hashlib.sha256(frame.image.read_bytes()).hexdigest()
            if digest in seen:
                warnings.append(f"duplicate image skipped: {frame.image.name}")
                continue
            seen.add(digest)
            size = check_image(frame.image)
            if size and min(size) < MIN_SIDE:
                warnings.append(f"{frame.image.name} is only {size[0]}x{size[1]} (under {MIN_SIDE}px)")
            written += 1
            stem = f"{written:04d}"
            target_dir = folder_for(frame.bucket)
            shutil.copyfile(frame.image, target_dir / f"{stem}{frame.image.suffix.lower()}")
            sub = sub_token_for(trigger, frame.bucket, custom_tokens)
            write_lf(target_dir / f"{stem}.txt", make_caption(trigger, class_word, frame, sub) + "\n")
            per_bucket[frame.bucket or "general"] = per_bucket.get(frame.bucket or "general", 0) + 1
        if written == 0:
            raise PrepareError("none of the approved frames could be read")
        if written < 15:
            warnings.append(f"only {written} images - 25-40 varied frames give a much more stable character LoRA")
        if written > MAX_IMAGES:
            warnings.append(f"{written} images is over the {MAX_IMAGES}-image multi-bucket limit; trim the weakest frames")
        # Kept for single-folder callers (the README and summary name the main folder).
        img_dir = next(iter(folders.values()))
        multi_bucket = any(b is not None for b in folders)
        training_folders = [(d.as_posix(), f"{(sub_token_for(trigger, b, custom_tokens) or trigger)} {class_word}") for b, d in folders.items()]

        steps_per_epoch = written * args.repeats
        epochs_sdxl = max(1, math.ceil(TARGET_STEPS_SDXL / steps_per_epoch))
        epochs_flux = max(1, math.ceil(TARGET_STEPS_FLUX / steps_per_epoch))

        env = read_dotenv(PROJECT / ".env.local") or read_dotenv(PROJECT / ".env")
        try:
            comfy = resolve_comfy_dir(env, None)
            roots: ModelRoots | None = ModelRoots(comfy)
        except SystemExit:
            comfy, roots = None, None
            warnings.append("ComfyUI not found from COMFY_ROOT - model paths left as placeholders")
        lora_dir = (args.lora_dir or (comfy / "models" / "loras" if comfy else out / "output")).resolve()

        sdxl_names = [n for n in [sdxl_ckpt, "RealVisXL_V5.0_fp16.safetensors", "juggernautXL_v8Rundiffusion.safetensors"] if n]
        missing = "<set path: {}>"
        subs: dict[str, object] = {
            "TRIGGER": trigger,
            "OUTPUT_DIR": lora_dir.as_posix(),
            "SDXL_BASE": (find_model(roots, "checkpoints", sdxl_names) or missing.format("SDXL checkpoint .safetensors")).replace("\\", "/"),
            "FLUX_DEV": (find_model(roots, "diffusion_models", ["flux1-dev.safetensors", "flux1-dev.sft"]) or missing.format("flux1-dev.safetensors (full weights, not GGUF)")).replace("\\", "/"),
            "FLUX_BASE": "black-forest-labs/FLUX.1-dev",
            "CLIP_L": (find_model(roots, "text_encoders", ["clip_l.safetensors"]) or missing.format("clip_l.safetensors")).replace("\\", "/"),
            "T5XXL_FP8": (find_model(roots, "text_encoders", ["t5xxl_fp8_e4m3fn.safetensors"]) or missing.format("t5xxl_fp8_e4m3fn.safetensors")).replace("\\", "/"),
            "FLUX_AE": (find_model(roots, "vae", ["ae.safetensors"]) or missing.format("ae.safetensors")).replace("\\", "/"),
            "CONCEPTS_FILE": (out / "onetrainer" / "concepts.json").as_posix(),
        }
        unresolved = sorted({k for k, v in subs.items() if isinstance(v, str) and v.startswith("<set path")})
        if unresolved:
            warnings.append("set these paths before training: " + ", ".join(unresolved))

        # kohya sd-scripts
        kohya = out / "kohya"
        kohya.mkdir()
        rendered: dict[str, dict] = {}
        for name, preset_file, max_steps in (("sdxl", "kohya_sdxl_lora_8gb.json", TARGET_STEPS_SDXL), ("flux", "kohya_flux_lora_8gb.json", TARGET_STEPS_FLUX)):
            preset = json.loads((PRESETS / preset_file).read_text(encoding="utf-8"))
            toml_path = kohya / f"dataset_{name}.toml"
            toml_path.write_text(dataset_toml(training_folders, args.repeats, preset["dataset"]), encoding="utf-8")
            filled = fill(preset, {**subs, "DATASET_TOML": toml_path.as_posix(), "MAX_STEPS": max_steps})
            assert isinstance(filled, dict)
            rendered[name] = filled
            (kohya / f"train_{name}.json").write_text(json.dumps(filled, indent=2), encoding="utf-8")
            (kohya / f"train_{name}.ps1").write_text(kohya_ps1(filled, f"kohya {preset['script']} - {trigger}"), encoding="utf-8")

        # OneTrainer
        ot = out / "onetrainer"
        ot.mkdir()
        concepts = [{
            "__version": 2,
            "name": sub_token_for(trigger, bucket, custom_tokens) or trigger,
            "path": folder.as_posix(),
            "enabled": True,
            "type": "STANDARD",
            "include_subdirectories": False,
            "balancing": float(args.repeats),
            "balancing_strategy": "REPEATS",
            "text": {"prompt_source": "sample"},
        } for bucket, folder in folders.items()]
        (ot / "concepts.json").write_text(json.dumps(concepts, indent=2), encoding="utf-8")
        for target, preset_file, epochs in (("sdxl_lora.json", "onetrainer_sdxl_lora_8gb.json", epochs_sdxl), ("flux_lora_nf4.json", "onetrainer_flux_lora_8gb_nf4.json", epochs_flux)):
            preset = json.loads((PRESETS / preset_file).read_text(encoding="utf-8"))
            (ot / target).write_text(json.dumps(fill(preset, {**subs, "EPOCHS": epochs}), indent=2), encoding="utf-8")

        summary = {
            "trigger": trigger,
            "class_tokens": class_tokens,
            "images": written,
            "repeats": args.repeats,
            "steps_per_epoch": steps_per_epoch,
            "sdxl": {"max_train_steps": TARGET_STEPS_SDXL, "onetrainer_epochs": epochs_sdxl},
            "flux": {"max_train_steps": TARGET_STEPS_FLUX, "onetrainer_epochs": epochs_flux},
            "image_dir": img_dir.as_posix(),
            "lora_output_dir": lora_dir.as_posix(),
            "multi_bucket": multi_bucket,
            "buckets": per_bucket,
            "sub_tokens": {b: sub_token_for(trigger, b, custom_tokens) for b in BUCKETS if b in folders},
            "warnings": warnings,
        }
        if args.cloud:
            # The local configs carry this PC's absolute paths; the cloud bundle ships its own.
            shutil.rmtree(kohya)
            shutil.rmtree(ot)
            summary["warnings"] = [w for w in warnings if not w.startswith("set these paths")]
            write_cloud_bundle(out, summary, folders, custom_tokens, args)
        (out / "export.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        if not args.cloud:
            (out / "README.txt").write_text(readme(summary), encoding="utf-8")

        zip_path = None
        if args.zip:
            zip_path = out.parent / f"{out.name}.zip"
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for f in sorted(out.rglob("*")):
                    if f.is_file():
                        # Unix permissions in the zip, so `unzip` on the cloud machine keeps .sh files executable.
                        info = zipfile.ZipInfo.from_file(f, f.relative_to(out.parent).as_posix())
                        info.compress_type = zipfile.ZIP_DEFLATED
                        info.create_system = 3  # Unix, so unzip applies the mode bits below
                        info.external_attr = (0o100000 | (0o755 if f.suffix == ".sh" else 0o644)) << 16
                        zf.writestr(info, f.read_bytes())
        print(json.dumps({**summary, "out": out.as_posix(), "zip": zip_path.as_posix() if zip_path else None}))
        return 0
    except (PrepareError, OSError, sqlite3.Error, json.JSONDecodeError, KeyError) as exc:
        print(f"prepare_dataset: {exc}", file=sys.stderr)
        return 2


def write_lf(path: Path, text: str) -> None:
    """Write with Unix line endings (Path.write_text on Windows writes CRLF, which breaks bash: $'\\r': command not found)."""
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


RUN_TEMPLATE = Path(__file__).resolve().parent.parent / "training" / "run_cloud_training.template.sh"


def run_cloud_training_sh(trigger: str, root: str, local_loras: str) -> str:
    """Turnkey run_cloud_training.sh: free ComfyUI VRAM, train SDXL then Flux, collect the LoRAs, print the scp command."""
    dest = (local_loras or r"C:\path\to\ComfyUI_windows_portable\ComfyUI\models\loras").replace("/", "\\").rstrip("\\")
    # The path lands inside an unquoted bash heredoc and a double-quoted scp argument.
    dest = dest.replace("$", "\\$").replace("`", "\\`").replace('"', "")
    text = RUN_TEMPLATE.read_text(encoding="utf-8").replace("\r\n", "\n")
    return text.replace("@@TRIGGER@@", trigger).replace("@@ROOT@@", root).replace("@@LOCAL_LORAS@@", dest)


def yaml_str(value: str) -> str:
    return json.dumps(value)  # JSON strings are valid YAML double-quoted scalars


def ai_toolkit_yaml(tier: str, trigger: str, class_word: str, root: str, folder_paths: list[str], images: int) -> str:
    """ostris/ai-toolkit Flux.1-dev LoRA config (layout follows config/examples/train_lora_flux_24gb.yaml)."""
    quantize, batch = {"24gb": ("true", 1), "48gb": ("false", 2), "80gb": ("false", 4)}[tier]
    if tier in CLOUD_FULL_TIERS:
        rank, steps, save_every = CLOUD_RANK, CLOUD_STEPS, CLOUD_SAVE_EVERY
    else:  # 24 GB (8-bit base): unchanged v2.5 recipe
        rank = 16
        steps = max(1000, min(4000, round(images * 50 / batch)))
        save_every = 250 if steps >= 1000 else max(100, steps // 4)
    datasets = "\n".join(
        f"""        - folder_path: {yaml_str(p)}
          caption_ext: "txt"
          caption_dropout_rate: 0.05
          shuffle_tokens: false
          cache_latents_to_disk: true
          resolution: [ 512, 768, 1024 ]"""
        for p in folder_paths
    )
    prompts = "\n".join(f"          - {yaml_str(f'{trigger} {class_word}, {p}')}" for p in (
        "candid unretouched phone photo, sitting on a bed by a window, natural light",
        "mirror selfie in a bedroom, warm lamp light",
        "close-up portrait, natural skin texture, no makeup",
    ))
    return f"""---
# PersonaForge cloud bundle: Flux.1-dev character LoRA for a {tier.upper()} GPU (generated by prepare_dataset.py --cloud)
# Run from the ai-toolkit folder:  python run.py {root}/cloud/ai-toolkit_flux_{tier}.yaml
# FLUX.1-dev is gated on Hugging Face: accept the licence on its model page and export HF_TOKEN first.
job: extension
config:
  name: {yaml_str(f"{trigger}_flux_lora")}
  process:
    - type: 'sd_trainer'
      training_folder: {yaml_str(f"{root}/output")}
      device: cuda:0
      network:
        type: "lora"
        linear: {rank}
        linear_alpha: {rank}
      save:
        dtype: float16
        save_every: {save_every}
        max_step_saves_to_keep: {max(4, steps // save_every)}
        push_to_hub: false
      datasets:
{datasets}
      train:
        batch_size: {batch}
        steps: {steps}
        gradient_accumulation_steps: 1
        train_unet: true
        train_text_encoder: false
        gradient_checkpointing: true
        noise_scheduler: "flowmatch"
        optimizer: "adamw8bit"
        lr: 1e-4
        ema_config:
          use_ema: true
          ema_decay: 0.99
        dtype: bf16
      model:
        name_or_path: "black-forest-labs/FLUX.1-dev"
        is_flux: true
        quantize: {quantize}
      sample:
        sampler: "flowmatch"
        sample_every: 250
        sample_start_step: 0
        width: 1024
        height: 1024
        prompts:
{prompts}
        neg: ""
        seed: 42
        walk_seed: true
        guidance_scale: 4
        sample_steps: 20
meta:
  name: "[name]"
  version: '1.0'
"""


def kohya_sh(preset: dict, title: str) -> str:
    lines = ["#!/usr/bin/env bash", f"# {title} - generated by PersonaForge prepare_dataset.py --cloud",
             "# Usage: bash <this file> /path/to/sd-scripts", "set -euo pipefail", 'cd "${1:?pass the sd-scripts folder}"', "args=("]
    for key, value in preset["args"].items():
        if value is False or value is None:
            continue
        if value is True:
            lines.append(f"  --{key}")
        elif isinstance(value, list):
            lines.append(f"  --{key} " + " ".join(shlex.quote(str(v)) for v in value))
        else:
            lines.append(f"  --{key} {shlex.quote(str(value))}")
    lines += [")", "accelerate launch " + " ".join(preset["launch"][1:]) + f" {preset['script']} \"${{args[@]}}\"", ""]
    return "\n".join(lines)


def write_cloud_bundle(out: Path, summary: dict, folders: dict, custom_tokens: dict, args: argparse.Namespace) -> None:
    trigger, class_word = summary["trigger"], summary["class_tokens"].split(" ", 1)[1]
    images, repeats = summary["images"], summary["repeats"]
    root = f"{args.cloud_root.rstrip('/')}/{out.name}"
    cloud = out / "cloud"
    cloud.mkdir()
    cloud_folders = {b: f"{root}/img/{d.name}" for b, d in folders.items()}

    for tier in ("24gb", "48gb", "80gb"):
        write_lf(cloud / f"ai-toolkit_flux_{tier}.yaml", ai_toolkit_yaml(tier, trigger, class_word, root, list(cloud_folders.values()), images))

    sdxl_base = "/workspace/models/RealVisXL_V5.0_fp16.safetensors"
    samples = CLOUD_STEPS * 4  # 2000 steps at batch 4 (48 GB and 80 GB cards)
    subsets = [(p, f"{(sub_token_for(trigger, b, custom_tokens) or trigger)} {class_word}") for b, p in cloud_folders.items()]
    preset = json.loads((PRESETS / "kohya_sdxl_lora_8gb.json").read_text(encoding="utf-8"))
    write_lf(cloud / "dataset_sdxl.toml", dataset_toml(subsets, repeats, {"resolution": 1024, "min_bucket_reso": 640, "max_bucket_reso": 1536}))
    subs = {"TRIGGER": trigger, "OUTPUT_DIR": f"{root}/output", "SDXL_BASE": sdxl_base,
            "DATASET_TOML": f"{root}/cloud/dataset_sdxl.toml", "MAX_STEPS": samples // 4}
    filled = fill(preset, subs)
    assert isinstance(filled, dict)
    filled["args"]["train_batch_size"] = 4
    filled["args"]["save_every_n_steps"] = CLOUD_SAVE_EVERY
    filled["args"]["max_train_steps"] = CLOUD_STEPS
    filled["args"]["network_dim"] = CLOUD_RANK
    filled["args"]["network_alpha"] = CLOUD_RANK
    filled["args"]["learning_rate"] = 1e-4
    filled["args"]["mixed_precision"] = "bf16"
    filled["args"]["max_data_loader_n_workers"] = 4
    write_lf(cloud / "kohya_sdxl_train.json", json.dumps(filled, indent=2))
    write_lf(cloud / "kohya_sdxl_train.sh", kohya_sh(filled, f"kohya {preset['script']} - {trigger}"))

    ot_preset = json.loads((PRESETS / "onetrainer_sdxl_lora_8gb.json").read_text(encoding="utf-8"))
    epochs = max(1, math.ceil(samples / max(1, images * repeats)))
    ot_cfg = fill(ot_preset, {"TRIGGER": trigger, "OUTPUT_DIR": f"{root}/output", "SDXL_BASE": sdxl_base,
                              "CONCEPTS_FILE": f"{root}/cloud/onetrainer_concepts.json", "EPOCHS": epochs})
    assert isinstance(ot_cfg, dict)
    ot_cfg["batch_size"] = 4
    write_lf(cloud / "onetrainer_sdxl_lora.json", json.dumps(ot_cfg, indent=2))
    concepts = [{"__version": 2, "name": sub_token_for(trigger, b, custom_tokens) or trigger, "path": p, "enabled": True,
                 "type": "STANDARD", "include_subdirectories": False, "balancing": float(repeats),
                 "balancing_strategy": "REPEATS", "text": {"prompt_source": "sample"}} for b, p in cloud_folders.items()]
    write_lf(cloud / "onetrainer_concepts.json", json.dumps(concepts, indent=2))
    write_lf(out / "README_CLOUD.txt", cloud_readme(summary, root))
    run_sh = out / "run_cloud_training.sh"
    write_lf(run_sh, run_cloud_training_sh(trigger, root, summary.get("lora_output_dir") or ""))
    run_sh.chmod(0o755)


def cloud_readme(s: dict, root: str) -> str:
    tokens = "\n".join(f"  {b:6s} -> {t}   ({s['buckets'].get(b, 0)} images)" for b, t in s["sub_tokens"].items()) or "  (no bucket tags: single trigger)"
    return f"""PersonaForge CLOUD training bundle - {s['trigger']}
{'=' * 60}
{s['images']} images across buckets: {', '.join(f'{k}={v}' for k, v in s['buckets'].items())}
Every caption starts "{s['trigger']}, <bucket sub-token>, {s['class_tokens'].split(' ', 1)[1]}, ..." (untagged frames: "{s['trigger']}, {s['class_tokens'].split(' ', 1)[1]}, ...").
Sub-tokens:
{tokens}

Cloud settings (48 GB / 80 GB): rank 32, alpha 32, 2000 steps, a checkpoint every 250 steps, lr 1e-4, bf16.
(The 24 GB Flux config keeps the 8-bit rank-16 recipe.)

ONE COMMAND (after steps 1 and 2):
     export HF_TOKEN=<your read token>       # FLUX.1-dev is gated; or SKIP_FLUX=1
     bash {root}/run_cloud_training.sh
   It frees ComfyUI's VRAM (POST /free), trains the SDXL LoRA and then the Flux LoRA, copies the finished
   .safetensors into /workspace/ComfyUI/models/loras/ and /workspace/finished_loras/, and prints the scp
   command that brings them to your laptop. Steps 3-5 below are the same thing done by hand.

1. Unzip on the cloud machine so this folder exists:  {root}
     mkdir -p {root.rsplit('/', 1)[0]} && unzip <this zip> -d {root.rsplit('/', 1)[0]}
   (Unzipped somewhere else? run_cloud_training.sh rewrites the paths for you.)
2. Set up the machine once with scripts/vultr_cloud_setup.sh from the PersonaForge repo
   (it installs ai-toolkit in /workspace/ai-toolkit, kohya sd-scripts in /workspace/sd-scripts and
   downloads the SDXL base model to /workspace/models).
3. FLUX LoRA (full precision, ai-toolkit). Accept the FLUX.1-dev licence on Hugging Face, then:
     export HF_TOKEN=<your read token>
     cd /workspace/ai-toolkit && source venv/bin/activate
     python run.py {root}/cloud/ai-toolkit_flux_80gb.yaml      # A100 80 GB
     python run.py {root}/cloud/ai-toolkit_flux_48gb.yaml      # 48 GB cards (L40S, A6000)
     python run.py {root}/cloud/ai-toolkit_flux_24gb.yaml      # 24 GB cards (8-bit base)
4. SDXL LoRA (pick one):
     bash {root}/cloud/kohya_sdxl_train.sh /workspace/sd-scripts
     or OneTrainer: load {root}/cloud/onetrainer_sdxl_lora.json
5. Results are written to {root}/output/ . Copy the .safetensors file(s) back to this PC, into
   ComfyUI_windows_portable/ComfyUI/models/loras/ and press "Refresh Models" in the studio.
   Then set the file on the character (SDXL LoRA or Flux LoRA field).

Notes
- Use the main trigger "{s['trigger']}" in prompts. Add a sub-token (for example {next(iter(s['sub_tokens'].values()), s['trigger'] + '_body')}) to emphasise that kind of framing.
- Steps are starting points: watch the sample images ai-toolkit writes every 250 steps and keep the
  checkpoint that still follows prompts. Over-trained LoRAs look stiff.
- Stop the machine when you finish: cloud GPUs bill by the hour.

Warnings:
{chr(10).join('  - ' + w for w in s['warnings']) or '  none'}
"""


def readme(s: dict) -> str:
    return f"""PersonaForge character LoRA dataset - {s['trigger']}
{'=' * 60}
{s['images']} images x {s['repeats']} repeats = {s['steps_per_epoch']} steps per epoch (batch size 1).
Captions start with "{s['class_tokens']}" - use that phrase in prompts once the LoRA is trained.
Trained LoRAs are saved to: {s['lora_output_dir']}
(the studio lists them in the LoRA dropdowns after "Refresh Models").

Recipe A - SDXL character LoRA (recommended on 8 GB, ~25-40 min)
  OneTrainer: start OneTrainer -> top bar "Load config" -> onetrainer/sdxl_lora.json -> Start Training
              ({s['sdxl']['onetrainer_epochs']} epochs = ~{s['sdxl']['onetrainer_epochs'] * s['steps_per_epoch']} steps)
  kohya_ss :  powershell -ExecutionPolicy Bypass -File kohya/train_sdxl.ps1 -SdScripts C:\\path\\to\\sd-scripts
              ({s['sdxl']['max_train_steps']} steps)

Recipe B - Flux character LoRA (experimental on 8 GB VRAM / 16 GB RAM, several hours)
  OneTrainer: load onetrainer/flux_lora_nf4.json (NF4 transformer, 50% layer offload, 512px)
  kohya_ss :  kohya/train_flux.ps1 (fp8 base, --blocks_to_swap 28, 512px). Needs the full flux1-dev.safetensors.
  Until then, the studio's Cross-Engine SDXL Face Lock applies the SDXL LoRA to Flux renders.

Warnings:
{chr(10).join('  - ' + w for w in s['warnings']) or '  none'}

Full guide: docs/TRAINING.md in the PersonaForge repo.
"""


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

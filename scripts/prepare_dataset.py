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
MIN_SIDE = 512
TRIGGER_RE = re.compile(r"^[A-Za-z0-9_]{3,40}$")


class PrepareError(Exception):
    pass


@dataclass
class Frame:
    image: Path
    hint: str  # varying content: framing, angle, lighting, expression
    override: str  # manual caption from the Dataset Curator ("" = auto)


# ----------------------------------------------------------------------------- inputs
def frames_from_manifest(path: Path) -> tuple[str, str, str | None, list[Frame]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("items")
    if not isinstance(items, list):
        raise PrepareError("manifest needs an items array")
    frames = [Frame(Path(i["image"]), str(i.get("hint", "")), str(i.get("caption", ""))) for i in items]
    return str(data.get("trigger", "")), str(data.get("class_word", "woman")), data.get("sdxl_checkpoint"), frames


def frames_from_db(db: Path, trigger: str, data_dir: Path) -> tuple[str | None, list[Frame]]:
    if not db.is_file():
        raise PrepareError(f"database not found: {db}")
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        char = con.execute('SELECT id, sdxlCheckpoint FROM "Character" WHERE triggerToken = ?', (trigger,)).fetchone()
        if not char:
            raise PrepareError(f"no character with trigger token '{trigger}'")
        rows = con.execute(
            'SELECT a.path, a.caption, j.label FROM "Asset" a LEFT JOIN "Job" j ON a.jobId = j.id '
            "WHERE a.kind = 'dataset' AND a.approved = 1 AND a.characterId = ? ORDER BY a.createdAt",
            (char[0],),
        ).fetchall()
    finally:
        con.close()
    frames = [Frame(data_dir / p, label.split(": ", 1)[1] if label and ": " in label else "", caption or "") for p, caption, label in rows]
    return char[1], frames


# ----------------------------------------------------------------------------- captions
def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\n", " ")).strip(" ,")


def make_caption(trigger: str, class_word: str, frame: Frame) -> str:
    lead = f"{trigger} {class_word}"
    if frame.override.strip():
        body = clean(frame.override)
        return body if trigger in body else f"{lead}, {body}"
    hint = clean(frame.hint)
    return f"{lead}, {hint}" if hint else lead


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


def dataset_toml(image_dir: Path, class_tokens: str, repeats: int, ds: dict[str, int]) -> str:
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
        "  [[datasets.subsets]]",
        f"  image_dir = {toml_str(str(image_dir))}",
        f"  class_tokens = {toml_str(class_tokens)}",
        f"  num_repeats = {repeats}",
        "",
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
    args = ap.parse_args(argv)

    try:
        if args.manifest:
            trigger, class_word, sdxl_ckpt, frames = frames_from_manifest(args.manifest)
            trigger = trigger or (args.trigger or "")
        else:
            if not args.trigger:
                raise PrepareError("--trigger is required with --db")
            trigger, class_word = args.trigger, args.class_word
            sdxl_ckpt, frames = frames_from_db(args.db, trigger, args.data_dir)
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
        img_dir = out / "img" / f"{args.repeats}_{class_tokens}"
        img_dir.mkdir(parents=True)

        warnings: list[str] = []
        seen: set[str] = set()
        written = 0
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
            shutil.copyfile(frame.image, img_dir / f"{stem}{frame.image.suffix.lower()}")
            (img_dir / f"{stem}.txt").write_text(make_caption(trigger, class_word, frame) + "\n", encoding="utf-8")
        if written == 0:
            raise PrepareError("none of the approved frames could be read")
        if written < 15:
            warnings.append(f"only {written} images - 25-40 varied frames give a much more stable character LoRA")

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
            toml_path.write_text(dataset_toml(img_dir, class_tokens, args.repeats, preset["dataset"]), encoding="utf-8")
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
            "name": trigger,
            "path": img_dir.as_posix(),
            "enabled": True,
            "type": "STANDARD",
            "include_subdirectories": False,
            "balancing": float(args.repeats),
            "balancing_strategy": "REPEATS",
            "text": {"prompt_source": "sample"},
        }]
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
            "warnings": warnings,
        }
        (out / "export.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        (out / "README.txt").write_text(readme(summary), encoding="utf-8")

        zip_path = None
        if args.zip:
            zip_path = out.parent / f"{out.name}.zip"
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for f in sorted(out.rglob("*")):
                    if f.is_file():
                        zf.write(f, f.relative_to(out.parent).as_posix())
        print(json.dumps({**summary, "out": out.as_posix(), "zip": zip_path.as_posix() if zip_path else None}))
        return 0
    except (PrepareError, OSError, sqlite3.Error, json.JSONDecodeError, KeyError) as exc:
        print(f"prepare_dataset: {exc}", file=sys.stderr)
        return 2


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

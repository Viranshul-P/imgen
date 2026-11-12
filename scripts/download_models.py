#!/usr/bin/env python3
"""PersonaForge Phase 2 - free, resumable model downloader + local model scanner.

Usage (run with the ComfyUI embedded Python or any Python >= 3.10, stdlib only):
    python scripts/download_models.py --check-only
    python scripts/download_models.py --download-core [--yes]
    python scripts/download_models.py --custom-manifest custom_models.json [--yes]

What it does
  1. Inventories every model folder ComfyUI will search: the PersonaForge ComfyUI's own
     ``models/`` plus every ``base_path`` in ``extra_model_paths.yaml`` (shared installs).
  2. Skips any file that is already present under the same name in the same category.
  3. Checks free disk space and prints the total download size before starting.
  4. Downloads with HTTP Range resume (``<file>.part``), retries, and verifies SHA-256
     against the Hugging Face LFS object id when one is published.

Only free, public, ungated sources are used. HF_TOKEN / CIVITAI_TOKEN from .env.local are
optional and only sent to their own hosts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
USER_AGENT = "PersonaForge-model-downloader/1.0"
CHUNK = 4 * 1024 * 1024

# ComfyUI treats these folder names as aliases of one category.
CATEGORY_ALIASES: dict[str, tuple[str, ...]] = {
    "unet": ("unet", "diffusion_models"),
    "diffusion_models": ("unet", "diffusion_models"),
    "clip": ("clip", "text_encoders"),
    "text_encoders": ("clip", "text_encoders"),
}

SCAN_CATEGORIES = (
    "checkpoints", "unet", "diffusion_models", "clip", "text_encoders", "vae", "loras",
    "controlnet", "ipadapter", "clip_vision", "insightface", "ultralytics", "upscale_models",
    "sams", "segformer_b2_clothes", "segformer_b3_fashion",
)
MODEL_EXTS = {".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin", ".onnx"}


@dataclass
class Source:
    """One place a file can be fetched from. ``hf`` sources resolve sha256 via the HF API."""

    url: str
    hf_repo: str | None = None
    hf_path: str | None = None


@dataclass
class ModelSpec:
    name: str                 # final filename on disk
    category: str             # ComfyUI models/ sub-folder (may contain '/', e.g. ultralytics/bbox)
    sources: list[Source]
    group: str = "custom"
    size_hint: int | None = None
    sha256: str | None = None
    note: str = ""
    resolved_size: int | None = field(default=None, repr=False)


def hf(repo: str, path: str) -> Source:
    return Source(url=f"https://huggingface.co/{repo}/resolve/main/{path}", hf_repo=repo, hf_path=path)


# Spec section 6, Phase 2. Verified against the Hugging Face API on 2026-11-11.
CORE_MODELS: list[ModelSpec] = [
    # --- Engine A: Flux GGUF ---
    ModelSpec("flux1-dev-Q4_K_S.gguf", "unet", [hf("city96/FLUX.1-dev-gguf", "flux1-dev-Q4_K_S.gguf")], "flux"),
    # v2.5: Q3_K_S (2.1 GB) is the default T5 so Flux fits in 16 GB of system RAM without paging.
    ModelSpec("t5-v1_1-xxl-encoder-Q3_K_S.gguf", "text_encoders",
              [hf("city96/t5-v1_1-xxl-encoder-gguf", "t5-v1_1-xxl-encoder-Q3_K_S.gguf")], "flux",
              note="default Flux T5 (v2.5), ~2.1 GB"),
    ModelSpec("t5-v1_1-xxl-encoder-Q5_K_M.gguf", "text_encoders",
              [hf("city96/t5-v1_1-xxl-encoder-gguf", "t5-v1_1-xxl-encoder-Q5_K_M.gguf")], "flux",
              note="higher-quality T5 for machines with more RAM"),
    ModelSpec("clip_l.safetensors", "text_encoders", [hf("comfyanonymous/flux_text_encoders", "clip_l.safetensors")], "flux"),
    ModelSpec("ae.safetensors", "vae", [
        hf("black-forest-labs/FLUX.1-schnell", "ae.safetensors"),
        # BFL repo now requires login + licence acceptance; this ungated mirror has the
        # identical file (same LFS sha256 afc8e282...).
        hf("ffxvs/vae-flux", "ae.safetensors"),
    ], "flux", note="Flux VAE"),
    # --- Engine B/C: SDXL ---
    ModelSpec("sdxl_vae.safetensors", "vae", [hf("madebyollin/sdxl-vae-fp16-fix", "sdxl_vae.safetensors")], "sdxl",
              note="fp16-fix VAE (prevents black NaN tiles)"),
    ModelSpec("RealVisXL_V5.0_fp16.safetensors", "checkpoints",
              [hf("SG161222/RealVisXL_V5.0", "RealVisXL_V5.0_fp16.safetensors")], "sdxl"),
    # --- ControlNets ---
    ModelSpec("controlnet-openpose-sdxl-1.0.safetensors", "controlnet",
              [hf("xinsir/controlnet-openpose-sdxl-1.0", "diffusion_pytorch_model_twins.safetensors")], "controlnet",
              note="spec name '...twins' now published as '..._twins'"),
    ModelSpec("controlnet-depth-sdxl-1.0.safetensors", "controlnet",
              [hf("xinsir/controlnet-depth-sdxl-1.0", "diffusion_pytorch_model.safetensors")], "controlnet"),
    # --- Identity bootstrap ---
    ModelSpec("ip-adapter-faceid-plusv2_sdxl.bin", "ipadapter",
              [hf("h94/IP-Adapter-FaceID", "ip-adapter-faceid-plusv2_sdxl.bin")], "identity"),
    ModelSpec("ip-adapter-faceid-plusv2_sdxl_lora.safetensors", "loras",
              [hf("h94/IP-Adapter-FaceID", "ip-adapter-faceid-plusv2_sdxl_lora.safetensors")], "identity"),
    ModelSpec("CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors", "clip_vision",
              [hf("laion/CLIP-ViT-H-14-laion2B-s32B-b79K", "open_clip_model.safetensors")], "identity",
              note="real safetensors build (renaming the .bin pickle would not load)"),
    # --- Detectors ---
    ModelSpec("face_yolov8m.pt", "ultralytics/bbox", [hf("Bingsu/adetailer", "face_yolov8m.pt")], "detectors"),
    ModelSpec("hand_yolov8n.pt", "ultralytics/bbox", [hf("Bingsu/adetailer", "hand_yolov8n.pt")], "detectors"),
    # --- Realism LoRAs & upscalers ---
    ModelSpec("flux_realism_lora.safetensors", "loras", [hf("XLabs-AI/flux-RealismLora", "lora.safetensors")], "realism"),
    ModelSpec("flux_amateur_photography.safetensors", "loras", [
        hf("ujouy/Amateur_Photography_FluxDev", "amateurphoto-v6-forcu.safetensors"),
        hf("isaiahbjork/flux-amateur-photography-lora", "flux-amateur-photography-lora.safetensors"),
    ], "realism"),
    ModelSpec("4x-UltraSharp.pth", "upscale_models", [hf("Kim2091/UltraSharp", "4x-UltraSharp.pth")], "upscale"),
    ModelSpec("RealESRGAN_x2.pth", "upscale_models", [hf("ai-forever/Real-ESRGAN", "RealESRGAN_x2.pth")], "upscale"),
    # --- v2.5: automatic clothing segmentation (Comfyui_segformer_b2_clothes loads this folder at import) ---
    ModelSpec("config.json", "segformer_b2_clothes", [hf("mattmdjaga/segformer_b2_clothes", "config.json")], "segformer"),
    ModelSpec("preprocessor_config.json", "segformer_b2_clothes",
              [hf("mattmdjaga/segformer_b2_clothes", "preprocessor_config.json")], "segformer"),
    ModelSpec("model.safetensors", "segformer_b2_clothes",
              [hf("mattmdjaga/segformer_b2_clothes", "model.safetensors")], "segformer"),
    # The same pack also loads its fashion model at import time; ComfyUI skips the whole pack if this folder is missing.
    ModelSpec("config.json", "segformer_b3_fashion", [hf("sayeed99/segformer-b3-fashion", "config.json")], "segformer"),
    ModelSpec("preprocessor_config.json", "segformer_b3_fashion",
              [hf("sayeed99/segformer-b3-fashion", "preprocessor_config.json")], "segformer"),
    ModelSpec("model.safetensors", "segformer_b3_fashion",
              [hf("sayeed99/segformer-b3-fashion", "model.safetensors")], "segformer"),
]


# ----------------------------------------------------------------------------- config
def read_dotenv(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"')
    return env


def parse_extra_model_paths(yaml_path: Path) -> list[tuple[Path, dict[str, str]]]:
    """Minimal parser for ComfyUI's extra_model_paths.yaml (top-level sections of key: value)."""
    sections: list[tuple[Path, dict[str, str]]] = []
    if not yaml_path.exists():
        return sections
    current: dict[str, str] | None = None
    base: str | None = None
    for raw in yaml_path.read_text(encoding="utf-8-sig").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if not raw.startswith((" ", "\t")):
            if current is not None and base:
                sections.append((Path(base), current))
            current, base = {}, None
            continue
        if current is None or ":" not in raw:
            continue
        key, value = (part.strip() for part in raw.split(":", 1))
        if key == "base_path":
            base = value
        elif key not in ("is_default",):
            current[key] = value
    if current is not None and base:
        sections.append((Path(base), current))
    return sections


class ModelRoots:
    """All directories ComfyUI searches, per category."""

    def __init__(self, comfy_dir: Path):
        self.local_models = comfy_dir / "models"
        self.roots: dict[str, list[Path]] = {c: [self.local_models / c] for c in SCAN_CATEGORIES}
        for base, folders in parse_extra_model_paths(comfy_dir / "extra_model_paths.yaml"):
            for category, rel in folders.items():
                for path in rel.split("\n"):
                    self.roots.setdefault(category, []).append(base / path.strip())

    def dirs_for(self, category: str) -> list[Path]:
        top = category.split("/", 1)[0]
        rest = category.split("/", 1)[1] if "/" in category else ""
        dirs: list[Path] = []
        for alias in CATEGORY_ALIASES.get(top, (top,)):
            for root in self.roots.get(alias, []):
                dirs.append(root / rest if rest else root)
        return dirs

    def find(self, spec: ModelSpec) -> Path | None:
        for d in self.dirs_for(spec.category):
            candidate = d / spec.name
            if candidate.is_file() and candidate.stat().st_size > 0:
                return candidate
        return None

    def target(self, spec: ModelSpec) -> Path:
        return self.local_models / spec.category / spec.name


# ----------------------------------------------------------------------------- http
def auth_headers(url: str, env: dict[str, str]) -> dict[str, str]:
    host = urllib.parse.urlparse(url).hostname or ""
    headers = {"User-Agent": USER_AGENT}
    if host.endswith("huggingface.co") and env.get("HF_TOKEN"):
        headers["Authorization"] = f"Bearer {env['HF_TOKEN']}"
    if host.endswith("civitai.com") and env.get("CIVITAI_TOKEN"):
        headers["Authorization"] = f"Bearer {env['CIVITAI_TOKEN']}"
    return headers


def hf_file_meta(src: Source, env: dict[str, str]) -> tuple[int | None, str | None]:
    """Return (size, sha256) from the HF tree API, or (None, None)."""
    if not (src.hf_repo and src.hf_path):
        return None, None
    parent = src.hf_path.rsplit("/", 1)[0] if "/" in src.hf_path else ""
    api = f"https://huggingface.co/api/models/{src.hf_repo}/tree/main"
    if parent:
        api += "/" + urllib.parse.quote(parent)
    req = urllib.request.Request(api, headers=auth_headers(api, env))
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            entries = json.load(resp)
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return None, None
    for entry in entries if isinstance(entries, list) else []:
        if entry.get("path") == src.hf_path:
            lfs = entry.get("lfs") or {}
            return (lfs.get("size") or entry.get("size")), lfs.get("oid")
    return None, None


def probe(url: str, env: dict[str, str]) -> tuple[bool, int | None, str]:
    """HEAD-like probe (GET with Range 0-0, follows redirects). Returns (ok, total_size, detail)."""
    headers = auth_headers(url, env) | {"Range": "bytes=0-0"}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            total = None
            content_range = resp.headers.get("Content-Range", "")
            match = re.search(r"/(\d+)$", content_range)
            if match:
                total = int(match.group(1))
            elif resp.headers.get("Content-Length"):
                total = int(resp.headers["Content-Length"])
            return True, total, f"HTTP {resp.status}"
    except urllib.error.HTTPError as exc:
        return False, None, f"HTTP {exc.code}"
    except (urllib.error.URLError, TimeoutError) as exc:
        return False, None, f"network error: {exc}"


def human(n: int | float | None) -> str:
    if n is None:
        return "?"
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.2f} {unit}" if unit in ("GB", "TB") else f"{n:.0f} {unit}"
        n /= 1024
    return f"{n:.2f} TB"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, dest: Path, env: dict[str, str], expected_size: int | None, retries: int = 12) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    for attempt in range(1, retries + 1):
        have = part.stat().st_size if part.exists() else 0
        if expected_size and have >= expected_size:
            break
        headers = auth_headers(url, env)
        if have:
            headers["Range"] = f"bytes={have}-"
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                if have and resp.status != 206:
                    have = 0  # server ignored Range: restart cleanly
                total = expected_size
                if total is None and resp.headers.get("Content-Length"):
                    total = have + int(resp.headers["Content-Length"])
                mode = "ab" if have else "wb"
                start, done, last = time.time(), have, 0.0
                with part.open(mode) as fh:
                    while True:
                        block = resp.read(CHUNK)
                        if not block:
                            break
                        fh.write(block)
                        done += len(block)
                        now = time.time()
                        if now - last >= 2:
                            rate = (done - have) / max(now - start, 1e-6)
                            pct = f"{done / total * 100:5.1f}%" if total else "  ?  "
                            eta = f"{(total - done) / rate / 60:4.1f} min" if total and rate else "?"
                            print(f"\r    {pct}  {human(done)} / {human(total)}  {human(rate)}/s  ETA {eta}   ",
                                  end="", flush=True)
                            last = now
                print()
            if expected_size is None or part.stat().st_size >= expected_size:
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            # Back off up to 2 minutes so a Wi-Fi/DNS outage of several minutes is ridden out.
            wait = min(10 * attempt, 120)
            print(f"\n    attempt {attempt}/{retries} interrupted ({exc}); resuming in {wait}s")
            time.sleep(wait)
    else:
        raise RuntimeError(f"download failed after {retries} attempts: {url}")
    size = part.stat().st_size
    if expected_size and size != expected_size:
        raise RuntimeError(f"size mismatch for {dest.name}: got {size}, expected {expected_size}")
    os.replace(part, dest)


# ----------------------------------------------------------------------------- manifest
def load_custom_manifest(path: Path) -> list[ModelSpec]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, list):
        raise ValueError(f"{path} must contain a JSON array of {{name, url, target_dir}} objects")
    specs: list[ModelSpec] = []
    allowed = {"checkpoints", "loras", "unet", "diffusion_models", "vae", "controlnet", "upscale_models",
               "clip", "text_encoders", "clip_vision", "ipadapter", "embeddings"}
    for i, item in enumerate(data):
        name, url, target = item.get("name"), item.get("url"), item.get("target_dir")
        if not (name and url and target):
            raise ValueError(f"entry {i}: name, url and target_dir are required")
        if target not in allowed:
            raise ValueError(f"entry {i}: target_dir '{target}' not in {sorted(allowed)}")
        if Path(name).name != name or Path(name).suffix.lower() not in MODEL_EXTS:
            raise ValueError(f"entry {i}: name must be a plain filename ending in {sorted(MODEL_EXTS)}")
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https":
            raise ValueError(f"entry {i}: only https URLs are allowed")
        src = Source(url=url)
        m = re.match(r"^/([^/]+/[^/]+)/resolve/[^/]+/(.+)$", parsed.path)
        if parsed.hostname == "huggingface.co" and m:
            src = Source(url=url, hf_repo=m.group(1), hf_path=urllib.parse.unquote(m.group(2)))
        specs.append(ModelSpec(name, target, [src], "custom", sha256=item.get("sha256")))
    return specs


# ----------------------------------------------------------------------------- main flow
def resolve_comfy_dir(env: dict[str, str], override: str | None) -> Path:
    root = Path(override or env.get("COMFY_ROOT", ""))
    if (root / "ComfyUI" / "main.py").exists():
        return root / "ComfyUI"
    if (root / "main.py").exists():
        return root
    raise SystemExit(f"Cannot find ComfyUI under '{root}'. Set COMFY_ROOT in .env.local or pass --comfy-root.")


def inventory(roots: ModelRoots) -> None:
    print("== Local model inventory (all folders ComfyUI searches) ==")
    for category in SCAN_CATEGORIES:
        files: list[tuple[str, int]] = []
        for d in dict.fromkeys(roots.dirs_for(category)):
            if d.is_dir():
                for f in d.rglob("*"):
                    if f.is_file() and f.suffix.lower() in MODEL_EXTS:
                        files.append((str(f.relative_to(d)), f.stat().st_size))
        if files:
            print(f"  {category}:")
            for name, size in sorted(set(files)):
                print(f"    {human(size):>10}  {name}")


def plan(specs: list[ModelSpec], roots: ModelRoots, env: dict[str, str]) -> list[tuple[ModelSpec, Source]]:
    print("\n== Download plan ==")
    todo: list[tuple[ModelSpec, Source]] = []
    for spec in specs:
        existing = roots.find(spec)
        if existing:
            print(f"  [have]  {spec.name:<48} {human(existing.stat().st_size):>10}  ({existing.parent})")
            continue
        chosen: Source | None = None
        for src in spec.sources:
            ok, size, detail = probe(src.url, env)
            if ok:
                meta_size, meta_sha = hf_file_meta(src, env)
                spec.resolved_size = meta_size or size
                spec.sha256 = spec.sha256 or meta_sha
                chosen = src
                break
            print(f"  [skip-source] {src.url} -> {detail}")
        if chosen is None:
            print(f"  [FAIL]  {spec.name:<48} no reachable free source")
            continue
        origin = chosen.hf_repo or urllib.parse.urlparse(chosen.url).hostname
        print(f"  [get]   {spec.name:<48} {human(spec.resolved_size):>10}  <- {origin}  -> {spec.category}/")
        todo.append((spec, chosen))
    return todo


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check-only", action="store_true", help="inventory + plan, download nothing")
    mode.add_argument("--download-core", action="store_true", help="download the spec's core model set")
    mode.add_argument("--custom-manifest", metavar="JSON", help="download entries from a custom_models.json")
    parser.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    parser.add_argument("--comfy-root", help="override COMFY_ROOT from .env.local")
    parser.add_argument("--no-verify", action="store_true", help="skip SHA-256 verification")
    args = parser.parse_args()

    env = read_dotenv(REPO_ROOT / ".env.local") | {k: v for k, v in os.environ.items() if k in ("HF_TOKEN", "CIVITAI_TOKEN")}
    comfy_dir = resolve_comfy_dir(env, args.comfy_root)
    roots = ModelRoots(comfy_dir)
    print(f"ComfyUI: {comfy_dir}")
    inventory(roots)

    if args.custom_manifest:
        specs = load_custom_manifest(Path(args.custom_manifest))
    else:
        specs = CORE_MODELS
    todo = plan(specs, roots, env)

    total = sum(s.resolved_size or 0 for s, _ in todo)
    free = shutil.disk_usage(roots.local_models if roots.local_models.exists() else comfy_dir).free
    print(f"\nTotal to download: {human(total)} in {len(todo)} file(s); free disk: {human(free)}")
    if total and total + 2 * 1024**3 > free:
        print("Not enough free disk space (need download size + 2 GB headroom).")
        return 2
    if args.check_only or not todo:
        return 0
    if not args.yes:
        answer = input("Proceed with download? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Aborted.")
            return 1

    failures = 0
    for index, (spec, src) in enumerate(todo, 1):
        dest = roots.target(spec)
        print(f"\n[{index}/{len(todo)}] {spec.name}  ->  {dest}")
        try:
            download(src.url, dest, env, spec.resolved_size)
            if spec.sha256 and not args.no_verify:
                print("    verifying sha256 ...", end="", flush=True)
                actual = sha256_file(dest)
                if actual != spec.sha256:
                    dest.unlink()
                    raise RuntimeError(f"sha256 mismatch (got {actual[:16]}..., expected {spec.sha256[:16]}...)")
                print(" ok")
        except Exception as exc:  # report and continue with the remaining files
            failures += 1
            print(f"    FAILED: {exc}")
    print(f"\nDone: {len(todo) - failures} ok, {failures} failed.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

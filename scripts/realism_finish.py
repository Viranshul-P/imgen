#!/usr/bin/env python3
"""PersonaForge Phase 5 - Smartphone ISP visual finisher.

Turns a crisp diffusion render into something that reads like a casual, unedited phone photo
taken indoors. Purely visual: no EXIF/camera-model spoofing, metadata is left simple.

Pipeline (spec section 7):
  1. Tone curve + white balance + highlight bloom   (stage weight "tone")
  2. 0.5px micro-softening + corner vignette + radial chromatic aberration   ("lens")
  3. ISP unsharp mask: radius 1.1, amount 0.35, threshold 2   ("sharpen")
  4. Shadow-weighted luminance noise + low-frequency chroma noise   ("noise")
  5. Aspect crop to 1080x1350 (4:5) / 1080x1920 (9:16) and JPEG q92 4:2:0
  6. Presets: iphone_indoor_warm, iphone_mirror_selfie, iphone_flash_night,
     iphone_dim_bedroom_high_iso, iphone_daylight, raw_unfiltered

Every optical stage is scaled by the master --intensity (0..1) times its own stage weight (0..1).
The geometric crop/resize runs first so the pixel-scale radii (0.5px soften, 1.1px sharpen, grain
size) are exact at the delivered resolution; stage 5's JPEG encode is always the final step.

Run with ComfyUI's embedded Python in isolated mode (-I) so a user-site numpy cannot shadow it:
  python -I scripts/realism_finish.py data/raw/x.png --out-dir data/finished --preset iphone_indoor_warm
  python -I scripts/realism_finish.py --list-presets

Prints one JSON object on stdout: {"results": [...], "bundle": path|null}. Errors go to stderr.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

STAGES = ("tone", "lens", "sharpen", "noise")
SIZES = {"4:5": (1080, 1350), "9:16": (1080, 1920)}
JPEG_QUALITY = 92


@dataclass(frozen=True)
class Preset:
    description: str
    # Stage 1 - tone & white balance
    wb: tuple[float, float, float]  # R, G, B gains (luminance-normalised before use)
    contrast: float  # S-curve strength 0..0.5
    shadow_lift: float  # black level lift 0..0.06
    shoulder: float  # highlight roll-off knee (luma above this is compressed)
    saturation: float  # 1.0 = unchanged
    bloom_threshold: float
    bloom_strength: float
    bloom_tint: tuple[float, float, float]
    # Stage 2 - lens
    soften_px: float
    vignette: float  # corner darkening fraction (0.06-0.10)
    ca_px: float  # red/blue radial shift at the corners, in pixels
    # Stage 3 - ISP sharpening
    sharpen_radius: float
    sharpen_amount: float
    sharpen_threshold: float  # in 8-bit levels
    # Stage 4 - sensor noise
    luma_noise: float  # sigma in shadows (fraction of full scale, 0.018-0.030)
    chroma_noise: float  # sigma of low-frequency colour noise (0.004)
    # Stage-level defaults (multiplied with the user's per-stage weights)
    weights: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0)


PRESETS: dict[str, Preset] = {
    "iphone_indoor_warm": Preset(
        description="Warm tungsten room light, gentle contrast, mild grain",
        wb=(1.05, 1.0, 0.92), contrast=0.18, shadow_lift=0.025, shoulder=0.80, saturation=0.97,
        bloom_threshold=0.78, bloom_strength=0.18, bloom_tint=(1.0, 0.93, 0.82),
        soften_px=0.5, vignette=0.08, ca_px=0.5,
        sharpen_radius=1.1, sharpen_amount=0.35, sharpen_threshold=2,
        luma_noise=0.022, chroma_noise=0.004,
    ),
    "iphone_mirror_selfie": Preset(
        description="Mixed lamp + ambient light seen through a mirror, slightly flatter and softer",
        wb=(1.03, 1.0, 0.95), contrast=0.15, shadow_lift=0.03, shoulder=0.80, saturation=0.96,
        bloom_threshold=0.80, bloom_strength=0.14, bloom_tint=(1.0, 0.95, 0.88),
        soften_px=0.6, vignette=0.06, ca_px=0.5,
        sharpen_radius=1.1, sharpen_amount=0.35, sharpen_threshold=2,
        luma_noise=0.020, chroma_noise=0.004,
    ),
    "iphone_flash_night": Preset(
        description="Direct LED flash: cool cast, harsh contrast, specular skin highlights, strong falloff",
        wb=(0.97, 1.0, 1.04), contrast=0.28, shadow_lift=0.010, shoulder=0.76, saturation=1.02,
        bloom_threshold=0.72, bloom_strength=0.24, bloom_tint=(0.96, 0.98, 1.0),
        soften_px=0.5, vignette=0.10, ca_px=0.5,
        sharpen_radius=1.1, sharpen_amount=0.35, sharpen_threshold=2,
        luma_noise=0.026, chroma_noise=0.004,
    ),
    "iphone_dim_bedroom_high_iso": Preset(
        description="Dim bedside lamp at high ISO: warm, lifted milky shadows, heavy grain",
        wb=(1.06, 1.0, 0.89), contrast=0.12, shadow_lift=0.040, shoulder=0.78, saturation=0.92,
        bloom_threshold=0.75, bloom_strength=0.20, bloom_tint=(1.0, 0.90, 0.78),
        soften_px=0.6, vignette=0.10, ca_px=0.5,
        sharpen_radius=1.1, sharpen_amount=0.35, sharpen_threshold=2,
        luma_noise=0.030, chroma_noise=0.004,
    ),
    "iphone_daylight": Preset(
        description="Window daylight: neutral-cool balance, crisper contrast, fine low grain",
        wb=(0.99, 1.0, 1.01), contrast=0.20, shadow_lift=0.015, shoulder=0.84, saturation=1.03,
        bloom_threshold=0.85, bloom_strength=0.08, bloom_tint=(1.0, 1.0, 1.0),
        soften_px=0.5, vignette=0.06, ca_px=0.5,
        sharpen_radius=1.1, sharpen_amount=0.35, sharpen_threshold=2,
        luma_noise=0.018, chroma_noise=0.004,
    ),
    "raw_unfiltered": Preset(
        description="No optical processing - only the phone aspect crop and JPEG q92 4:2:0 encode",
        wb=(1.0, 1.0, 1.0), contrast=0.0, shadow_lift=0.0, shoulder=1.0, saturation=1.0,
        bloom_threshold=1.0, bloom_strength=0.0, bloom_tint=(1.0, 1.0, 1.0),
        soften_px=0.0, vignette=0.0, ca_px=0.0,
        sharpen_radius=1.1, sharpen_amount=0.0, sharpen_threshold=2,
        luma_noise=0.0, chroma_noise=0.0,
        weights=(0.0, 0.0, 0.0, 0.0),
    ),
}

LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)  # Rec.709 weights (RGB order)


class FinishError(Exception):
    pass


# ----------------------------------------------------------------------------- helpers
def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / max(edge1 - edge0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def luma(img: np.ndarray) -> np.ndarray:
    return img @ LUMA


def lerp(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    return a if t <= 0 else (b if t >= 1 else a + (b - a) * np.float32(t))


def gaussian(img: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return img
    return cv2.GaussianBlur(img, (0, 0), sigmaX=sigma, sigmaY=sigma, borderType=cv2.BORDER_REFLECT)


def radial_grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pixel-centre coordinates relative to the image centre and normalised radius (1.0 = corner)."""
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    dx, dy = xs - cx, ys - cy
    r = np.sqrt(dx * dx + dy * dy) / math.hypot(cx, cy)
    return dx, dy, r


# ----------------------------------------------------------------------------- stage 5a: geometry
def crop_to_phone(img: np.ndarray, size: str) -> np.ndarray:
    h, w = img.shape[:2]
    if size == "original":
        return img
    if size == "auto":
        ratio = w / h
        size = min(SIZES, key=lambda k: abs(math.log(ratio / (SIZES[k][0] / SIZES[k][1]))))
    tw, th = SIZES[size]
    scale = max(tw / w, th / h)  # cover, then centre-crop the overflow
    nw, nh = max(tw, round(w * scale)), max(th, round(h * scale))
    interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_LANCZOS4
    resized = cv2.resize(img, (nw, nh), interpolation=interp)
    x0, y0 = (nw - tw) // 2, (nh - th) // 2
    return np.clip(resized[y0 : y0 + th, x0 : x0 + tw], 0.0, 1.0)


# ----------------------------------------------------------------------------- stage 1: tone
def tone_lut(p: Preset) -> np.ndarray:
    x = np.linspace(0.0, 1.0, 4096, dtype=np.float32)
    a = min(max(p.contrast, 0.0), 0.95)
    y = x - a * np.sin(2.0 * np.pi * x) / (2.0 * np.pi)  # monotone S-curve (slope 1-a .. 1+a)
    y = p.shadow_lift + (1.0 - p.shadow_lift) * y  # lifted phone blacks
    k = p.shoulder
    if k < 1.0:  # smooth highlight shoulder: no hard clipping on lamps / skin speculars
        over = np.maximum(y - k, 0.0) / (1.0 - k)
        y = np.where(y > k, k + (1.0 - k) * np.tanh(over * 1.15) / np.tanh(1.15), y)
    return np.clip(y, 0.0, 1.0).astype(np.float32)


def stage_tone(img: np.ndarray, p: Preset, t: float) -> np.ndarray:
    if t <= 0:
        return img
    gains = np.array(p.wb, dtype=np.float32)
    gains /= float(gains @ LUMA)  # keep overall exposure; only shift the colour balance
    out = img * gains
    lut = tone_lut(p)
    out = lut[np.clip(out * 4095.0 + 0.5, 0, 4095).astype(np.int32)]
    if p.saturation != 1.0:
        y = luma(out)[..., None]
        out = y + (out - y) * np.float32(p.saturation)
    if p.bloom_strength > 0:
        y = luma(out)
        bright = out * smoothstep(p.bloom_threshold, 1.0, y)[..., None]
        sigma = 0.012 * math.hypot(*out.shape[:2])
        glow = gaussian(bright, sigma) * np.array(p.bloom_tint, dtype=np.float32)
        out = 1.0 - (1.0 - out) * (1.0 - np.float32(p.bloom_strength) * glow)  # screen blend
    return lerp(img, np.clip(out, 0.0, 1.0), t)


# ----------------------------------------------------------------------------- stage 2: lens
def stage_lens(img: np.ndarray, p: Preset, t: float) -> np.ndarray:
    if t <= 0:
        return img
    h, w = img.shape[:2]
    out = gaussian(img, p.soften_px)
    dx, dy, r = radial_grid(h, w)
    if p.ca_px > 0:
        # Red is magnified, blue shrunk: a shift of ca_px pixels at the corners, ~0 at the centre.
        corner = math.hypot((w - 1) / 2.0, (h - 1) / 2.0)
        cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
        for ch, sign in ((0, 1.0), (2, -1.0)):
            k = 1.0 - sign * p.ca_px / corner  # sample closer to centre for red => image grows
            map_x = (cx + dx * k).astype(np.float32)
            map_y = (cy + dy * k).astype(np.float32)
            out[..., ch] = cv2.remap(out[..., ch], map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    if p.vignette > 0:
        falloff = 1.0 - np.float32(p.vignette) * smoothstep(0.25, 1.0, r) ** 1.4
        out = out * falloff[..., None]
    return lerp(img, np.clip(out, 0.0, 1.0), t)


# ----------------------------------------------------------------------------- stage 3: sharpen
def stage_sharpen(img: np.ndarray, p: Preset, t: float) -> np.ndarray:
    amount = p.sharpen_amount * t
    if amount <= 0:
        return img
    y = luma(img)
    detail = y - gaussian(y, p.sharpen_radius)
    # Soft threshold (8-bit levels) so flat skin and smooth walls are not sharpened into mush.
    thr = p.sharpen_threshold / 255.0
    gate = smoothstep(thr * 0.5, thr * 1.5, np.abs(detail))
    return np.clip(img + (np.float32(amount) * detail * gate)[..., None], 0.0, 1.0)


# ----------------------------------------------------------------------------- stage 4: noise
def stage_noise(img: np.ndarray, p: Preset, t: float, rng: np.random.Generator) -> np.ndarray:
    if t <= 0 or (p.luma_noise <= 0 and p.chroma_noise <= 0):
        return img
    h, w = img.shape[:2]
    y = luma(img)
    # Strongest in shadows/midtones, ~35% in bright highlights (photon shot noise + read noise feel).
    weight = 1.0 - 0.65 * smoothstep(0.35, 0.95, y)
    out = img.copy()
    if p.luma_noise > 0:
        grain = rng.standard_normal((h, w), dtype=np.float32)
        grain = gaussian(grain, 0.55)  # demosaic correlation: grain is ~1.5px, not single-pixel salt
        grain /= max(float(grain.std()), 1e-6)
        out += (grain * weight * np.float32(p.luma_noise * t))[..., None]
    if p.chroma_noise > 0:
        sh, sw = max(2, h // 12), max(2, w // 12)
        cb, cr = (cv2.resize(rng.standard_normal((sh, sw), dtype=np.float32), (w, h), interpolation=cv2.INTER_CUBIC) for _ in range(2))
        cb /= max(float(cb.std()), 1e-6)
        cr /= max(float(cr.std()), 1e-6)
        s = np.float32(p.chroma_noise * t) * weight
        cb, cr = cb * s, cr * s
        out[..., 0] += 1.5748 * cr
        out[..., 1] -= 0.1873 * cb + 0.4681 * cr
        out[..., 2] += 1.8556 * cb
    return np.clip(out, 0.0, 1.0)


# ----------------------------------------------------------------------------- driver
def load_rgb(path: Path) -> np.ndarray:
    try:
        with Image.open(path) as im:
            im.load()
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
                im = Image.alpha_composite(bg, im)
            rgb = im.convert("RGB")
            return np.asarray(rgb, dtype=np.float32) / 255.0
    except (OSError, ValueError) as exc:
        raise FinishError(f"cannot read image {path}: {exc}") from exc


def seed_for(path: Path, preset: str, explicit: int | None) -> int:
    if explicit is not None:
        return explicit
    digest = hashlib.sha256(path.read_bytes() + preset.encode()).digest()
    return int.from_bytes(digest[:8], "little")


def finish_image(img: np.ndarray, p: Preset, intensity: float, weights: dict[str, float], size: str, seed: int) -> np.ndarray:
    eff = {name: max(0.0, min(1.0, intensity * weights[name] * p.weights[i])) for i, name in enumerate(STAGES)}
    out = crop_to_phone(img, size)
    out = stage_tone(out, p, eff["tone"])
    out = stage_lens(out, p, eff["lens"])
    out = stage_sharpen(out, p, eff["sharpen"])
    out = stage_noise(out, p, eff["noise"], np.random.default_rng(seed))
    return out


def save_jpeg(img: np.ndarray, path: Path, quality: int) -> None:
    data = np.clip(img * 255.0 + 0.5, 0, 255).astype(np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    # Plain JFIF: no EXIF, no camera spoofing, no PNG text chunks carried over.
    Image.fromarray(data, "RGB").save(tmp, "JPEG", quality=quality, subsampling=2, optimize=True)
    tmp.replace(path)


def parse_weights(text: str | None) -> dict[str, float]:
    weights = {name: 1.0 for name in STAGES}
    if not text:
        return weights
    for part in text.split(","):
        if not part.strip():
            continue
        key, sep, value = part.partition("=")
        key = key.strip()
        if not sep or key not in weights:
            raise FinishError(f"bad --weights entry '{part}'; expected one of {', '.join(STAGES)} as name=value")
        try:
            v = float(value)
        except ValueError as exc:
            raise FinishError(f"bad --weights value '{value}' for {key}") from exc
        if not 0.0 <= v <= 1.0:
            raise FinishError(f"--weights {key} must be between 0 and 1")
        weights[key] = v
    return weights


def build_bundle(bundle: Path, outputs: list[Path], settings: dict[str, object]) -> None:
    bundle.parent.mkdir(parents=True, exist_ok=True)
    tmp = bundle.with_name(bundle.name + ".tmp")
    used: set[str] = set()
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED) as zf:  # JPEGs are already compressed
        for out in outputs:
            name = out.name
            n = 1
            while name in used:
                name = f"{out.stem}_{n}{out.suffix}"
                n += 1
            used.add(name)
            zf.write(out, name)
        zf.writestr("finish_settings.json", json.dumps(settings, indent=2), compress_type=zipfile.ZIP_DEFLATED)
    tmp.replace(bundle)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="PersonaForge smartphone ISP finisher")
    ap.add_argument("inputs", nargs="*", type=Path, help="raw PNG/JPEG renders")
    ap.add_argument("--preset", default="iphone_indoor_warm", choices=sorted(PRESETS))
    ap.add_argument("--intensity", type=float, default=0.7, help="master intensity 0..1 (default 0.7)")
    ap.add_argument("--weights", help="per-stage weights 0..1, e.g. tone=1,lens=0.5,sharpen=1,noise=0.8")
    ap.add_argument("--size", default="auto", choices=["auto", "4:5", "9:16", "original"], help="auto picks the closer phone ratio")
    ap.add_argument("--quality", type=int, default=JPEG_QUALITY)
    ap.add_argument("--seed", type=int, help="noise seed (default: derived from the image bytes, so reruns are identical)")
    ap.add_argument("--out-dir", type=Path, help="directory for <stem>_<preset>.jpg outputs")
    ap.add_argument("--output", type=Path, help="exact output path (single input only)")
    ap.add_argument("--bundle", type=Path, help="also write a .zip with every output + finish_settings.json")
    ap.add_argument("--list-presets", action="store_true", help="print presets as JSON and exit")
    args = ap.parse_args(argv)

    if args.list_presets:
        print(json.dumps({name: asdict(p) for name, p in PRESETS.items()}, indent=2))
        return 0
    try:
        if not args.inputs:
            raise FinishError("no input images given")
        if not 0.0 <= args.intensity <= 1.0:
            raise FinishError("--intensity must be between 0 and 1")
        if not 1 <= args.quality <= 100:
            raise FinishError("--quality must be between 1 and 100")
        if args.output and len(args.inputs) != 1:
            raise FinishError("--output works with exactly one input; use --out-dir for several")
        if not args.output and not args.out_dir:
            raise FinishError("give --out-dir or --output")
        weights = parse_weights(args.weights)
        preset = PRESETS[args.preset]

        results: list[dict[str, object]] = []
        outputs: list[Path] = []
        for src in args.inputs:
            if not src.is_file():
                raise FinishError(f"input not found: {src}")
            started = time.perf_counter()
            dest = args.output or (args.out_dir / f"{src.stem}_{args.preset}.jpg")
            seed = seed_for(src, args.preset, args.seed)
            finished = finish_image(load_rgb(src), preset, args.intensity, weights, args.size, seed)
            save_jpeg(finished, dest, args.quality)
            outputs.append(dest)
            results.append({
                "input": str(src), "output": str(dest),
                "width": int(finished.shape[1]), "height": int(finished.shape[0]),
                "seed": seed, "ms": round((time.perf_counter() - started) * 1000),
            })

        settings = {"preset": args.preset, "intensity": args.intensity, "weights": weights, "size": args.size, "quality": args.quality, "chroma_subsampling": "4:2:0"}
        if args.bundle:
            build_bundle(args.bundle, outputs, settings)
        print(json.dumps({"results": results, "bundle": str(args.bundle) if args.bundle else None, "settings": settings}))
        return 0
    except FinishError as exc:
        print(f"realism_finish: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

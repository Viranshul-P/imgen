/**
 * Amateur Phone Camera Kits (spec section 3.2). Each kit carries a natural-prose version for
 * Flux and a descriptive tag version for SDXL, plus sensible engine/size/finisher defaults.
 */
import type { FinisherPreset } from "./types";

export interface SceneKit {
  id: string;
  label: string;
  /** Natural prose appended to Flux (Engine A) prompts. */
  flux: string;
  /** Comma-separated descriptive phrases appended to SDXL (Engine B/C) prompts. */
  sdxl: string;
  /** Extra negative phrases for SDXL. */
  negative: string;
  recommendedEngine: "A" | "B";
  /** Default canvas: 4:5 feed or 9:16 story. */
  aspect: "4:5" | "9:16";
  finisherPreset: FinisherPreset;
  /** Flux guidance suggestion (lower = flatter, more candid). */
  guidance: number;
}

export const SCENE_KITS: SceneKit[] = [
  {
    id: "mirror_selfie_bedroom",
    label: "Mirror selfie - bedroom",
    flux:
      "A casual mirror selfie in a full-length bedroom mirror, phone held in front of the chest, slightly off-center handheld framing. " +
      "Faint dust specks on the mirror glass, unmade rumpled bedsheets in the background, a phone charger cord on the nightstand. " +
      "Warm dim bedside lamp mixed with ambient room light, unretouched smartphone photo.",
    sdxl:
      "mirror selfie, full-length bedroom mirror, phone held at chest, off-center handheld framing, dust specks on mirror glass, " +
      "unmade rumpled bedsheets, phone charger cord on nightstand, warm dim bedside lamp, mixed ambient light, candid smartphone photo",
    negative: "studio backdrop, ring light, perfect symmetry",
    recommendedEngine: "A",
    aspect: "4:5",
    finisherPreset: "iphone_mirror_selfie",
    guidance: 2.6,
  },
  {
    id: "high_angle_bed_selfie",
    label: "High-angle bed selfie",
    flux:
      "A first-person handheld high-angle selfie looking down, one arm extended holding the phone just out of frame. " +
      "Wide-angle 24mm phone lens perspective with natural foreshortening, lying on messy cotton pillows. " +
      "Soft dim lamp glow with warm shadows, casual unposed expression, ordinary phone snapshot.",
    sdxl:
      "high angle selfie, pov arm extended, phone just out of frame, 24mm wide angle phone lens, foreshortening, lying on messy cotton pillows, " +
      "soft dim lamp glow, warm shadows, casual unposed expression, smartphone snapshot",
    negative: "professional photoshoot, posed, glamour lighting",
    recommendedEngine: "A",
    aspect: "4:5",
    finisherPreset: "iphone_dim_bedroom_high_iso",
    guidance: 2.4,
  },
  {
    id: "pov_down_angle_closeup",
    label: "POV down-angle close-up",
    flux:
      "A first-person point-of-view smartphone shot angled downward at close range, wide-angle phone focal distance, slight handheld tilt. " +
      "Natural indoor shadow falloff and authentic skin texture with visible pores and natural creases.",
    sdxl:
      "pov smartphone shot, angled downward, close-up framing, wide angle phone lens, slight handheld tilt, natural indoor shadow falloff, " +
      "authentic skin texture, visible pores, natural creases",
    negative: "smooth skin, beauty filter, airbrushed",
    recommendedEngine: "A",
    aspect: "4:5",
    finisherPreset: "iphone_indoor_warm",
    guidance: 2.5,
  },
  {
    id: "bathroom_vanity_mirror",
    label: "Bathroom vanity mirror",
    flux:
      "A bathroom mirror selfie under warm overhead vanity bulbs with slight highlight bloom on the skin. " +
      "A towel and a skincare bottle clutter the counter at the edge of the frame, candid phone camera colour balance.",
    sdxl:
      "bathroom mirror selfie, warm overhead vanity bulbs, slight highlight bloom on skin, towel and skincare bottle on counter at frame edge, " +
      "candid phone camera colour balance, everyday bathroom",
    negative: "luxury hotel, staged set, studio lighting",
    recommendedEngine: "A",
    aspect: "9:16",
    finisherPreset: "iphone_mirror_selfie",
    guidance: 2.7,
  },
  {
    id: "flash_night_bedroom",
    label: "Flash at night - bedroom",
    flux:
      "A late-night snapshot in a dim room lit only by the direct smartphone LED flash. The subject is bright in the foreground with rapid " +
      "shadow falloff against the bedroom wall and a natural specular flash reflection on the skin. Raw, unedited phone photo.",
    sdxl:
      "direct smartphone led flash, dim room at night, bright foreground subject, hard shadow on bedroom wall, rapid light falloff, " +
      "specular flash reflection on skin, raw late-night snapshot",
    negative: "softbox, cinematic lighting, golden hour",
    recommendedEngine: "A",
    aspect: "4:5",
    finisherPreset: "iphone_flash_night",
    guidance: 2.8,
  },
  {
    id: "couch_lounge_candid",
    label: "Couch lounge candid",
    flux:
      "Lounging on a fabric sofa with knees up, leaning back, ambient TV screen glow mixing with a warm floor lamp. " +
      "A casual handheld snapshot angle in a lived-in apartment with everyday clutter in the background.",
    sdxl:
      "lounging on fabric sofa, knees up, leaning back, ambient tv screen glow, warm floor lamp, casual handheld snapshot angle, " +
      "lived-in apartment, everyday clutter in background",
    negative: "showroom, catalog photo, staged interior",
    recommendedEngine: "B",
    aspect: "4:5",
    finisherPreset: "iphone_indoor_warm",
    guidance: 2.6,
  },
];

export function getSceneKit(id: string | undefined): SceneKit | undefined {
  return id ? SCENE_KITS.find((k) => k.id === id) : undefined;
}

/** Native phone canvases per engine (spec section 3.1). */
export const ASPECT_SIZES: Record<"A" | "B", Record<SceneKit["aspect"], { width: number; height: number }>> = {
  A: { "4:5": { width: 896, height: 1152 }, "9:16": { width: 768, height: 1344 } },
  B: { "4:5": { width: 832, height: 1216 }, "9:16": { width: 768, height: 1344 } },
};

export const SOCIAL_SIZES: Record<SceneKit["aspect"], { width: number; height: number }> = {
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
};

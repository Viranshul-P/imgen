/**
 * promptBuilder - composes engine-appropriate prompts: natural prose for Flux, descriptive
 * phrases for SDXL. Identity (trigger token + locked descriptors) always comes first.
 */
import { getSceneKit } from "./sceneKits";

/** Words that push models toward over-polished studio renders (spec section 3.2 soft warning). */
export const STUDIO_SHEEN_WORDS = [
  "masterpiece",
  "8k",
  "ultra detailed",
  "flawless skin",
  "airbrushed",
  "cinematic lighting",
  "studio lighting",
  "bokeh",
  "award winning",
] as const;

export const SDXL_BASE_NEGATIVE =
  "studio lighting, professional photoshoot, airbrushed, plastic skin, beauty filter, 3d render, cgi, illustration, " +
  "oversaturated, hdr, watermark, text, logo, deformed hands, extra fingers, lowres, jpeg artifacts";

export interface PromptCharacter {
  triggerToken: string;
  descriptors: string;
  negativePrompt?: string;
}

export interface PromptRequest {
  engine: "A" | "B" | "C";
  userPrompt: string;
  character?: PromptCharacter | null;
  sceneKitId?: string;
  extraNegative?: string;
}

export interface BuiltPrompt {
  positive: string;
  negative: string;
  sheenWords: string[];
}

/** Case-insensitive whole-phrase matches of studio-sheen words in a prompt. */
export function detectSheenWords(text: string): string[] {
  const lower = text.toLowerCase();
  return STUDIO_SHEEN_WORDS.filter((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/\s+/g, "\\s+")}([^a-z0-9]|$)`, "i").test(lower));
}

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function joinPhrases(parts: (string | undefined)[]): string {
  return parts
    .flatMap((p) => (p ?? "").split(","))
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p, i, all) => all.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i)
    .join(", ");
}

export function buildPrompt(req: PromptRequest): BuiltPrompt {
  const kit = getSceneKit(req.sceneKitId);
  const identity = req.character ? [req.character.triggerToken, req.character.descriptors].filter(Boolean).join(", ") : "";

  let positive: string;
  let negative: string;
  if (req.engine === "A") {
    // Flux: prose. The trigger token opens the first sentence so the Character LoRA binds early.
    positive = [sentence(identity ? `A photo of ${identity}` : ""), sentence(req.userPrompt), kit ? sentence(kit.flux) : ""]
      .filter(Boolean)
      .join(" ");
    // Flux runs at cfg 1 with FluxGuidance: negatives have no effect; keep them for the SDXL face-lock pass.
    negative = joinPhrases([SDXL_BASE_NEGATIVE, req.character?.negativePrompt, req.extraNegative]);
  } else {
    positive = joinPhrases([identity, req.userPrompt, kit?.sdxl]);
    negative = joinPhrases([SDXL_BASE_NEGATIVE, kit?.negative, req.character?.negativePrompt, req.extraNegative]);
  }
  return { positive, negative, sheenWords: detectSheenWords(`${req.userPrompt} ${identity}`) };
}

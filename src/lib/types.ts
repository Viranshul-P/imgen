/** Shared domain types and validated string unions (SQLite stores these as TEXT). */
import type { LoraSpec } from "./workflowInjector";

export const JOB_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Studio engines and the workflow template each one executes. */
export const ENGINE_TEMPLATES = {
  A: "engine_a_flux_lifestyle",
  B: "engine_b_sdxl_editorial",
  C: "engine_c_wardrobe_inpaint",
  GENESIS_FACE: "genesis_master_face_candidates",
  GENESIS_DATASET: "genesis_dataset",
  FACE_LOCK: "cross_engine_face_lock",
} as const;
export type StudioEngine = keyof typeof ENGINE_TEMPLATES;
export const STUDIO_ENGINES = Object.keys(ENGINE_TEMPLATES) as StudioEngine[];

export const ASSET_KINDS = ["raw", "finished", "dataset", "upload", "mask"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** Quality checklist flags offered in the Content Vault. */
export const QUALITY_FLAGS = ["hands_ok", "face_consistent", "no_ai_sheen", "background_lived_in", "ready_to_post"] as const;
export type QualityFlag = (typeof QUALITY_FLAGS)[number];

export const ARC_MODES = ["inpaint", "pose"] as const;
export type ArcMode = (typeof ARC_MODES)[number];

export const FINISHER_PRESETS = [
  "iphone_indoor_warm",
  "iphone_mirror_selfie",
  "iphone_flash_night",
  "iphone_dim_bedroom_high_iso",
  "iphone_daylight",
  "raw_unfiltered",
] as const;
export type FinisherPreset = (typeof FINISHER_PRESETS)[number];

/** Job-level options object from spec section 2.4 (plus the phone-look finisher toggle). */
export interface JobOptions {
  enableFaceDetailer: boolean;
  enableHandDetailer: boolean;
  enableCrossEngineFaceLock: boolean;
  /** ReActor is installed but deliberately not wired into PersonaForge graphs; true is rejected. */
  enableReactorSwap: boolean;
  enableUpscale: boolean;
  enablePhoneFinisher: boolean;
  finisherPreset: FinisherPreset;
  finisherIntensity: number;
}

export const DEFAULT_JOB_OPTIONS: JobOptions = {
  enableFaceDetailer: true,
  enableHandDetailer: false,
  enableCrossEngineFaceLock: false,
  enableReactorSwap: false,
  enableUpscale: false,
  enablePhoneFinisher: true,
  finisherPreset: "iphone_indoor_warm",
  finisherIntensity: 0.7,
};

/** Everything the worker needs to execute one job; stored as JSON text in Job.params. */
export interface JobParams {
  values: Record<string, string | number | boolean>;
  features: Record<string, boolean>;
  variants: Record<string, string>;
  loras: LoraSpec[];
  /** Placeholder -> DATA_DIR-relative image path; the worker uploads it and fills the placeholder. */
  inputs: Record<string, string>;
  options: JobOptions;
  sceneKit?: string;
}

export interface ArcStage {
  stage: number;
  prompt: string;
  checkpoint?: string;
  loras?: LoraSpec[];
  poseImagePath?: string;
  denoise?: number;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

export class BadRequestError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

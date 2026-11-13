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
/** v2.5 Reference Photo Structure Clone (SDXL; used instead of Engine B when a reference photo is supplied). */
export const STRUCTURE_CLONE_TEMPLATE = "engine_ab_structure_clone";
/** v2.6 Flux Structure Clone (Engine A): the reference photo is VAE-encoded and re-sampled at 0.72-0.82 denoise. */
export const FLUX_STRUCTURE_CLONE_TEMPLATE = "engine_a_structure_clone";
/** Engine A on a cloud GPU: native FP16 Flux instead of the 8 GB GGUF quantisation (Remote Cloud GPU mode only). */
export const ENGINE_A_NATIVE_TEMPLATE = "engine_a_flux_native";
export const STRUCTURE_MODES = ["hybrid", "newRoom"] as const;
export type StructureMode = (typeof STRUCTURE_MODES)[number];
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

/** Phone Look Finisher stages that take a 0..1 weight (stage 5 crop/JPEG and stage 6 presets are fixed). */
export const FINISHER_STAGES = ["tone", "lens", "sharpen", "noise"] as const;
export type FinisherStage = (typeof FINISHER_STAGES)[number];
export type FinisherWeights = Record<FinisherStage, number>;
export const DEFAULT_FINISHER_WEIGHTS: FinisherWeights = { tone: 1, lens: 1, sharpen: 1, noise: 1 };

/** auto = whichever of 4:5 (1080x1350) / 9:16 (1080x1920) is closer to the render. */
export const FINISHER_SIZES = ["auto", "4:5", "9:16"] as const;
export type FinisherSize = (typeof FINISHER_SIZES)[number];

/** Job-level options object from spec section 2.4 (plus the phone-look finisher toggle). */
export interface JobOptions {
  enableFaceDetailer: boolean;
  enableHandDetailer: boolean;
  enableCrossEngineFaceLock: boolean;
  /** Arbitrary ReActor face swaps (any uploaded face) stay disabled; true is rejected. */
  enableReactorSwap: boolean;
  /**
   * ReActor swap whose ONLY possible source is the fictional character's own AI-generated master_face.png,
   * read by the planner from the character record. Followed by FaceDetailer at 0.28 denoise.
   */
  enableReactorMasterFace: boolean;
  enableUpscale: boolean;
  /** Hi-res second pass (1.5x re-sample at low denoise) on Engines A/B - real detail, not just sharpening. */
  enableHiresFix: boolean;
  /** Detail Daemon sampler wrapper (Engines A/B): keeps natural micro-detail with no extra render time. */
  enableDetailDaemon: boolean;
  enablePhoneFinisher: boolean;
  finisherPreset: FinisherPreset;
  finisherIntensity: number;
}

export const DEFAULT_JOB_OPTIONS: JobOptions = {
  enableFaceDetailer: true,
  enableHandDetailer: false,
  enableCrossEngineFaceLock: false,
  enableReactorSwap: false,
  enableReactorMasterFace: false,
  enableUpscale: false,
  enableHiresFix: false,
  enableDetailDaemon: true,
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

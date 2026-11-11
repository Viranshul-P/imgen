/**
 * jobPlanner - converts Studio requests into Job rows. Every job is a single image
 * (batch_size 1); multi-candidate shoots become N jobs with consecutive seeds.
 */
import { randomInt } from "node:crypto";
import { buildPrompt } from "./promptBuilder";
import { ASPECT_SIZES, SOCIAL_SIZES, getSceneKit } from "./sceneKits";
import {
  BadRequestError,
  DEFAULT_JOB_OPTIONS,
  ENGINE_TEMPLATES,
  type JobOptions,
  type JobParams,
  type StudioEngine,
  parseJson,
} from "./types";
import { type LoraSpec, type WorkflowTemplate, loadTemplate } from "./workflowInjector";

export interface PlannerCharacter {
  id: string;
  triggerToken: string;
  descriptors: string;
  negativePrompt: string;
  masterFacePath: string | null;
  sdxlCheckpoint: string | null;
  sdxlLora: string | null;
  sdxlLoraWeight: number;
  fluxLora: string | null;
  fluxLoraWeight: number;
  defaultLoras: string;
}

export interface ShootRequest {
  engine: "A" | "B" | "C";
  characterId?: string | null;
  campaignId?: string | null;
  sceneKit?: string;
  prompt: string;
  negativePrompt?: string;
  checkpoint?: string;
  unet?: string;
  loras?: LoraSpec[];
  useCharacterLora?: boolean;
  candidateCount?: number;
  seed?: number;
  aspect?: "4:5" | "9:16";
  steps?: number;
  cfg?: number;
  guidance?: number;
  sampler?: string;
  scheduler?: string;
  options?: Partial<JobOptions>;
  control?: { imagePath: string; mode: "pose" | "depth"; strength?: number; end?: number };
  faceReferencePath?: string;
  inpaint?: { baseImagePath: string; maskPath: string; denoise?: number };
  stage?: number;
  arcId?: string;
  priority?: number;
  label?: string;
  /** Prompt tab: the prompt goes to the model verbatim; no scene kit, identity text or character LoRAs. */
  rawPrompt?: boolean;
}

/** Label prefix that marks Prompt-tab jobs (the tab lists its own history by it). */
export const RAW_PROMPT_LABEL = "Prompt";

export interface PlannedJob {
  template: string;
  engineKind: string;
  modelKey: string;
  params: string;
  label: string;
  priority: number;
  stage: number | null;
  arcId: string | null;
  characterId: string | null;
  campaignId: string | null;
  parentJobId?: string | null;
}

export const MAX_CANDIDATES = 20;
export const DATASET_SIZE = 35;

const FEATURE_FROM_OPTION: Record<string, keyof JobOptions> = {
  faceDetailer: "enableFaceDetailer",
  handDetailer: "enableHandDetailer",
  upscale: "enableUpscale",
  hiresFix: "enableHiresFix",
};

/** Hi-res second pass target: 1.5x the base render, snapped to a multiple of 16. */
export const HIRES_SCALE = 1.5;
function hiresSize(size: { width: number; height: number }): { width: number; height: number } {
  return { width: Math.round((size.width * HIRES_SCALE) / 16) * 16, height: Math.round((size.height * HIRES_SCALE) / 16) * 16 };
}

function setIf(t: WorkflowTemplate, values: JobParams["values"], key: string, value: string | number | boolean | undefined): void {
  if (value !== undefined && key in t.meta.placeholders) values[key] = value;
}

function mergeLoras(...lists: (LoraSpec[] | undefined)[]): LoraSpec[] {
  const out: LoraSpec[] = [];
  for (const list of lists) for (const l of list ?? []) if (l.name && !out.some((o) => o.name === l.name)) out.push(l);
  return out;
}

function characterLoras(character: PlannerCharacter | null, kind: "FLUX_GGUF" | "SDXL"): LoraSpec[] {
  if (!character) return [];
  const own =
    kind === "FLUX_GGUF"
      ? character.fluxLora
        ? [{ name: character.fluxLora, strengthModel: character.fluxLoraWeight }]
        : []
      : character.sdxlLora
        ? [{ name: character.sdxlLora, strengthModel: character.sdxlLoraWeight, strengthClip: character.sdxlLoraWeight }]
        : [];
  const defaults = parseJson<(LoraSpec & { engine?: string })[]>(character.defaultLoras, []).filter(
    (l) => !l.engine || (kind === "FLUX_GGUF" ? l.engine === "A" : l.engine !== "A"),
  );
  return mergeLoras(own, defaults);
}

function resolveOptions(partial: Partial<JobOptions> | undefined): JobOptions {
  const options = { ...DEFAULT_JOB_OPTIONS, ...(partial ?? {}) };
  if (options.enableReactorSwap) {
    throw new BadRequestError("ReActor face swap is not wired into PersonaForge workflows; identity comes from the Character LoRA and IP-Adapter FaceID.");
  }
  if (!(options.finisherIntensity >= 0 && options.finisherIntensity <= 1)) throw new BadRequestError("finisherIntensity must be between 0 and 1");
  return options;
}

function modelKeyFor(t: WorkflowTemplate, values: JobParams["values"]): string {
  const key = t.meta.engine === "FLUX_GGUF" ? "UNET_NAME" : "SDXL_CHECKPOINT_NAME";
  return String(values[key] ?? t.meta.placeholders[key]?.default ?? "");
}

function featuresFor(t: WorkflowTemplate, options: JobOptions, extra: Record<string, boolean>): Record<string, boolean> {
  const features: Record<string, boolean> = {};
  for (const name of Object.keys(t.meta.features)) {
    const opt = FEATURE_FROM_OPTION[name];
    if (opt) features[name] = Boolean(options[opt]);
    if (name in extra) features[name] = extra[name] as boolean;
  }
  return features;
}

function baseSeed(seed: number | undefined): number {
  return seed !== undefined && Number.isInteger(seed) && seed >= 0 ? seed : randomInt(0, 2 ** 31);
}

export async function planShoot(req: ShootRequest, character: PlannerCharacter | null): Promise<PlannedJob[]> {
  const engineKey: StudioEngine = req.engine;
  const template = await loadTemplate(ENGINE_TEMPLATES[engineKey]);
  const count = req.candidateCount ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_CANDIDATES) throw new BadRequestError(`candidateCount must be 1..${MAX_CANDIDATES}`);
  const raw = req.rawPrompt === true;
  if (raw) {
    if (req.engine === "C") throw new BadRequestError("the Prompt tab supports Engine A (Flux) and Engine B (SDXL)");
    if (!req.prompt?.trim()) throw new BadRequestError("type a prompt first");
    if (req.prompt.length > 4000) throw new BadRequestError("prompt is too long (max 4000 characters)");
  }
  if (!req.prompt?.trim() && !req.sceneKit) throw new BadRequestError("prompt or sceneKit is required");
  if (req.engine === "C" && !req.inpaint) throw new BadRequestError("Engine C needs a base stage image and a mask");
  if (req.sceneKit && !getSceneKit(req.sceneKit)) throw new BadRequestError(`unknown scene kit '${req.sceneKit}'`);

  const options = resolveOptions(req.options);
  const kit = raw ? undefined : getSceneKit(req.sceneKit);
  const built = buildPrompt({
    engine: req.engine,
    userPrompt: req.prompt ?? "",
    character: raw ? null : character,
    sceneKitId: raw ? undefined : req.sceneKit,
    extraNegative: req.negativePrompt,
    raw,
  });
  const aspect = req.aspect ?? kit?.aspect ?? "4:5";
  const size = ASPECT_SIZES[req.engine === "A" ? "A" : "B"][aspect];
  const social = SOCIAL_SIZES[aspect];

  const values: JobParams["values"] = {};
  setIf(template, values, "POSITIVE_PROMPT", built.positive);
  setIf(template, values, "NEGATIVE_PROMPT", built.negative);
  setIf(template, values, "WIDTH", size.width);
  setIf(template, values, "HEIGHT", size.height);
  const hires = hiresSize(size);
  setIf(template, values, "HIRES_WIDTH", hires.width);
  setIf(template, values, "HIRES_HEIGHT", hires.height);
  setIf(template, values, "OUTPUT_WIDTH", social.width);
  setIf(template, values, "OUTPUT_HEIGHT", social.height);
  setIf(template, values, "STEPS", req.steps);
  setIf(template, values, "CFG", req.cfg);
  setIf(template, values, "GUIDANCE", req.guidance ?? (req.engine === "A" ? kit?.guidance : undefined));
  setIf(template, values, "SAMPLER", req.sampler);
  setIf(template, values, "SCHEDULER", req.scheduler);
  setIf(template, values, "UNET_NAME", req.unet);
  setIf(template, values, "SDXL_CHECKPOINT_NAME", req.checkpoint ?? character?.sdxlCheckpoint ?? undefined);
  setIf(template, values, "POSE_STRENGTH", req.control?.strength);
  setIf(template, values, "CONTROL_END", req.control?.end);
  setIf(template, values, "INPAINT_DENOISE", req.inpaint?.denoise);
  setIf(template, values, "FILENAME_PREFIX", `personaforge/${template.meta.name}`);

  const inputs: Record<string, string> = {};
  if (req.control) inputs["CONTROL_IMAGE"] = req.control.imagePath;
  if (req.faceReferencePath) inputs["FACE_REFERENCE_IMAGE"] = req.faceReferencePath;
  if (req.inpaint) {
    inputs["BASE_STAGE_IMAGE"] = req.inpaint.baseImagePath;
    inputs["USER_MASK_IMAGE"] = req.inpaint.maskPath;
  }
  const features = featuresFor(template, options, { controlnet: Boolean(req.control), ipadapter: Boolean(req.faceReferencePath) });
  const variants: Record<string, string> = req.control && template.meta.variants?.["controlMode"] ? { controlMode: req.control.mode } : {};
  const loras = mergeLoras(raw || req.useCharacterLora === false ? [] : characterLoras(character, template.meta.engine), req.loras);

  const seed0 = baseSeed(req.seed);
  const jobs: PlannedJob[] = [];
  for (let i = 0; i < count; i++) {
    const v = { ...values };
    setIf(template, v, "SEED", (seed0 + i) % 2 ** 32);
    const params: JobParams = { values: v, features, variants, loras, inputs, options, sceneKit: req.sceneKit };
    jobs.push({
      template: template.meta.name,
      engineKind: template.meta.engine,
      modelKey: modelKeyFor(template, v),
      params: JSON.stringify(params),
      label: raw
        ? `${RAW_PROMPT_LABEL} · ${req.engine === "A" ? "Flux" : "SDXL"}${count > 1 ? ` #${i + 1}` : ""}: ${(req.prompt ?? "").trim().slice(0, 80)}`
        : (req.label ?? `${kit?.label ?? `Engine ${req.engine}`}${count > 1 ? ` #${i + 1}` : ""}`),
      priority: req.priority ?? 0,
      stage: req.stage ?? null,
      arcId: req.arcId ?? null,
      characterId: req.characterId ?? null,
      campaignId: req.campaignId ?? null,
    });
  }
  return jobs;
}

/** Genesis step 1: N front-facing amateur portrait candidates for a brand-new fictional character. */
export async function planMasterFaceCandidates(
  character: PlannerCharacter,
  count: number,
  options: { checkpoint?: string; seed?: number } = {},
): Promise<PlannedJob[]> {
  if (!Number.isInteger(count) || count < 1 || count > MAX_CANDIDATES) throw new BadRequestError(`count must be 1..${MAX_CANDIDATES}`);
  const template = await loadTemplate(ENGINE_TEMPLATES.GENESIS_FACE);
  const identity = [character.descriptors].filter(Boolean).join(", ");
  const positive = [
    "front-facing head and shoulders portrait of a fictional adult woman",
    identity,
    "looking straight at the camera, neutral relaxed expression, plain indoor wall, soft window light",
    "casual smartphone photo, natural skin texture with visible pores, no makeup look",
  ]
    .filter(Boolean)
    .join(", ");
  const negative = buildPrompt({ engine: "B", userPrompt: "", character }).negative + ", profile view, sunglasses, hands on face, multiple people";
  const seed0 = baseSeed(options.seed);
  const jobs: PlannedJob[] = [];
  for (let i = 0; i < count; i++) {
    const values: JobParams["values"] = {};
    setIf(template, values, "POSITIVE_PROMPT", positive);
    setIf(template, values, "NEGATIVE_PROMPT", negative);
    setIf(template, values, "SEED", (seed0 + i) % 2 ** 32);
    setIf(template, values, "SDXL_CHECKPOINT_NAME", options.checkpoint ?? character.sdxlCheckpoint ?? undefined);
    setIf(template, values, "FILENAME_PREFIX", `personaforge/genesis_face/${character.triggerToken}`);
    const params: JobParams = { values, features: { faceDetailer: true }, variants: {}, loras: [], inputs: {}, options: { ...DEFAULT_JOB_OPTIONS, enablePhoneFinisher: false } };
    jobs.push({
      template: template.meta.name,
      engineKind: template.meta.engine,
      modelKey: modelKeyFor(template, values),
      params: JSON.stringify(params),
      label: `Master face candidate #${i + 1}`,
      priority: 0,
      stage: null,
      arcId: null,
      characterId: character.id,
      campaignId: null,
    });
  }
  return jobs;
}

const DATASET_ANGLES = ["front view", "three-quarter view from the left", "three-quarter view from the right", "left profile", "right profile", "slightly high angle", "slightly low angle"];
const DATASET_LIGHTING = ["soft window daylight", "warm bedside lamp light", "overhead kitchen light", "direct phone flash at night", "overcast outdoor light"];
const DATASET_FRAMING = ["close-up portrait", "head and shoulders", "waist-up shot", "full body standing", "seated on a sofa"];
const DATASET_EXPRESSIONS = ["neutral expression", "soft smile", "laughing", "thoughtful look away from camera", "playful grin"];

/** The 35 varied prompts for the genesis dataset (angle x lighting x framing, deterministic). */
export function datasetVariations(count: number = DATASET_SIZE): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count; i++) {
    const angle = DATASET_ANGLES[i % DATASET_ANGLES.length] as string;
    const light = DATASET_LIGHTING[Math.floor(i / DATASET_ANGLES.length) % DATASET_LIGHTING.length] as string;
    const frame = DATASET_FRAMING[(i * 3) % DATASET_FRAMING.length] as string;
    const expr = DATASET_EXPRESSIONS[(i * 2 + 1) % DATASET_EXPRESSIONS.length] as string;
    out.push(`${frame}, ${angle}, ${light}, ${expr}`);
  }
  return out;
}

/** Genesis step 2: identity-locked varied frames via IP-Adapter FaceID Plus v2 from master_face.png. */
export async function planDatasetFrames(character: PlannerCharacter, count: number = DATASET_SIZE, seed?: number): Promise<PlannedJob[]> {
  if (!character.masterFacePath) throw new BadRequestError("select a master_face.png for this character first");
  if (!Number.isInteger(count) || count < 1 || count > 60) throw new BadRequestError("dataset size must be 1..60");
  const template = await loadTemplate(ENGINE_TEMPLATES.GENESIS_DATASET);
  const seed0 = baseSeed(seed);
  return datasetVariations(count).map((variation, i) => {
    const built = buildPrompt({
      engine: "B",
      userPrompt: `${variation}, everyday clothing, candid smartphone photo, natural skin texture`,
      character: { ...character, triggerToken: "" },
    });
    const values: JobParams["values"] = {};
    setIf(template, values, "POSITIVE_PROMPT", built.positive);
    setIf(template, values, "NEGATIVE_PROMPT", built.negative);
    setIf(template, values, "SEED", (seed0 + i) % 2 ** 32);
    setIf(template, values, "SDXL_CHECKPOINT_NAME", character.sdxlCheckpoint ?? undefined);
    setIf(template, values, "FILENAME_PREFIX", `personaforge/genesis_dataset/${character.triggerToken}`);
    const params: JobParams = {
      values,
      features: { faceDetailer: true },
      variants: {},
      loras: [],
      inputs: { MASTER_FACE_IMAGE: character.masterFacePath as string },
      options: { ...DEFAULT_JOB_OPTIONS, enablePhoneFinisher: false },
    };
    return {
      template: template.meta.name,
      engineKind: template.meta.engine,
      modelKey: modelKeyFor(template, values),
      params: JSON.stringify(params),
      label: `Dataset frame ${i + 1}/${count}: ${variation}`,
      priority: 0,
      stage: null,
      arcId: null,
      characterId: character.id,
      campaignId: null,
    };
  });
}

/** Cross-Engine Face Lock follow-up for a finished Engine A render (queued by the worker). */
export async function planFaceLock(
  parent: { id: string; priority: number; characterId: string | null; campaignId: string | null; stage: number | null; arcId: string | null; params: string },
  rawImagePath: string,
  character: PlannerCharacter | null,
): Promise<PlannedJob> {
  const template = await loadTemplate(ENGINE_TEMPLATES.FACE_LOCK);
  const parentParams = parseJson<JobParams | null>(parent.params, null);
  const built = buildPrompt({ engine: "B", userPrompt: "natural face, candid phone photo", character });
  const values: JobParams["values"] = {};
  setIf(template, values, "POSITIVE_PROMPT", built.positive);
  setIf(template, values, "NEGATIVE_PROMPT", built.negative);
  setIf(template, values, "SEED", Number(parentParams?.values["SEED"] ?? 0));
  setIf(template, values, "SDXL_CHECKPOINT_NAME", character?.sdxlCheckpoint ?? undefined);
  setIf(template, values, "FILENAME_PREFIX", "personaforge/face_lock");
  const params: JobParams = {
    values,
    features: {},
    variants: {},
    loras: characterLoras(character, "SDXL"),
    inputs: { INPUT_IMAGE: rawImagePath },
    options: { ...(parentParams?.options ?? DEFAULT_JOB_OPTIONS), enableCrossEngineFaceLock: false },
  };
  return {
    template: template.meta.name,
    engineKind: template.meta.engine,
    modelKey: modelKeyFor(template, values),
    params: JSON.stringify(params),
    label: "Cross-engine SDXL face lock",
    priority: parent.priority + 1,
    stage: parent.stage,
    arcId: parent.arcId,
    characterId: parent.characterId,
    campaignId: parent.campaignId,
    parentJobId: parent.id,
  };
}

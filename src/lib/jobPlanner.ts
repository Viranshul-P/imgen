/**
 * jobPlanner - converts Studio requests into Job rows. Every job is a single image
 * (batch_size 1); multi-candidate shoots become N jobs with consecutive seeds.
 */
import { randomInt } from "node:crypto";
import { assertMinorSafe } from "./contentSafety";
import { assertGeneratedMasterFace } from "./masterFace";
import { buildPrompt } from "./promptBuilder";
import { getComfyEndpoint } from "./comfyEndpoint";
import { ASPECT_SIZES, REMOTE_ASPECT_SIZES, SOCIAL_SIZES, getSceneKit } from "./sceneKits";
import {
  BadRequestError,
  DEFAULT_JOB_OPTIONS,
  ENGINE_A_NATIVE_TEMPLATE,
  ENGINE_TEMPLATES,
  FLUX_STRUCTURE_CLONE_TEMPLATE,
  STRUCTURE_CLONE_TEMPLATE,
  type StructureMode,
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
  /**
   * Reference Photo Structure Clone: copy a real photo's camera angle, posture and lighting.
   * Engine B (SDXL): hybrid = depth ControlNet + the photo as the img2img base (keeps the room light and slouch);
   * newRoom = empty latent guided by depth + OpenPose (same posture, brand-new room).
   * Engine A (Flux): hybrid only - the photo is VAE-encoded and re-sampled at 0.72-0.82 denoise with Detail Daemon.
   * roomPrompt describes the room; left blank in newRoom mode, the selected scene kit's room/lighting text is used.
   */
  structureClone?: {
    imagePath: string;
    mode: StructureMode;
    depthStrength?: number;
    poseStrength?: number;
    denoise?: number;
    roomPrompt?: string;
  };
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
/** ReActor master-face pass: the FaceDetailer that follows it runs at this denoise to blend the swap. */
export const REACTOR_FACE_DENOISE = 0.28;
export const REACTOR_VISIBILITY = 0.55;
/** True partial-strength swap: ImageBlend puts 60% of the ReActor result over 40% of the pre-swap render. */
export const REACTOR_BLEND = 0.6;
export const DATASET_SIZE = 35;

const FEATURE_FROM_OPTION: Record<string, keyof JobOptions> = {
  faceDetailer: "enableFaceDetailer",
  handDetailer: "enableHandDetailer",
  upscale: "enableUpscale",
  hiresFix: "enableHiresFix",
  detailDaemon: "enableDetailDaemon",
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
  const clone = req.structureClone;
  if (clone) {
    if (req.engine === "C") throw new BadRequestError("Structure Clone runs on Engine A (Flux) or Engine B (SDXL)");
    if (req.engine === "A" && clone.mode !== "hybrid") {
      throw new BadRequestError("New-Room mode needs the depth + OpenPose ControlNets, which are SDXL-only here; switch to Engine B or use Flux hybrid mode");
    }
    if (req.engine === "A" && req.unet && !/\.gguf$/i.test(req.unet)) throw new BadRequestError("Flux Structure Clone uses the GGUF UNet loader; pick a .gguf UNet");
    if (clone.roomPrompt !== undefined && (typeof clone.roomPrompt !== "string" || clone.roomPrompt.length > 1000)) {
      throw new BadRequestError("room description must be text of at most 1000 characters");
    }
    if (req.control) throw new BadRequestError("use either the pose/depth reference or the Structure Clone reference, not both");
    if (!clone.imagePath) throw new BadRequestError("Structure Clone needs a reference photo");
    if (clone.mode !== "hybrid" && clone.mode !== "newRoom") throw new BadRequestError("structure mode must be hybrid or newRoom");
    for (const [label, v, lo, hi] of [
      ["depth strength", clone.depthStrength, 0.1, 1],
      ["pose strength", clone.poseStrength, 0.1, 1],
      ["denoise", clone.denoise, 0.55, 0.92],
    ] as const) {
      if (v !== undefined && !(v >= lo && v <= hi)) throw new BadRequestError(`${label} must be between ${lo} and ${hi}`);
    }
  }
  // Remote Cloud GPU mode lifts the 8 GB limits: native FP16 Flux (any non-GGUF UNet) and larger renders.
  const remote = (await getComfyEndpoint()).remote;
  const nativeFlux = !clone && req.engine === "A" && Boolean(req.unet) && !/\.gguf$/i.test(req.unet ?? "");
  if (nativeFlux && !remote) throw new BadRequestError("native FP16 Flux needs Remote Cloud GPU mode (switch the endpoint in the header); on the laptop use a .gguf UNet");
  const template = await loadTemplate(
    clone
      ? req.engine === "A"
        ? FLUX_STRUCTURE_CLONE_TEMPLATE
        : STRUCTURE_CLONE_TEMPLATE
      : nativeFlux
        ? ENGINE_A_NATIVE_TEMPLATE
        : ENGINE_TEMPLATES[engineKey],
  );
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

  // ReActor runs only with the character's own generated master face (looked up here, never taken from the request).
  let masterFace: string | null = null;
  if (options.enableReactorMasterFace) {
    if (raw) throw new BadRequestError("the ReActor master-face swap needs a character; the Prompt tab has none");
    if (req.engine === "C") throw new BadRequestError("Engine C keeps the original face pixel-locked, so the ReActor master-face swap does not apply; turn it off for inpaint stages");
    if (!("reactorMasterFace" in template.meta.features)) throw new BadRequestError(`${template.meta.name} has no ReActor master-face pass`);
    if (!character) throw new BadRequestError("select a character to use the ReActor master-face swap");
    masterFace = await assertGeneratedMasterFace(character);
  }

  // Structure Clone room text: the user's room description, or in New-Room mode the kit's room/lighting
  // text when it is left blank. Hybrid mode keeps the photo's own room, so nothing is added by default.
  const typedRoom = clone?.roomPrompt?.trim() ?? "";
  const structureRoom = clone ? typedRoom || (clone.mode === "newRoom" && kit ? kit.room[req.engine === "A" ? "flux" : "sdxl"] : "") : undefined;
  const built = buildPrompt({
    engine: req.engine,
    userPrompt: req.prompt ?? "",
    character: raw ? null : character,
    sceneKitId: raw ? undefined : req.sceneKit,
    extraNegative: req.negativePrompt,
    raw,
    structureRoom,
  });
  assertMinorSafe(built.positive);
  const aspect = req.aspect ?? kit?.aspect ?? "4:5";
  const size = (remote ? REMOTE_ASPECT_SIZES : ASPECT_SIZES)[req.engine === "A" ? "A" : "B"][aspect];
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
  if (nativeFlux && !(clone)) setIf(template, values, "UNET_WEIGHT_DTYPE", "default");
  setIf(template, values, "SDXL_CHECKPOINT_NAME", req.checkpoint ?? character?.sdxlCheckpoint ?? undefined);
  setIf(template, values, "POSE_STRENGTH", clone ? (clone.poseStrength ?? 0.65) : req.control?.strength);
  if (clone) {
    setIf(template, values, "DEPTH_STRENGTH", clone.depthStrength ?? (clone.mode === "newRoom" ? 0.45 : 0.48));
    if (clone.mode === "hybrid") setIf(template, values, "DENOISE", clone.denoise ?? 0.77);
  }
  setIf(template, values, "CONTROL_END", req.control?.end);
  setIf(template, values, "INPAINT_DENOISE", req.inpaint?.denoise);
  if (masterFace) {
    setIf(template, values, "FACE_DENOISE", REACTOR_FACE_DENOISE);
    setIf(template, values, "REACTOR_VISIBILITY", REACTOR_VISIBILITY);
    setIf(template, values, "REACTOR_BLEND", REACTOR_BLEND);
  }
  setIf(template, values, "FILENAME_PREFIX", `personaforge/${template.meta.name}`);

  const inputs: Record<string, string> = {};
  if (req.control) inputs["CONTROL_IMAGE"] = req.control.imagePath;
  if (clone) inputs["STRUCTURE_REFERENCE_IMAGE"] = clone.imagePath;
  if (req.faceReferencePath) inputs["FACE_REFERENCE_IMAGE"] = req.faceReferencePath;
  if (masterFace) inputs["MASTER_FACE_IMAGE"] = masterFace;
  if (req.inpaint) {
    inputs["BASE_STAGE_IMAGE"] = req.inpaint.baseImagePath;
    inputs["USER_MASK_IMAGE"] = req.inpaint.maskPath;
  }
  const features = featuresFor(template, options, {
    controlnet: Boolean(req.control),
    ipadapter: Boolean(req.faceReferencePath),
    poseControl: clone?.mode === "newRoom",
    reactorMasterFace: Boolean(masterFace),
    // FaceDetailer always follows the swap (0.28 denoise) to blend the seam.
    ...(masterFace ? { faceDetailer: true } : {}),
  });
  const variants: Record<string, string> = clone
    ? template.meta.variants?.["structureMode"]
      ? { structureMode: clone.mode }
      : {}
    : req.control && template.meta.variants?.["controlMode"]
      ? { controlMode: req.control.mode }
      : {};
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
  assertMinorSafe(positive);
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
  assertMinorSafe(character.descriptors);
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
  assertMinorSafe(built.positive);
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

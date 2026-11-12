/**
 * modelDiscovery - every dropdown in the Studio is populated from the live ComfyUI schema,
 * so any .safetensors / .gguf dropped into models/ shows up after "Refresh Models".
 */
import { getComfyClient } from "./comfyEndpoint";
import { ComfyClient } from "./comfyClient";
import { type ObjectInfo, optionsFor } from "./comfySchema";

export interface ModelCatalog {
  fetchedAt: string;
  checkpoints: string[];
  loras: string[];
  unets: string[];
  /** Native (non-GGUF) Flux diffusion models, used by Engine A in Remote Cloud GPU mode. */
  nativeUnets: string[];
  textEncoders: string[];
  vaes: string[];
  controlnets: string[];
  upscalers: string[];
  detectors: string[];
  ipadapters: string[];
  clipVision: string[];
  samplers: string[];
  schedulers: string[];
}

const CACHE_TTL_MS = 60_000;
// One cache entry per ComfyUI endpoint, so switching between the laptop and a cloud GPU never mixes model lists.
const cache = new Map<string, { at: number; catalog: ModelCatalog; info: ObjectInfo }>();

export function catalogFromObjectInfo(info: ObjectInfo): ModelCatalog {
  const vaes = optionsFor(info, "VAELoader", "vae_name").filter((v) => !/^taes|^pixel_space$/.test(v));
  return {
    fetchedAt: new Date().toISOString(),
    checkpoints: optionsFor(info, "CheckpointLoaderSimple", "ckpt_name"),
    loras: optionsFor(info, "LoraLoader", "lora_name"),
    unets: optionsFor(info, "UnetLoaderGGUF", "unet_name"),
    nativeUnets: optionsFor(info, "UNETLoader", "unet_name"),
    textEncoders: optionsFor(info, "DualCLIPLoaderGGUF", "clip_name1"),
    vaes,
    controlnets: optionsFor(info, "ControlNetLoader", "control_net_name"),
    upscalers: optionsFor(info, "UpscaleModelLoader", "model_name"),
    detectors: optionsFor(info, "UltralyticsDetectorProvider", "model_name"),
    ipadapters: optionsFor(info, "IPAdapterModelLoader", "ipadapter_file"),
    clipVision: optionsFor(info, "CLIPVisionLoader", "clip_name"),
    samplers: optionsFor(info, "KSampler", "sampler_name"),
    schedulers: optionsFor(info, "KSampler", "scheduler"),
  };
}

async function load(refresh: boolean, client: ComfyClient | undefined): Promise<{ catalog: ModelCatalog; info: ObjectInfo }> {
  const comfy = client ?? (await getComfyClient());
  const hit = cache.get(comfy.baseUrl);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const info = await comfy.objectInfo();
  const fresh = { at: Date.now(), catalog: catalogFromObjectInfo(info), info };
  cache.set(comfy.baseUrl, fresh);
  return fresh;
}

/** Cached catalog; pass refresh=true to re-query /object_info immediately. */
export async function getModelCatalog(refresh = false, client?: ComfyClient): Promise<ModelCatalog> {
  return (await load(refresh, client)).catalog;
}

/** Cached raw schema for server-side prompt validation. */
export async function getObjectInfo(refresh = false, client?: ComfyClient): Promise<ObjectInfo> {
  return (await load(refresh, client)).info;
}

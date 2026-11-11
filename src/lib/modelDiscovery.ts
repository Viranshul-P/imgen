/**
 * modelDiscovery - every dropdown in the Studio is populated from the live ComfyUI schema,
 * so any .safetensors / .gguf dropped into models/ shows up after "Refresh Models".
 */
import { ComfyClient } from "./comfyClient";
import { type ObjectInfo, optionsFor } from "./comfySchema";

export interface ModelCatalog {
  fetchedAt: string;
  checkpoints: string[];
  loras: string[];
  unets: string[];
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
let cache: { at: number; catalog: ModelCatalog; info: ObjectInfo } | null = null;

export function catalogFromObjectInfo(info: ObjectInfo): ModelCatalog {
  const vaes = optionsFor(info, "VAELoader", "vae_name").filter((v) => !/^taes|^pixel_space$/.test(v));
  return {
    fetchedAt: new Date().toISOString(),
    checkpoints: optionsFor(info, "CheckpointLoaderSimple", "ckpt_name"),
    loras: optionsFor(info, "LoraLoader", "lora_name"),
    unets: optionsFor(info, "UnetLoaderGGUF", "unet_name"),
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

async function load(refresh: boolean, client: ComfyClient): Promise<{ catalog: ModelCatalog; info: ObjectInfo }> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  const info = await client.objectInfo();
  const fresh = { at: Date.now(), catalog: catalogFromObjectInfo(info), info };
  cache = fresh;
  return fresh;
}

/** Cached catalog; pass refresh=true to re-query /object_info immediately. */
export async function getModelCatalog(refresh = false, client: ComfyClient = new ComfyClient()): Promise<ModelCatalog> {
  return (await load(refresh, client)).catalog;
}

/** Cached raw schema for server-side prompt validation. */
export async function getObjectInfo(refresh = false, client: ComfyClient = new ComfyClient()): Promise<ObjectInfo> {
  return (await load(refresh, client)).info;
}

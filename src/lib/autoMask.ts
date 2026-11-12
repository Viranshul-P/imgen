/**
 * Automatic clothing masks (SegFormer B2 clothes, runs on the CPU inside ComfyUI).
 * Used by POST /api/comfy/auto-mask and the "1-Click Auto-Mask Outfit" toolbars.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AUTO_MASK_CATEGORIES, AUTO_MASK_LABELS, type AutoMaskCategory } from "./autoMaskShared";
import { ComfyClient } from "./comfyClient";
import { getComfyClient } from "./comfyEndpoint";
import { validatePrompt } from "./comfySchema";
import { getObjectInfo } from "./modelDiscovery";
import { ensureDataDirs, resolveDataPath, toDataRelative } from "./paths";
import { maskCoverage, readPngSize } from "./png";
import { prisma } from "./prisma";
import { BadRequestError } from "./types";
import { injectWorkflow, loadTemplate } from "./workflowInjector";

export { AUTO_MASK_CATEGORIES, AUTO_MASK_LABELS, type AutoMaskCategory };

const PLACEHOLDER: Record<AutoMaskCategory, string> = {
  upper: "SEG_UPPER_CLOTHES",
  skirt: "SEG_SKIRT",
  pants: "SEG_PANTS",
  dress: "SEG_DRESS",
  belt: "SEG_BELT",
  scarf: "SEG_SCARF",
};

export interface AutoMaskRequest {
  /** DATA_DIR-relative path of the frame to mask. */
  imagePath: string;
  categories: AutoMaskCategory[];
  /** Extra pixels to grow the mask by (0..64). */
  grow?: number;
  characterId?: string | null;
  campaignId?: string | null;
}

export interface AutoMaskResult {
  id: string;
  path: string;
  width: number | null;
  height: number | null;
  /** Share of the frame covered by the mask, 0..1. */
  coverage: number;
}

export async function runAutoMask(req: AutoMaskRequest, givenClient?: ComfyClient): Promise<AutoMaskResult> {
  const client = givenClient ?? (await getComfyClient());
  const categories = [...new Set(req.categories ?? [])];
  if (categories.length === 0) throw new BadRequestError("pick at least one garment to mask");
  for (const c of categories) {
    if (!(AUTO_MASK_CATEGORIES as readonly string[]).includes(c)) throw new BadRequestError(`unknown garment '${String(c)}'`);
  }
  const grow = req.grow ?? 0;
  if (!Number.isInteger(grow) || grow < 0 || grow > 64) throw new BadRequestError("grow must be a whole number between 0 and 64");
  if (!req.imagePath) throw new BadRequestError("imagePath is required");

  const source = await readFile(resolveDataPath(req.imagePath)).catch(() => {
    throw new BadRequestError("image not found");
  });
  const uploaded = await client.uploadImage(new Uint8Array(source), `pf_automask_${randomUUID()}${path.extname(req.imagePath) || ".png"}`);

  // The segformer node's toggles are inverted: false means "this garment goes into the mask".
  const values: Record<string, string | number | boolean> = { AUTOMASK_IMAGE: uploaded, MASK_GROW: grow };
  for (const c of AUTO_MASK_CATEGORIES) values[PLACEHOLDER[c]] = !categories.includes(c);

  const template = await loadTemplate("auto_mask_clothes");
  const prompt = injectWorkflow(template, { values });
  let errors = validatePrompt(prompt, await getObjectInfo(false, client)).filter((i) => i.level === "error");
  // The cached /object_info does not list the file we just uploaded; re-read it once before giving up.
  if (errors.length) errors = validatePrompt(prompt, await getObjectInfo(true, client)).filter((i) => i.level === "error");
  if (errors.length) {
    throw new BadRequestError(`auto-mask workflow is not valid on this ComfyUI: ${errors[0]?.message ?? "unknown"} (is the segformer node installed?)`);
  }
  const result = await client.run(prompt, { timeoutMs: 5 * 60_000 });
  const image = result.images[0];
  if (!image) throw new Error("auto-mask finished without an image");
  const bytes = await client.downloadImage(image);

  await ensureDataDirs();
  const full = resolveDataPath(path.join("masks", `${randomUUID()}.png`));
  await writeFile(full, bytes);
  const size = readPngSize(bytes);
  const asset = await prisma.asset.create({
    data: {
      kind: "mask",
      path: toDataRelative(full),
      width: size?.width ?? null,
      height: size?.height ?? null,
      characterId: req.characterId ?? null,
      campaignId: req.campaignId ?? null,
    },
  });
  return { id: asset.id, path: asset.path, width: asset.width, height: asset.height, coverage: maskCoverage(bytes) };
}

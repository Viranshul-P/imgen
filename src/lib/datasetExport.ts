/** Phase 6: export a character's approved dataset frames for local LoRA training (scripts/prepare_dataset.py). */
import { mkdir, writeFile } from "node:fs/promises";
import { MAX_TRAINING_IMAGES, parseSubTokens } from "./buckets";
import { prisma } from "./prisma";
import { resolveDataPath, safeFileStem, toDataRelative } from "./paths";
import { runPythonJson } from "./python";
import { BadRequestError } from "./types";

export interface DatasetExportResult {
  trigger: string;
  class_tokens: string;
  images: number;
  repeats: number;
  steps_per_epoch: number;
  sdxl: { max_train_steps: number; onetrainer_epochs: number };
  flux: { max_train_steps: number; onetrainer_epochs: number };
  lora_output_dir: string;
  /** Images per bucket (face / body / chest / lower / general) and the sub-token used for each bucket. */
  buckets: Record<string, number>;
  sub_tokens: Record<string, string>;
  warnings: string[];
  /** DATA_DIR-relative export folder and zip. */
  folder: string;
  zip: string | null;
  zipUrl: string | null;
}

/**
 * Export approved frames. With `cloud: true` the result is a cloud training bundle (ai-toolkit Flux 24/48/80 GB
 * configs + kohya/OneTrainer SDXL configs with cloud paths) instead of the local OneTrainer/kohya folder.
 */
export async function exportDataset(characterId: string, repeats = 10, classWord = "woman", cloud = false): Promise<DatasetExportResult> {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) throw new BadRequestError("repeats must be 1..100");
  if (!/^[a-z ]{2,20}$/.test(classWord)) throw new BadRequestError("class word must be plain lowercase words, e.g. 'woman'");
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character) throw new BadRequestError("character not found");
  const frames = await prisma.asset.findMany({
    where: { kind: "dataset", characterId, approved: true },
    orderBy: { createdAt: "asc" },
    include: { job: { select: { label: true } } },
  });
  if (frames.length === 0) throw new BadRequestError("approve some dataset frames first (tick them in the Dataset Curator)");
  if (frames.length > MAX_TRAINING_IMAGES) {
    throw new BadRequestError(`${frames.length} frames are approved; a training set holds at most ${MAX_TRAINING_IMAGES}. Un-approve the weakest ${frames.length - MAX_TRAINING_IMAGES}.`);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  const name = `${safeFileStem(character.triggerToken)}_${cloud ? "cloud_" : ""}${stamp}`;
  const baseDir = resolveDataPath("exports/datasets");
  await mkdir(baseDir, { recursive: true });
  const manifestPath = resolveDataPath(`exports/datasets/${name}.manifest.json`);
  const manifest = {
    trigger: character.triggerToken,
    class_word: classWord,
    sdxl_checkpoint: character.sdxlCheckpoint,
    sub_tokens: parseSubTokens(character.subTokens),
    items: frames.map((f) => ({
      bucket: f.bucket,
      image: resolveDataPath(f.path),
      // Job labels look like "Dataset frame 3/35: <framing, angle, lighting, expression>".
      hint: f.job?.label.includes(": ") ? f.job.label.slice(f.job.label.indexOf(": ") + 2) : "",
      caption: f.caption,
    })),
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const out = resolveDataPath(`exports/datasets/${name}`);
  const result = await runPythonJson<Omit<DatasetExportResult, "folder" | "zip" | "zipUrl"> & { out: string; zip: string | null }>("prepare_dataset.py", [
    "--manifest",
    manifestPath,
    "--out",
    out,
    "--repeats",
    String(repeats),
    "--zip",
    ...(cloud ? ["--cloud"] : []),
  ]);
  const zip = result.zip ? toDataRelative(result.zip) : null;
  return {
    trigger: result.trigger,
    class_tokens: result.class_tokens,
    images: result.images,
    repeats: result.repeats,
    steps_per_epoch: result.steps_per_epoch,
    sdxl: result.sdxl,
    flux: result.flux,
    lora_output_dir: result.lora_output_dir,
    buckets: result.buckets ?? {},
    sub_tokens: result.sub_tokens ?? {},
    warnings: result.warnings,
    folder: toDataRelative(result.out),
    zip,
    zipUrl: zip ? `/api/files/${zip}` : null,
  };
}

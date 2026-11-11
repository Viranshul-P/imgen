/** Phase 6: export a character's approved dataset frames for local LoRA training (scripts/prepare_dataset.py). */
import { mkdir, writeFile } from "node:fs/promises";
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
  warnings: string[];
  /** DATA_DIR-relative export folder and zip. */
  folder: string;
  zip: string | null;
  zipUrl: string | null;
}

export async function exportDataset(characterId: string, repeats = 10, classWord = "woman"): Promise<DatasetExportResult> {
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

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  const name = `${safeFileStem(character.triggerToken)}_${stamp}`;
  const baseDir = resolveDataPath("exports/datasets");
  await mkdir(baseDir, { recursive: true });
  const manifestPath = resolveDataPath(`exports/datasets/${name}.manifest.json`);
  const manifest = {
    trigger: character.triggerToken,
    class_word: classWord,
    sdxl_checkpoint: character.sdxlCheckpoint,
    items: frames.map((f) => ({
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
    warnings: result.warnings,
    folder: toDataRelative(result.out),
    zip,
    zipUrl: zip ? `/api/files/${zip}` : null,
  };
}

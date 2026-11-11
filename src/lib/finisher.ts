/** Server-side bridge to scripts/realism_finish.py (Phase 5 smartphone ISP finisher). */
import { prisma } from "./prisma";
import { resolveDataPath, toDataRelative } from "./paths";
import { runPythonJson } from "./python";
import {
  BadRequestError,
  DEFAULT_FINISHER_WEIGHTS,
  FINISHER_PRESETS,
  FINISHER_SIZES,
  FINISHER_STAGES,
  type FinisherPreset,
  type FinisherSize,
  type FinisherWeights,
  isOneOf,
} from "./types";

export interface FinishSettings {
  preset: FinisherPreset;
  /** Master intensity 0..1. */
  intensity: number;
  weights: FinisherWeights;
  size: FinisherSize;
}

export interface FinishOutput {
  input: string;
  output: string;
  width: number;
  height: number;
  ms: number;
}

/** Validate and fill untrusted finisher settings (API bodies, job options). */
export function parseFinishSettings(input: { preset?: unknown; intensity?: unknown; weights?: unknown; size?: unknown }): FinishSettings {
  const preset = input.preset ?? "iphone_indoor_warm";
  if (!isOneOf(FINISHER_PRESETS, preset)) throw new BadRequestError(`preset must be one of ${FINISHER_PRESETS.join(", ")}`);
  const intensity = input.intensity ?? 0.7;
  if (typeof intensity !== "number" || !(intensity >= 0 && intensity <= 1)) throw new BadRequestError("intensity must be a number between 0 and 1");
  const size = input.size ?? "auto";
  if (!isOneOf(FINISHER_SIZES, size)) throw new BadRequestError(`size must be one of ${FINISHER_SIZES.join(", ")}`);
  const weights: FinisherWeights = { ...DEFAULT_FINISHER_WEIGHTS };
  if (input.weights !== undefined) {
    if (typeof input.weights !== "object" || input.weights === null) throw new BadRequestError("weights must be an object");
    for (const [key, value] of Object.entries(input.weights)) {
      if (!isOneOf(FINISHER_STAGES, key)) throw new BadRequestError(`unknown finisher stage '${key}'`);
      if (typeof value !== "number" || !(value >= 0 && value <= 1)) throw new BadRequestError(`weight ${key} must be between 0 and 1`);
      weights[key] = value;
    }
  }
  return { preset, intensity, weights, size };
}

/**
 * Finish DATA_DIR-relative images into data/finished/<stem>_<preset>.jpg.
 * With `bundle` (DATA_DIR-relative .zip) every output plus finish_settings.json is zipped too.
 */
export async function runFinisher(inputs: string[], settings: FinishSettings, bundle?: string): Promise<{ results: FinishOutput[]; bundle: string | null }> {
  if (inputs.length === 0) throw new BadRequestError("no images to finish");
  const outDir = resolveDataPath("finished");
  const args = [
    ...inputs.map((rel) => resolveDataPath(rel)),
    "--out-dir",
    outDir,
    "--preset",
    settings.preset,
    "--intensity",
    String(settings.intensity),
    "--weights",
    FINISHER_STAGES.map((s) => `${s}=${settings.weights[s]}`).join(","),
    "--size",
    settings.size,
    ...(bundle ? ["--bundle", resolveDataPath(bundle)] : []),
  ];

  const parsed = await runPythonJson<{ results: FinishOutput[]; bundle: string | null }>("realism_finish.py", args);
  return {
    results: parsed.results.map((r) => ({ ...r, input: toDataRelative(r.input), output: toDataRelative(r.output) })),
    bundle: parsed.bundle ? toDataRelative(parsed.bundle) : null,
  };
}

/** Finish raw assets and register (or refresh) their "finished" Asset rows, linked via sourceId. */
export async function finishAssets(assetIds: string[], settings: FinishSettings, bundle?: string): Promise<{ finished: { id: string; path: string; sourceId: string }[]; bundle: string | null }> {
  const sources = await prisma.asset.findMany({ where: { id: { in: assetIds } } });
  if (sources.length !== new Set(assetIds).size) throw new BadRequestError("some assets were not found");
  const bad = sources.find((a) => a.kind === "finished" || a.kind === "mask");
  if (bad) throw new BadRequestError(`asset ${bad.id} is a ${bad.kind} image; pick raw renders`);

  const { results, bundle: zip } = await runFinisher(
    sources.map((s) => s.path),
    settings,
    bundle,
  );
  const finished: { id: string; path: string; sourceId: string }[] = [];
  for (const [i, r] of results.entries()) {
    const source = sources[i];
    if (!source) continue;
    const existing = await prisma.asset.findFirst({ where: { kind: "finished", path: r.output }, select: { id: true } });
    const data = { width: r.width, height: r.height, sourceId: source.id, jobId: source.jobId, characterId: source.characterId, campaignId: source.campaignId, stage: source.stage };
    const row = existing
      ? await prisma.asset.update({ where: { id: existing.id }, data: { ...data, createdAt: new Date() } })
      : await prisma.asset.create({ data: { kind: "finished", path: r.output, ...data } });
    finished.push({ id: row.id, path: row.path, sourceId: source.id });
  }
  return { finished, bundle: zip };
}

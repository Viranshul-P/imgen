import type { NextRequest } from "next/server";
import { errorResponse, json, readJson, requireString } from "@/lib/api";
import { isBucket } from "@/lib/buckets";
import { exportDataset } from "@/lib/datasetExport";
import { DATASET_SIZE, planDatasetFrames } from "@/lib/jobPlanner";
import { prisma } from "@/lib/prisma";
import { BadRequestError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type DatasetPost =
  | { action: "generate"; characterId: string; count?: number; seed?: number }
  | { action: "review"; assetId: string; approved?: boolean | null; caption?: string; bucket?: string | null }
  | { action: "export"; characterId: string; repeats?: number; classWord?: string }
  | { action: "cloudBundle"; characterId: string; repeats?: number; classWord?: string };

/** GET /api/datasets?characterId= - dataset frames for curation. */
export async function GET(request: NextRequest) {
  try {
    const characterId = requireString(request.nextUrl.searchParams.get("characterId"), "characterId");
    const frames = await prisma.asset.findMany({ where: { kind: "dataset", characterId }, orderBy: { createdAt: "asc" } });
    return json({
      frames,
      approved: frames.filter((f) => f.approved === true).length,
      rejected: frames.filter((f) => f.approved === false).length,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/datasets - generate the 35-image genesis dataset, approve/reject a frame, or export the
 * approved frames as a OneTrainer / kohya_ss training folder + zip (Phase 6, scripts/prepare_dataset.py).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await readJson<DatasetPost>(request);
    if (body.action === "generate") {
      const character = await prisma.character.findUnique({ where: { id: requireString(body.characterId, "characterId") } });
      if (!character) throw new BadRequestError("character not found");
      const planned = await planDatasetFrames(character, body.count ?? DATASET_SIZE, body.seed);
      await prisma.$transaction(planned.map((data) => prisma.job.create({ data })));
      return json({ queued: planned.length }, 201);
    }
    if (body.action === "review") {
      const asset = await prisma.asset.update({
        where: { id: requireString(body.assetId, "assetId") },
        data: {
          ...(body.approved !== undefined ? { approved: body.approved } : {}),
          ...(body.caption !== undefined ? { caption: body.caption.trim() } : {}),
          ...(body.bucket !== undefined ? { bucket: body.bucket === null ? null : isBucket(body.bucket) ? body.bucket : (() => { throw new BadRequestError("bucket must be face, body, chest or lower"); })() } : {}),
        },
      });
      return json(asset);
    }
    if (body.action === "export") {
      const result = await exportDataset(requireString(body.characterId, "characterId"), body.repeats ?? 10, body.classWord ?? "woman");
      return json(result, 201);
    }
    if (body.action === "cloudBundle") {
      const result = await exportDataset(requireString(body.characterId, "characterId"), body.repeats ?? 10, body.classWord ?? "woman", true);
      return json(result, 201);
    }
    throw new BadRequestError("action must be generate, review, export or cloudBundle");
  } catch (err) {
    return errorResponse(err);
  }
}

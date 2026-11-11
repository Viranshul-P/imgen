import type { NextRequest } from "next/server";
import { errorResponse, json, readJson, requireString } from "@/lib/api";
import { DATASET_SIZE, planDatasetFrames } from "@/lib/jobPlanner";
import { prisma } from "@/lib/prisma";
import { BadRequestError } from "@/lib/types";

export const dynamic = "force-dynamic";

type DatasetPost =
  | { action: "generate"; characterId: string; count?: number; seed?: number }
  | { action: "review"; assetId: string; approved: boolean | null; caption?: string };

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

/** POST /api/datasets - generate the 35-image genesis dataset, or approve/reject a frame. */
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
        data: { approved: body.approved, ...(body.caption !== undefined ? { caption: body.caption.trim() } : {}) },
      });
      return json(asset);
    }
    throw new BadRequestError("action must be generate or review");
  } catch (err) {
    return errorResponse(err);
  }
}

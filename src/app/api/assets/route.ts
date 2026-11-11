import type { NextRequest } from "next/server";
import { errorResponse, json, readJson, requireString } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { ASSET_KINDS, BadRequestError, QUALITY_FLAGS, isOneOf } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/assets?campaignId=&stage=&kind=&characterId=&limit= - Content Vault listing. */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams;
    const kind = q.get("kind");
    const stage = q.get("stage");
    const assets = await prisma.asset.findMany({
      where: {
        kind: kind && isOneOf(ASSET_KINDS, kind) ? kind : { in: ["raw", "finished"] },
        ...(q.get("campaignId") ? { campaignId: q.get("campaignId") as string } : {}),
        ...(q.get("characterId") ? { characterId: q.get("characterId") as string } : {}),
        ...(stage && Number.isInteger(Number(stage)) ? { stage: Number(stage) } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(q.get("limit") ?? 200) || 200, 1000),
      include: { derived: { select: { id: true, path: true, kind: true } }, job: { select: { label: true, template: true } } },
    });
    return json(assets);
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/assets { id, flags } - toggle quality checklist flags. */
export async function PATCH(request: NextRequest) {
  try {
    const body = await readJson<{ id: string; flags: Record<string, boolean> }>(request);
    const id = requireString(body.id, "id");
    if (typeof body.flags !== "object" || body.flags === null) throw new BadRequestError("flags object is required");
    const clean = Object.fromEntries(Object.entries(body.flags).filter(([k, v]) => isOneOf(QUALITY_FLAGS, k) && typeof v === "boolean"));
    const asset = await prisma.asset.update({ where: { id }, data: { flags: JSON.stringify(clean) } });
    return json(asset);
  } catch (err) {
    return errorResponse(err);
  }
}

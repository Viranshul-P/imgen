import type { NextRequest } from "next/server";
import { errorResponse, json, readJson, requireString } from "@/lib/api";
import { type PlannedJob, type ShootRequest, planMasterFaceCandidates, planShoot } from "@/lib/jobPlanner";
import { prisma } from "@/lib/prisma";
import { BadRequestError, JOB_STATUSES, isOneOf } from "@/lib/types";

export const dynamic = "force-dynamic";

type JobsPost =
  | ({ kind: "shoot" } & ShootRequest)
  | { kind: "genesis_faces"; characterId: string; count: number; checkpoint?: string; seed?: number }
  | { kind: "retry"; id: string };

async function loadCharacter(id: string | null | undefined) {
  if (!id) return null;
  const character = await prisma.character.findUnique({ where: { id } });
  if (!character) throw new BadRequestError(`character ${id} not found`);
  return character;
}

/** GET /api/jobs?status=&characterId=&campaignId=&labelPrefix=&limit= */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams;
    const status = q.get("status");
    const limit = Math.min(Number(q.get("limit") ?? 100) || 100, 500);
    const jobs = await prisma.job.findMany({
      where: {
        ...(status && isOneOf(JOB_STATUSES, status) ? { status } : {}),
        ...(q.get("characterId") ? { characterId: q.get("characterId") as string } : {}),
        ...(q.get("campaignId") ? { campaignId: q.get("campaignId") as string } : {}),
        ...(q.get("labelPrefix") ? { label: { startsWith: q.get("labelPrefix") as string } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { assets: { select: { id: true, path: true, kind: true } } },
    });
    return json(jobs);
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/jobs - queue a shoot (1-20 candidates), master-face candidates, or retry a job. */
export async function POST(request: NextRequest) {
  try {
    const body = await readJson<JobsPost>(request);
    let planned: PlannedJob[];
    switch (body.kind) {
      case "shoot": {
        if (!["A", "B", "C"].includes(body.engine)) throw new BadRequestError("engine must be A, B or C");
        planned = await planShoot(body, await loadCharacter(body.characterId));
        break;
      }
      case "genesis_faces": {
        const character = await loadCharacter(requireString(body.characterId, "characterId"));
        if (!character) throw new BadRequestError("characterId is required");
        planned = await planMasterFaceCandidates(character, Number(body.count), { checkpoint: body.checkpoint, seed: body.seed });
        break;
      }
      case "retry": {
        const old = await prisma.job.findUnique({ where: { id: requireString(body.id, "id") } });
        if (!old) throw new BadRequestError("job not found");
        planned = [
          {
            template: old.template,
            engineKind: old.engineKind,
            modelKey: old.modelKey,
            params: old.params,
            label: old.label,
            priority: old.priority,
            stage: old.stage,
            arcId: old.arcId,
            characterId: old.characterId,
            campaignId: old.campaignId,
          },
        ];
        break;
      }
      default:
        throw new BadRequestError("kind must be shoot, genesis_faces or retry");
    }
    const created = await prisma.$transaction(planned.map((data) => prisma.job.create({ data, select: { id: true } })));
    return json({ queued: created.length, ids: created.map((j) => j.id) }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/jobs?id= - cancel a queued or running job (the worker interrupts ComfyUI). */
export async function DELETE(request: NextRequest) {
  try {
    const id = requireString(request.nextUrl.searchParams.get("id"), "id");
    const result = await prisma.job.updateMany({
      where: { id, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", progressText: "cancel requested" },
    });
    if (result.count === 0) throw new BadRequestError("job is not queued or running");
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

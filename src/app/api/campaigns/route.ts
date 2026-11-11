import { randomInt } from "node:crypto";
import type { NextRequest } from "next/server";
import { errorResponse, json, readJson, requireString } from "@/lib/api";
import { type PlannedJob, type ShootRequest, planShoot } from "@/lib/jobPlanner";
import { prisma } from "@/lib/prisma";
import { ARC_MODES, type ArcStage, BadRequestError, type JobOptions, isOneOf } from "@/lib/types";
import type { LoraSpec } from "@/lib/workflowInjector";

export const dynamic = "force-dynamic";

interface ArcBody {
  kind: "arc";
  campaignId: string;
  name: string;
  mode: "inpaint" | "pose";
  /** inpaint: the Stage 1 base frame every stage is inpainted from (room + face stay locked). */
  baseAssetId?: string;
  maskPath?: string;
  stages: ArcStage[];
  sceneKit?: string;
  checkpoint?: string;
  loras?: LoraSpec[];
  seed?: number;
  aspect?: "4:5" | "9:16";
  poseStrength?: number;
  options?: Partial<JobOptions>;
}

type CampaignsPost = { kind: "campaign"; name: string; characterId: string; description?: string } | ArcBody;

export async function GET(request: NextRequest) {
  try {
    const characterId = request.nextUrl.searchParams.get("characterId");
    const campaigns = await prisma.campaign.findMany({
      where: characterId ? { characterId } : {},
      orderBy: { createdAt: "desc" },
      include: { arcs: { orderBy: { createdAt: "desc" } }, _count: { select: { assets: true, jobs: true } } },
    });
    return json(campaigns);
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/campaigns - create a campaign, or create an Arc and queue every stage ("Generate Full Progression Arc"). */
export async function POST(request: NextRequest) {
  try {
    const body = await readJson<CampaignsPost>(request);
    if (body.kind === "campaign") {
      const characterId = requireString(body.characterId, "characterId");
      if (!(await prisma.character.findUnique({ where: { id: characterId } }))) throw new BadRequestError("character not found");
      const created = await prisma.campaign.create({ data: { name: requireString(body.name, "name"), characterId, description: body.description ?? "" } });
      return json(created, 201);
    }
    if (body.kind !== "arc") throw new BadRequestError("kind must be campaign or arc");

    const campaign = await prisma.campaign.findUnique({ where: { id: requireString(body.campaignId, "campaignId") }, include: { character: true } });
    if (!campaign) throw new BadRequestError("campaign not found");
    if (!isOneOf(ARC_MODES, body.mode)) throw new BadRequestError("mode must be inpaint or pose");
    if (!Array.isArray(body.stages) || body.stages.length < 1 || body.stages.length > 10) throw new BadRequestError("an arc has 1-10 stages");

    let basePath: string | undefined;
    if (body.mode === "inpaint") {
      const base = body.baseAssetId ? await prisma.asset.findUnique({ where: { id: body.baseAssetId } }) : null;
      if (!base) throw new BadRequestError("inpaint arcs need a Stage 1 base frame (baseAssetId)");
      if (!body.maskPath) throw new BadRequestError("inpaint arcs need a mask painted in the Wardrobe Mask Canvas");
      basePath = base.path;
    } else if (body.stages.some((s) => !s.poseImagePath)) {
      throw new BadRequestError("pose arcs need a pose reference image for every stage");
    }

    const arc = await prisma.arc.create({
      data: {
        name: requireString(body.name, "name"),
        mode: body.mode,
        campaignId: campaign.id,
        baseAssetId: body.baseAssetId ?? null,
        maskPath: body.maskPath ?? null,
        stages: JSON.stringify(body.stages),
      },
    });

    // One seed for the whole arc keeps every stage visually coherent.
    const arcSeed = body.seed ?? randomInt(0, 2 ** 31);
    const planned: PlannedJob[] = [];
    for (const stage of [...body.stages].sort((a, b) => a.stage - b.stage)) {
      if (!stage.prompt?.trim()) throw new BadRequestError(`stage ${stage.stage} needs a prompt`);
      const shared: Omit<ShootRequest, "engine" | "prompt"> = {
        characterId: campaign.characterId,
        campaignId: campaign.id,
        sceneKit: body.sceneKit,
        checkpoint: stage.checkpoint ?? body.checkpoint,
        loras: [...(body.loras ?? []), ...(stage.loras ?? [])],
        seed: arcSeed,
        aspect: body.aspect,
        options: body.options,
        stage: stage.stage,
        arcId: arc.id,
        label: `${arc.name} - stage ${stage.stage}`,
        // Earlier stages first: priority descends with stage number.
        priority: 100 - stage.stage,
      };
      const req: ShootRequest =
        body.mode === "inpaint"
          ? { ...shared, engine: "C", prompt: stage.prompt, inpaint: { baseImagePath: basePath as string, maskPath: body.maskPath as string, denoise: stage.denoise } }
          : { ...shared, engine: "B", prompt: stage.prompt, control: { imagePath: stage.poseImagePath as string, mode: "pose", strength: body.poseStrength } };
      planned.push(...(await planShoot(req, campaign.character)));
    }
    await prisma.$transaction(planned.map((data) => prisma.job.create({ data })));
    return json({ arcId: arc.id, queued: planned.length }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}

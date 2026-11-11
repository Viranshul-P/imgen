import type { NextRequest } from "next/server";
import { errorResponse, json, readJson, requireString } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { BadRequestError } from "@/lib/types";
import { LORA_STRENGTH_MAX, LORA_STRENGTH_MIN, type LoraSpec } from "@/lib/workflowInjector";

export const dynamic = "force-dynamic";

const TRIGGER_RE = /^[a-z0-9_]{3,40}$/;

interface CharacterBody {
  id?: string;
  name?: string;
  triggerToken?: string;
  descriptors?: string;
  negativePrompt?: string;
  sdxlCheckpoint?: string | null;
  sdxlLora?: string | null;
  sdxlLoraWeight?: number;
  fluxLora?: string | null;
  fluxLoraWeight?: number;
  defaultLoras?: (LoraSpec & { engine?: "A" | "B" | "C" })[];
  /** Pick master_face.png from an existing asset (genesis candidate or upload). */
  masterFaceAssetId?: string | null;
}

function weight(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < LORA_STRENGTH_MIN || value > LORA_STRENGTH_MAX) {
    throw new BadRequestError(`${field} must be between ${LORA_STRENGTH_MIN} and ${LORA_STRENGTH_MAX}`);
  }
  return value;
}

async function fields(body: CharacterBody) {
  if (body.triggerToken !== undefined && !TRIGGER_RE.test(body.triggerToken)) {
    throw new BadRequestError("triggerToken must be 3-40 chars of a-z, 0-9 or _ (e.g. v1ra_person)");
  }
  let masterFacePath: string | null | undefined;
  if (body.masterFaceAssetId !== undefined) {
    if (body.masterFaceAssetId === null) masterFacePath = null;
    else {
      const asset = await prisma.asset.findUnique({ where: { id: body.masterFaceAssetId } });
      if (!asset) throw new BadRequestError("master face asset not found");
      masterFacePath = asset.path;
    }
  }
  return {
    ...(body.name !== undefined ? { name: requireString(body.name, "name") } : {}),
    ...(body.triggerToken !== undefined ? { triggerToken: body.triggerToken } : {}),
    ...(body.descriptors !== undefined ? { descriptors: body.descriptors.trim() } : {}),
    ...(body.negativePrompt !== undefined ? { negativePrompt: body.negativePrompt.trim() } : {}),
    ...(body.sdxlCheckpoint !== undefined ? { sdxlCheckpoint: body.sdxlCheckpoint || null } : {}),
    ...(body.sdxlLora !== undefined ? { sdxlLora: body.sdxlLora || null } : {}),
    ...(body.fluxLora !== undefined ? { fluxLora: body.fluxLora || null } : {}),
    ...(weight(body.sdxlLoraWeight, "sdxlLoraWeight") !== undefined ? { sdxlLoraWeight: body.sdxlLoraWeight as number } : {}),
    ...(weight(body.fluxLoraWeight, "fluxLoraWeight") !== undefined ? { fluxLoraWeight: body.fluxLoraWeight as number } : {}),
    ...(body.defaultLoras !== undefined ? { defaultLoras: JSON.stringify(body.defaultLoras) } : {}),
    ...(masterFacePath !== undefined ? { masterFacePath } : {}),
  };
}

export async function GET() {
  try {
    const characters = await prisma.character.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { jobs: true, assets: true, campaigns: true } } },
    });
    return json(characters);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await readJson<CharacterBody>(request);
    requireString(body.name, "name");
    requireString(body.triggerToken, "triggerToken");
    const data = await fields(body);
    const created = await prisma.character.create({ data: { name: data.name as string, triggerToken: data.triggerToken as string, ...data } });
    return json(created, 201);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) return errorResponse(new BadRequestError("that trigger token is already used"));
    return errorResponse(err);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await readJson<CharacterBody>(request);
    const id = requireString(body.id, "id");
    const updated = await prisma.character.update({ where: { id }, data: await fields(body) });
    return json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

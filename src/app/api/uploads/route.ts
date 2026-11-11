import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/lib/api";
import { ensureDataDirs, resolveDataPath, toDataRelative } from "@/lib/paths";
import { readPngSize } from "@/lib/png";
import { prisma } from "@/lib/prisma";
import { BadRequestError } from "@/lib/types";

const MAX_BYTES = 25 * 1024 * 1024;

function imageType(bytes: Uint8Array): ".png" | ".jpg" | ".webp" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return ".webp";
  return null;
}

/**
 * POST /api/uploads (multipart): file, kind = upload | mask, characterId?, campaignId?
 * Stores pose/depth references, base frames and canvas-exported masks under data/.
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new BadRequestError("multipart field 'file' is required");
    if (file.size > MAX_BYTES) throw new BadRequestError("file is larger than 25 MB");
    const kind = form.get("kind") === "mask" ? "mask" : "upload";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = imageType(bytes);
    if (!ext) throw new BadRequestError("only PNG, JPEG or WebP images are accepted");
    if (kind === "mask" && ext !== ".png") throw new BadRequestError("masks must be PNG");

    await ensureDataDirs();
    const full = resolveDataPath(path.join(kind === "mask" ? "masks" : "uploads", `${randomUUID()}${ext}`));
    await writeFile(full, bytes);
    const size = ext === ".png" ? readPngSize(bytes) : null;
    const characterId = (form.get("characterId") as string | null) || null;
    const campaignId = (form.get("campaignId") as string | null) || null;
    const asset = await prisma.asset.create({
      data: { kind, path: toDataRelative(full), width: size?.width ?? null, height: size?.height ?? null, characterId, campaignId },
    });
    return json({ id: asset.id, path: asset.path, width: asset.width, height: asset.height }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}

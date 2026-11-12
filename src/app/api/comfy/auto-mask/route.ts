import type { NextRequest } from "next/server";
import { errorResponse, json, readJson } from "@/lib/api";
import { type AutoMaskRequest, runAutoMask } from "@/lib/autoMask";

/**
 * POST /api/comfy/auto-mask { imagePath, categories: ["upper","skirt","pants","dress","belt","scarf"], grow? }
 * Returns a binary mask asset (white = chosen garments) ready for Engine C or the Arc builder.
 * The segmentation runs on the CPU, so it can run while a render is using the GPU.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await readJson<AutoMaskRequest>(request);
    return json(await runAutoMask(body), 201);
  } catch (err) {
    return errorResponse(err);
  }
}

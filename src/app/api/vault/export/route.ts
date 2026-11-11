import type { NextRequest } from "next/server";
import { errorResponse, json, readJson } from "@/lib/api";
import { finishAssets, parseFinishSettings } from "@/lib/finisher";
import { BadRequestError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const MAX_ASSETS = 200;

interface ExportBody {
  assetIds?: unknown;
  preset?: unknown;
  intensity?: unknown;
  weights?: unknown;
  size?: unknown;
  /** Also write a zip bundle to data/exports/ (default true). */
  bundle?: unknown;
}

/**
 * POST /api/vault/export - run the Phone Look Finisher over selected raw renders.
 * Body: { assetIds, preset, intensity 0..1, weights?: {tone,lens,sharpen,noise}, size?: auto|4:5|9:16, bundle?: boolean }
 * Returns the finished Asset rows (linked to their raw source) and the zip bundle path.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await readJson<ExportBody>(request);
    const ids = body.assetIds;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id): id is string => typeof id === "string" && id.length > 0)) {
      throw new BadRequestError("assetIds must be a non-empty array of asset ids");
    }
    if (ids.length > MAX_ASSETS) throw new BadRequestError(`export at most ${MAX_ASSETS} images at a time`);
    const settings = parseFinishSettings(body);
    const wantBundle = body.bundle === undefined ? true : body.bundle === true;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
    const bundle = wantBundle ? `exports/vault_${stamp}_${settings.preset}.zip` : undefined;

    const result = await finishAssets([...new Set(ids)], settings, bundle);
    return json({ ...result, settings, bundleUrl: result.bundle ? `/api/files/${result.bundle}` : null });
  } catch (err) {
    return errorResponse(err);
  }
}

import type { NextRequest } from "next/server";
import { errorResponse, json, readJson } from "@/lib/api";
import { getComfyEndpoint } from "@/lib/comfyEndpoint";
import { BadRequestError } from "@/lib/types";
import { hasCivitaiToken, listDownloads, remoteFetcherUrl, saveCivitaiToken, startDownload } from "@/lib/modelDownload";

export const dynamic = "force-dynamic";

interface DownloadBody {
  /** Civitai model version ID, Civitai download/page URL, or a direct https .safetensors URL. */
  source?: unknown;
  folder?: unknown;
  /** Optional Civitai API key; with saveToken it is written to .env.local, otherwise kept until the studio restarts. */
  civitaiToken?: unknown;
  saveToken?: unknown;
}

/** GET /api/comfy/download-model - recent downloads with live progress (polled by the Studio UI). */
export async function GET() {
  try {
    const endpoint = await getComfyEndpoint();
    return json({ target: endpoint.mode, remoteFetcherUrl: remoteFetcherUrl(), hasCivitaiToken: hasCivitaiToken(), downloads: await listDownloads() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/comfy/download-model - start a download into the active ComfyUI's models/checkpoints or models/loras. */
export async function POST(request: NextRequest) {
  try {
    const body = await readJson<DownloadBody>(request);
    if (body.civitaiToken !== undefined && body.civitaiToken !== "") {
      if (body.saveToken === true) await saveCivitaiToken(body.civitaiToken);
      else if (typeof body.civitaiToken === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(body.civitaiToken.trim())) process.env["CIVITAI_TOKEN"] = body.civitaiToken.trim();
      else throw new BadRequestError("that does not look like a Civitai API key (letters, digits, - and _ only)");
    }
    const state = await startDownload({ source: body.source, folder: body.folder });
    return json(state, 202);
  } catch (err) {
    return errorResponse(err);
  }
}

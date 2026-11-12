import type { NextRequest } from "next/server";
import { errorResponse, json, readJson } from "@/lib/api";
import { ComfyClient } from "@/lib/comfyClient";
import { getComfyEndpoint, setComfyEndpoint } from "@/lib/comfyEndpoint";

export const dynamic = "force-dynamic";

/** GET /api/comfy/endpoint - which ComfyUI is in use (local laptop GPU or remote cloud GPU tunnel). */
export async function GET() {
  try {
    return json(await getComfyEndpoint());
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/comfy/endpoint { mode?: "local" | "remote", remoteUrl?: string }
 * Switches the studio and the worker. Switching to remote needs the SSH tunnel to be up; the reply says whether
 * that ComfyUI answered. A running job keeps going on the endpoint it started on.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await readJson<{ mode?: unknown; remoteUrl?: unknown }>(request);
    const endpoint = await setComfyEndpoint(body);
    const reachable = await new ComfyClient(endpoint.url).isUp().catch(() => false);
    return json({ ...endpoint, reachable });
  } catch (err) {
    return errorResponse(err);
  }
}

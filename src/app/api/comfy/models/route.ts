import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/lib/api";
import { getModelCatalog } from "@/lib/modelDiscovery";

export const dynamic = "force-dynamic";

/** GET /api/comfy/models[?refresh=1] - model dropdown contents from the live /object_info. */
export async function GET(request: NextRequest) {
  try {
    const refresh = request.nextUrl.searchParams.get("refresh") === "1";
    return json(await getModelCatalog(refresh));
  } catch (err) {
    return errorResponse(err);
  }
}

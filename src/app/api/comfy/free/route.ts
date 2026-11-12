import { errorResponse, json } from "@/lib/api";
import { getComfyClient } from "@/lib/comfyEndpoint";
import { prisma } from "@/lib/prisma";

/** POST /api/comfy/free - manual "Free VRAM" button (unload models + free cached memory). */
export async function POST() {
  try {
    await (await getComfyClient()).free(true, true);
    await prisma.workerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastFlushAt: new Date(), flushCount: 1 },
      update: { activeEngine: "", activeModel: "", lastFlushAt: new Date(), flushCount: { increment: 1 } },
    });
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

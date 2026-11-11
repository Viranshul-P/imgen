import { errorResponse, json } from "@/lib/api";
import { ComfyClient } from "@/lib/comfyClient";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const WORKER_STALE_MS = 10_000;

/** GET /api/comfy/status - ComfyUI VRAM/RAM, worker liveness + active engine, queue counts. */
export async function GET() {
  try {
    const client = new ComfyClient();
    const [stats, worker, grouped, running] = await Promise.all([
      client.systemStats().catch(() => null),
      prisma.workerState.findUnique({ where: { id: 1 } }),
      prisma.job.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.job.findFirst({
        where: { status: "running" },
        select: { id: true, label: true, template: true, progress: true, progressText: true },
      }),
    ]);
    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    const device = stats?.devices[0];
    return json({
      comfy: stats
        ? {
            up: true,
            version: stats.system.comfyui_version,
            device: device?.name ?? "unknown",
            vramTotal: device?.vram_total ?? 0,
            vramFree: device?.vram_free ?? 0,
            ramTotal: stats.system.ram_total,
            ramFree: stats.system.ram_free,
          }
        : { up: false },
      worker: worker
        ? {
            alive: Date.now() - worker.heartbeatAt.getTime() < WORKER_STALE_MS,
            activeEngine: worker.activeEngine,
            activeModel: worker.activeModel,
            currentJobId: worker.currentJobId,
            flushCount: worker.flushCount,
            lastFlushAt: worker.lastFlushAt,
          }
        : { alive: false },
      queue: {
        queued: counts["queued"] ?? 0,
        running: counts["running"] ?? 0,
        done: counts["done"] ?? 0,
        failed: counts["failed"] ?? 0,
      },
      running,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

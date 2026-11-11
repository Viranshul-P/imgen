import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const TICK_MS = 1000;
const KEEPALIVE_MS = 15_000;

/**
 * GET /api/jobs/stream - Server-Sent Events. Emits `jobs` events with every active job and
 * jobs finished in the last minute, only when something changed, plus `worker` liveness.
 */
export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastPayload = "";
  let lastSend = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        lastSend = Date.now();
      };
      const tick = async (): Promise<void> => {
        try {
          const since = new Date(Date.now() - 60_000);
          const [jobs, worker] = await Promise.all([
            prisma.job.findMany({
              where: { OR: [{ status: { in: ["queued", "running"] } }, { finishedAt: { gte: since } }] },
              orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
              take: 200,
              select: {
                id: true,
                status: true,
                label: true,
                template: true,
                progress: true,
                progressText: true,
                error: true,
                stage: true,
                durationMs: true,
                assets: { select: { id: true, path: true, kind: true } },
              },
            }),
            prisma.workerState.findUnique({ where: { id: 1 } }),
          ]);
          const payload = JSON.stringify({ jobs, worker: worker ? { activeEngine: worker.activeEngine, activeModel: worker.activeModel, heartbeatAt: worker.heartbeatAt } : null });
          if (payload !== lastPayload) {
            lastPayload = payload;
            send("jobs", JSON.parse(payload));
          } else if (Date.now() - lastSend > KEEPALIVE_MS) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
            lastSend = Date.now();
          }
        } catch (err) {
          send("error", { message: err instanceof Error ? err.message : String(err) });
        }
      };
      void tick();
      timer = setInterval(() => void tick(), TICK_MS);
      request.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * PersonaForge queue worker - long-running process that executes Job rows one at a time.
 *
 *   npx tsx worker/queueWorker.ts        (started automatically by `npm run dev`)
 *
 * 8 GB VRAM rules (spec section 1):
 *   - every graph runs with batch_size = 1 (enforced by workflowInjector)
 *   - when the next job needs a different engine (FLUX_GGUF <-> SDXL) or a different model,
 *     POST /free { unload_models, free_memory } and pause VRAM_FLUSH_PAUSE_MS before dispatch
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ComfyClient, ComfyError, sleep } from "../src/lib/comfyClient";
import { validatePrompt } from "../src/lib/comfySchema";
import { finishAssets, parseFinishSettings } from "../src/lib/finisher";
import { planFaceLock } from "../src/lib/jobPlanner";
import { getObjectInfo } from "../src/lib/modelDiscovery";
import { ensureDataDirs, resolveDataPath, safeFileStem, toDataRelative } from "../src/lib/paths";
import { readPngSize } from "../src/lib/png";
import { prisma } from "../src/lib/prisma";
import { type JobParams, parseJson } from "../src/lib/types";
import { injectWorkflow, loadTemplate } from "../src/lib/workflowInjector";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const FLUSH_PAUSE_MS = Number(process.env["VRAM_FLUSH_PAUSE_MS"] ?? 1500);
const IDLE_POLL_MS = 1000;
const COMFY_DOWN_POLL_MS = 3000;
const PROGRESS_WRITE_MS = 750;
const CANCEL_POLL_MS = 1500;
const VRAM_SAMPLE_MS = 2000;

const client = new ComfyClient(process.env["COMFY_URL"]);
let stopping = false;
let loaded: { engine: string; model: string } | null = null;

type JobRow = NonNullable<Awaited<ReturnType<typeof prisma.job.findFirst>>>;

function log(message: string): void {
  console.log(`[worker ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function heartbeat(patch: { activeEngine?: string; activeModel?: string; currentJobId?: string | null; flushed?: boolean } = {}): Promise<void> {
  const data = {
    heartbeatAt: new Date(),
    ...(patch.activeEngine !== undefined ? { activeEngine: patch.activeEngine } : {}),
    ...(patch.activeModel !== undefined ? { activeModel: patch.activeModel } : {}),
    ...(patch.currentJobId !== undefined ? { currentJobId: patch.currentJobId } : {}),
    ...(patch.flushed ? { lastFlushAt: new Date(), flushCount: { increment: 1 } } : {}),
  };
  await prisma.workerState.upsert({ where: { id: 1 }, create: { id: 1, ...data, flushCount: patch.flushed ? 1 : 0 }, update: data });
}

/** POST /free whenever the next job needs a different engine or model. */
async function vramGuard(job: JobRow): Promise<void> {
  if (loaded && (loaded.engine !== job.engineKind || loaded.model !== job.modelKey)) {
    log(`VRAM flush: ${loaded.engine}:${loaded.model} -> ${job.engineKind}:${job.modelKey}`);
    await client.free(true, true);
    await sleep(FLUSH_PAUSE_MS);
    await heartbeat({ flushed: true, activeEngine: "", activeModel: "" });
  }
}

async function uploadInputs(job: JobRow, params: JobParams): Promise<void> {
  for (const [placeholder, relative] of Object.entries(params.inputs)) {
    const bytes = await readFile(resolveDataPath(relative));
    const name = `pf_${job.id}_${safeFileStem(placeholder.toLowerCase())}${path.extname(relative) || ".png"}`;
    params.values[placeholder] = await client.uploadImage(bytes, name);
  }
}

async function saveOutputs(job: JobRow, params: JobParams, images: { filename: string; subfolder: string; type: "output" | "temp" | "input" }[]): Promise<{ id: string; path: string }[]> {
  const kind = job.template === "genesis_dataset" ? "dataset" : "raw";
  const sourcePath = params.inputs["INPUT_IMAGE"];
  const source = sourcePath ? await prisma.asset.findFirst({ where: { path: sourcePath }, select: { id: true } }) : null;
  const saved: { id: string; path: string }[] = [];
  for (const [i, image] of images.entries()) {
    const bytes = await client.downloadImage(image);
    const full = resolveDataPath(path.join(kind === "dataset" ? "datasets" : "raw", `${job.id}_${i}.png`));
    await writeFile(full, bytes);
    const size = readPngSize(bytes);
    const rel = toDataRelative(full);
    const asset = await prisma.asset.create({
      data: {
        kind,
        path: rel,
        width: size?.width ?? null,
        height: size?.height ?? null,
        jobId: job.id,
        characterId: job.characterId,
        campaignId: job.campaignId,
        stage: job.stage,
        sourceId: source?.id ?? null,
      },
    });
    saved.push({ id: asset.id, path: rel });
  }
  return saved;
}

function willFaceLock(job: JobRow, params: JobParams): boolean {
  return job.engineKind === "FLUX_GGUF" && params.options.enableCrossEngineFaceLock;
}

/**
 * Phone Look Finisher hook: raw PNG stays in data/raw/, the finished JPEG goes to data/finished/
 * as an Asset whose sourceId points at the raw one. Skipped for dataset frames (training wants the
 * clean render) and for Flux renders that get a face-lock pass (the locked result is finished instead).
 * A finisher failure never fails the render itself.
 */
async function finishOutputs(job: JobRow, params: JobParams, saved: { id: string; path: string }[]): Promise<string> {
  const o = params.options;
  if (!o.enablePhoneFinisher || job.template === "genesis_dataset" || willFaceLock(job, params) || saved.length === 0) return "";
  try {
    const settings = parseFinishSettings({ preset: o.finisherPreset, intensity: o.finisherIntensity });
    const { finished } = await finishAssets(
      saved.map((s) => s.id),
      settings,
    );
    log(`phone finisher (${settings.preset} @ ${settings.intensity}) -> ${finished.map((f) => f.path).join(", ")}`);
    return `, ${finished.length} phone-finished`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`phone finisher failed for ${job.id}: ${message}`);
    return ` (phone finisher failed: ${message.slice(0, 200)})`;
  }
}

async function queueFollowUps(job: JobRow, params: JobParams, saved: { id: string; path: string }[]): Promise<void> {
  if (!willFaceLock(job, params)) return;
  const character = job.characterId ? await prisma.character.findUnique({ where: { id: job.characterId } }) : null;
  for (const { path: raw } of saved) {
    const planned = await planFaceLock(job, raw, character);
    await prisma.job.create({ data: planned });
    log(`queued cross-engine face lock for ${raw}`);
  }
}

async function runJob(job: JobRow): Promise<void> {
  const started = Date.now();
  const params = parseJson<JobParams | null>(job.params, null);
  if (!params) throw new Error("job params are not valid JSON");
  const template = await loadTemplate(job.template);
  await uploadInputs(job, params);

  const prompt = injectWorkflow(template, params);
  const info = await getObjectInfo(false, client);
  const errors = validatePrompt(prompt, info).filter((i) => i.level === "error");
  if (errors.length) {
    // Models may have been added since the cache was filled: retry once with a fresh schema.
    const fresh = validatePrompt(prompt, await getObjectInfo(true, client)).filter((i) => i.level === "error");
    if (fresh.length) throw new Error(`workflow failed schema validation: ${fresh.map((e) => `node ${e.node} ${e.classType}: ${e.message}`).join("; ")}`);
  }

  await vramGuard(job);
  await heartbeat({ currentJobId: job.id });

  const abort = new AbortController();
  let lastWrite = 0;
  let peakUsedBytes = 0;
  const cancelTimer = setInterval(() => {
    void prisma.job.findUnique({ where: { id: job.id }, select: { status: true } }).then((j) => {
      if (j?.status === "cancelled") abort.abort();
    });
  }, CANCEL_POLL_MS);
  const vramTimer = setInterval(() => {
    void client
      .systemStats()
      .then((s) => {
        const d = s.devices[0];
        if (d) peakUsedBytes = Math.max(peakUsedBytes, d.vram_total - d.vram_free);
      })
      .catch(() => undefined);
  }, VRAM_SAMPLE_MS);

  try {
    const result = await client.run(prompt, {
      signal: abort.signal,
      timeoutMs: 45 * 60_000,
      onNodeStart: (node) => {
        const title = prompt[node]?._meta?.title ?? node;
        void prisma.job.update({ where: { id: job.id }, data: { progressText: title } }).catch(() => undefined);
      },
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastWrite < PROGRESS_WRITE_MS && p.value < p.max) return;
        lastWrite = now;
        const title = (p.node && prompt[p.node]?._meta?.title) || "sampling";
        void prisma.job
          .update({ where: { id: job.id }, data: { progress: p.max ? p.value / p.max : 0, progressText: `${title} ${p.value}/${p.max}` } })
          .catch(() => undefined);
      },
    });
    loaded = { engine: job.engineKind, model: job.modelKey };
    await heartbeat({ activeEngine: job.engineKind, activeModel: job.modelKey });
    if (result.images.length === 0) throw new Error("ComfyUI finished without saving an image");
    const saved = await saveOutputs(job, params, result.images);
    await queueFollowUps(job, params, saved);
    await prisma.job.update({ where: { id: job.id }, data: { progressText: "phone finisher" } });
    const finishNote = await finishOutputs(job, params, saved);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "done",
        progress: 1,
        progressText: `saved ${saved.length} image(s)${finishNote}`,
        promptId: result.promptId,
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        peakVramMb: peakUsedBytes ? Math.round(peakUsedBytes / 1024 / 1024) : null,
      },
    });
    log(`done ${job.id} ${job.template} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    clearInterval(cancelTimer);
    clearInterval(vramTimer);
  }
}

async function claimNext(): Promise<JobRow | null> {
  const next = await prisma.job.findFirst({ where: { status: "queued" }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] });
  if (!next) return null;
  const claimed = await prisma.job.updateMany({ where: { id: next.id, status: "queued" }, data: { status: "running", startedAt: new Date(), progress: 0, progressText: "starting" } });
  return claimed.count === 1 ? { ...next, status: "running" } : null;
}

async function main(): Promise<void> {
  await ensureDataDirs();
  const recovered = await prisma.job.updateMany({ where: { status: "running" }, data: { status: "queued", progress: 0, progressText: "re-queued after worker restart" } });
  if (recovered.count) log(`re-queued ${recovered.count} job(s) left running by a previous worker`);
  await heartbeat({ activeEngine: "", activeModel: "", currentJobId: null });
  log(`started; ComfyUI at ${client.baseUrl}, flush pause ${FLUSH_PAUSE_MS}ms`);

  let comfyWasUp = true;
  while (!stopping) {
    await heartbeat();
    if (!(await client.isUp())) {
      if (comfyWasUp) log("ComfyUI is not reachable - waiting (start it with scripts/start_comfy_api.ps1 -Background)");
      comfyWasUp = false;
      loaded = null;
      await sleep(COMFY_DOWN_POLL_MS);
      continue;
    }
    if (!comfyWasUp) log("ComfyUI is reachable again");
    comfyWasUp = true;

    const job = await claimNext();
    if (!job) {
      await sleep(IDLE_POLL_MS);
      continue;
    }
    log(`running ${job.id} ${job.template} (${job.label})`);
    try {
      await runJob(job);
    } catch (err) {
      const cancelled = err instanceof ComfyError && err.message === "cancelled";
      const message = err instanceof Error ? err.message : String(err);
      await prisma.job.update({
        where: { id: job.id },
        data: cancelled
          ? { status: "cancelled", progressText: "cancelled", finishedAt: new Date() }
          : { status: "failed", error: message.slice(0, 4000), progressText: "failed", finishedAt: new Date() },
      });
      log(`${cancelled ? "cancelled" : "FAILED"} ${job.id}: ${message}`);
      // The model may or may not be resident after a failure; force a flush before the next job.
      loaded = { engine: "unknown", model: "unknown" };
    } finally {
      await heartbeat({ currentJobId: null });
    }
  }
  await prisma.$disconnect();
  log("stopped");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} received - finishing current job then exiting`);
    stopping = true;
  });
}

main().catch(async (err: unknown) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

/**
 * 1-click Civitai / custom URL model downloader (server-side only).
 *
 *   source  - a Civitai model-version ID ("128713"), a Civitai page / API download URL, or any direct https URL
 *   folder  - checkpoints | loras
 *
 * Local Laptop GPU mode downloads straight into the local ComfyUI `models/<folder>` directory.
 * Remote Cloud GPU mode hands the download to `cloud_model_fetcher.py` on the cloud machine (reached through
 * the same SSH tunnel on port 8190), so multi-GB files never travel through the laptop.
 *
 * Only `.safetensors` files are accepted (pickled .ckpt/.pt files can run code when loaded). Tokens are sent
 * only to their own host (CIVITAI_TOKEN -> civitai.com, HF_TOKEN -> huggingface.co), and never on a redirect
 * to another host (the signed storage URL Civitai redirects to).
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { getComfyEndpoint } from "./comfyEndpoint";
import { BadRequestError } from "./types";

export const DOWNLOAD_FOLDERS = ["checkpoints", "loras"] as const;
export type DownloadFolder = (typeof DOWNLOAD_FOLDERS)[number];

export type DownloadStatus = "resolving" | "downloading" | "verifying" | "done" | "failed";

export interface DownloadState {
  id: string;
  target: "local" | "remote";
  folder: DownloadFolder;
  source: string;
  filename: string;
  status: DownloadStatus;
  bytes: number;
  total: number | null;
  /** 0..100, null while the size is unknown. */
  percent: number | null;
  error: string | null;
  /** Civitai metadata, when the source is Civitai. */
  civitai?: { modelName: string; versionName: string; type: string; baseModel: string };
  /** Shown in the UI, e.g. a Civitai type that does not match the chosen folder. */
  warning: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Remote mode: the fetcher's own job id. */
  remoteId?: string;
}

interface ResolvedSource {
  url: string;
  /** Empty = take it from Content-Disposition / the final URL at download time. */
  filename: string;
  sha256: string | null;
  size: number | null;
  civitai?: DownloadState["civitai"];
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ ()+,-]{0,180}\.safetensors$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,200}$/;
const MAX_REDIRECTS = 8;

// Survives Next.js dev hot reloads (module state would otherwise reset).
const store: Map<string, DownloadState> = ((globalThis as { __pfDownloads?: Map<string, DownloadState> }).__pfDownloads ??= new Map());

export function remoteFetcherUrl(): string {
  return (process.env["COMFY_REMOTE_FETCHER_URL"] ?? "http://127.0.0.1:8190").replace(/\/+$/, "");
}

export function localModelsDir(folder: DownloadFolder): string {
  const root = process.env["COMFY_ROOT"] ?? path.resolve(/* turbopackIgnore: true */ process.cwd(), "..", "ComfyUI_windows_portable");
  return path.join(/* turbopackIgnore: true */ root, "ComfyUI", "models", folder);
}

function isHost(url: string, host: string): boolean {
  const h = new URL(url).hostname.toLowerCase();
  return h === host || h.endsWith(`.${host}`);
}

/** The auth header for this exact URL's host, or none. */
function authFor(url: string): Record<string, string> {
  const civitai = process.env["CIVITAI_TOKEN"]?.trim();
  const hf = process.env["HF_TOKEN"]?.trim();
  if (civitai && isHost(url, "civitai.com")) return { Authorization: `Bearer ${civitai}` };
  if (hf && isHost(url, "huggingface.co")) return { Authorization: `Bearer ${hf}` };
  return {};
}

export function cleanFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).trim();
  if (!SAFE_NAME.test(base)) {
    if (!/\.safetensors$/i.test(base)) throw new BadRequestError(`only .safetensors files can be downloaded (got "${base || "no file name"}")`);
    throw new BadRequestError(`unsafe file name "${base}"`);
  }
  return base;
}

function civitaiVersionId(source: string): string | null {
  if (/^\d{1,10}$/.test(source)) return source;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (!isHost(url.toString(), "civitai.com")) return null;
  const fromQuery = url.searchParams.get("modelVersionId");
  if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
  const m = url.pathname.match(/\/api\/download\/models\/(\d+)/) ?? url.pathname.match(/\/model-versions\/(\d+)/);
  if (m?.[1]) return m[1];
  if (/^\/models\/\d+/.test(url.pathname)) {
    throw new BadRequestError("that is a Civitai model page; use the model version ID (the number after ?modelVersionId= when you pick a version) or the version's download link");
  }
  return null;
}

interface CivitaiFile {
  name: string;
  downloadUrl: string;
  primary?: boolean;
  sizeKB?: number;
  hashes?: { SHA256?: string };
  metadata?: { format?: string };
}

async function resolveCivitai(versionId: string): Promise<ResolvedSource> {
  const api = `https://civitai.com/api/v1/model-versions/${versionId}`;
  const res = await fetch(api, { headers: { ...authFor(api), Accept: "application/json" } });
  if (res.status === 404) throw new BadRequestError(`Civitai has no model version ${versionId}`);
  if (!res.ok) throw new BadRequestError(`Civitai metadata request failed (HTTP ${res.status})`);
  const data = (await res.json()) as {
    name?: string;
    baseModel?: string;
    model?: { name?: string; type?: string };
    files?: CivitaiFile[];
  };
  const files = (data.files ?? []).filter((f) => /\.safetensors$/i.test(f.name));
  const file = files.find((f) => f.primary) ?? files[0];
  if (!file) throw new BadRequestError(`Civitai version ${versionId} has no .safetensors file (only pickled formats, which PersonaForge refuses)`);
  return {
    url: file.downloadUrl || `https://civitai.com/api/download/models/${versionId}`,
    filename: cleanFilename(file.name),
    sha256: file.hashes?.SHA256?.toLowerCase() ?? null,
    size: file.sizeKB ? Math.round(file.sizeKB * 1024) : null,
    civitai: { modelName: data.model?.name ?? "", versionName: data.name ?? "", type: data.model?.type ?? "", baseModel: data.baseModel ?? "" },
  };
}

export async function resolveSource(rawSource: string): Promise<ResolvedSource> {
  const source = rawSource.trim();
  if (!source) throw new BadRequestError("paste a Civitai model version ID or a download URL");
  const versionId = civitaiVersionId(source);
  if (versionId) return resolveCivitai(versionId);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new BadRequestError("enter a Civitai model version ID (digits only) or a full https:// download URL");
  }
  if (url.protocol !== "https:") throw new BadRequestError("download URLs must start with https://");
  if (url.username || url.password) throw new BadRequestError("do not put a username or password in the URL");
  // Hugging Face "blob" pages are HTML; the file itself is under /resolve/.
  if (isHost(url.toString(), "huggingface.co")) url.pathname = url.pathname.replace("/blob/", "/resolve/");
  const last = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  if (/\.(ckpt|pt|pth|bin|pkl|zip|gguf|onnx)$/i.test(last)) throw new BadRequestError(`only .safetensors files can be downloaded (got "${last}")`);
  return { url: url.toString(), filename: /\.safetensors$/i.test(last) ? cleanFilename(last) : "", sha256: null, size: null };
}

function folderWarning(folder: DownloadFolder, civitai: DownloadState["civitai"]): string | null {
  if (!civitai?.type) return null;
  const t = civitai.type.toLowerCase();
  if (folder === "loras" && t === "checkpoint") return "Civitai lists this as a Checkpoint, but it is going into loras/";
  if (folder === "checkpoints" && (t === "lora" || t === "locon" || t === "dora")) return `Civitai lists this as a ${civitai.type}, but it is going into checkpoints/`;
  return null;
}

function filenameFromDisposition(header: string | null): string {
  if (!header) return "";
  const star = header.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (star?.[1]) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain?.[1]?.trim() ?? "";
}

function update(state: DownloadState, patch: Partial<DownloadState>): void {
  Object.assign(state, patch);
  state.percent = state.total ? Math.min(100, Math.round((state.bytes / state.total) * 1000) / 10) : state.status === "done" ? 100 : null;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** GET that follows redirects by hand so the auth header is only ever sent to the original host. */
async function openDownload(startUrl: string, rangeStart: number): Promise<{ res: Response; finalUrl: string }> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { "User-Agent": "PersonaForge-model-downloader", ...authFor(url) };
    if (rangeStart > 0) headers["Range"] = `bytes=${rangeStart}-`;
    const res = await fetch(url, { headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = new URL(res.headers.get("location") as string, url);
      if (next.protocol !== "https:") throw new Error("the download redirected to a non-https URL; refused");
      url = next.toString();
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      const civ = isHost(startUrl, "civitai.com");
      throw new Error(
        civ
          ? process.env["CIVITAI_TOKEN"]
            ? "Civitai refused the download (HTTP " + res.status + "): check that your CIVITAI_TOKEN is valid and that the model is not early-access"
            : "Civitai needs an API token for this file: add your CIVITAI_TOKEN in this dialog (civitai.com > Account settings > API keys)"
          : `the server refused the download (HTTP ${res.status})`,
      );
    }
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    return { res, finalUrl: url };
  }
  throw new Error("too many redirects");
}

async function runLocal(state: DownloadState, resolved: ResolvedSource): Promise<void> {
  const dir = localModelsDir(state.folder);
  await mkdir(dir, { recursive: true });
  // The file name may only be known from the response headers (direct URLs).
  let filename = resolved.filename;
  let partPath = filename ? path.join(dir, `${filename}.part`) : "";
  let have = partPath ? await stat(partPath).then((s) => s.size).catch(() => 0) : 0;
  if (filename && (await stat(path.join(dir, filename)).catch(() => null))) throw new Error(`${filename} already exists in models/${state.folder}`);

  update(state, { status: "downloading", bytes: have, total: resolved.size });
  let { res, finalUrl } = await openDownload(resolved.url, have);
  if (have > 0 && res.status !== 206) {
    // Server ignored the Range header: start over.
    await res.body?.cancel();
    have = 0;
    ({ res, finalUrl } = await openDownload(resolved.url, 0));
  }
  if (!filename) {
    filename = cleanFilename(filenameFromDisposition(res.headers.get("content-disposition")) || decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() ?? ""));
    if (await stat(path.join(dir, filename)).catch(() => null)) {
      await res.body?.cancel();
      throw new Error(`${filename} already exists in models/${state.folder}`);
    }
    partPath = path.join(dir, `${filename}.part`);
  }
  const length = Number(res.headers.get("content-length") ?? "");
  const exact = Number.isFinite(length) && length > 0;
  // Civitai's sizeKB is rounded, so it is only used for the progress bar, never for the completeness check.
  const total = exact ? have + length : resolved.size;
  update(state, { filename, total, bytes: have });

  if (total) {
    const fs = await statfs(dir).catch(() => null);
    const free = fs ? fs.bavail * fs.bsize : null;
    if (free !== null && free < total - have + 512 * 1024 * 1024) {
      await res.body?.cancel();
      throw new Error(`not enough disk space: need ${(total / 2 ** 30).toFixed(1)} GiB, ${(free / 2 ** 30).toFixed(1)} GiB free`);
    }
  }
  if (!res.body) throw new Error("empty response");

  const out = createWriteStream(partPath, { flags: have > 0 ? "a" : "w" });
  const outDone = new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      state.bytes += value.byteLength;
      update(state, {});
    }
  } finally {
    out.end();
    await outDone;
  }
  if (exact && total && state.bytes !== total) throw new Error(`download ended early (${state.bytes} of ${total} bytes); start it again to resume`);

  update(state, { total: state.bytes });
  if (resolved.sha256) {
    update(state, { status: "verifying" });
    const got = await sha256File(partPath);
    if (got !== resolved.sha256) {
      await rm(partPath, { force: true });
      throw new Error(`SHA-256 mismatch (expected ${resolved.sha256.slice(0, 12)}..., got ${got.slice(0, 12)}...); the partial file was deleted`);
    }
  }
  await rename(partPath, path.join(dir, filename));
}

async function startRemote(state: DownloadState, resolved: ResolvedSource): Promise<void> {
  const token = isHost(resolved.url, "civitai.com") ? process.env["CIVITAI_TOKEN"] : isHost(resolved.url, "huggingface.co") ? process.env["HF_TOKEN"] : undefined;
  let res: Response;
  try {
    res = await fetch(`${remoteFetcherUrl()}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: resolved.url, filename: resolved.filename, folder: state.folder, sha256: resolved.sha256, size: resolved.size, token: token?.trim() || undefined }),
    });
  } catch {
    throw new Error(
      `the cloud model fetcher is not reachable at ${remoteFetcherUrl()}: re-open the SSH tunnel with "-L 8190:127.0.0.1:8190" and start it on the cloud machine (see docs/CLOUD.md)`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? `cloud fetcher error (HTTP ${res.status})`);
  update(state, { status: "downloading", remoteId: body.id, total: resolved.size });
}

async function refreshRemote(state: DownloadState): Promise<void> {
  if (!state.remoteId || state.status === "done" || state.status === "failed") return;
  try {
    const res = await fetch(`${remoteFetcherUrl()}/status?id=${encodeURIComponent(state.remoteId)}`);
    const s = (await res.json()) as { status?: DownloadStatus; bytes?: number; total?: number | null; filename?: string; error?: string | null };
    if (!res.ok) throw new Error(s.error ?? `HTTP ${res.status}`);
    update(state, {
      status: s.status ?? state.status,
      bytes: s.bytes ?? state.bytes,
      total: s.total ?? state.total,
      filename: s.filename || state.filename,
      error: s.error ?? null,
      finishedAt: s.status === "done" || s.status === "failed" ? new Date().toISOString() : null,
    });
  } catch (err) {
    update(state, { warning: `cannot reach the cloud fetcher right now (${err instanceof Error ? err.message : String(err)}); the download keeps running there` });
  }
}

export async function startDownload(input: { source: unknown; folder: unknown }): Promise<DownloadState> {
  if (typeof input.source !== "string") throw new BadRequestError("source is required");
  if (!DOWNLOAD_FOLDERS.includes(input.folder as DownloadFolder)) throw new BadRequestError("folder must be checkpoints or loras");
  const folder = input.folder as DownloadFolder;
  const endpoint = await getComfyEndpoint();
  const resolved = await resolveSource(input.source);
  const busy = [...store.values()].find(
    (s) => s.folder === folder && s.filename && s.filename === resolved.filename && s.target === endpoint.mode && !["done", "failed"].includes(s.status),
  );
  if (busy) throw new BadRequestError(`${resolved.filename} is already downloading`);
  if (endpoint.mode === "local" && resolved.filename && (await stat(path.join(localModelsDir(folder), resolved.filename)).catch(() => null))) {
    throw new BadRequestError(`${resolved.filename} is already in models/${folder}`);
  }
  const state: DownloadState = {
    id: randomUUID(),
    target: endpoint.mode,
    folder,
    source: input.source.trim(),
    filename: resolved.filename,
    status: "resolving",
    bytes: 0,
    total: resolved.size,
    percent: null,
    error: null,
    civitai: resolved.civitai,
    warning: folderWarning(folder, resolved.civitai),
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  store.set(state.id, state);
  if (endpoint.mode === "remote") {
    try {
      await startRemote(state, resolved);
    } catch (err) {
      update(state, { status: "failed", error: err instanceof Error ? err.message : String(err), finishedAt: new Date().toISOString() });
    }
  } else {
    void runLocal(state, resolved).then(
      () => update(state, { status: "done", finishedAt: new Date().toISOString() }),
      (err: unknown) => update(state, { status: "failed", error: err instanceof Error ? err.message : String(err), finishedAt: new Date().toISOString() }),
    );
  }
  return state;
}

export async function listDownloads(): Promise<DownloadState[]> {
  const all = [...store.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
  await Promise.all(all.filter((s) => s.target === "remote").map(refreshRemote));
  return all;
}

/** Writes (or replaces) CIVITAI_TOKEN in .env.local and applies it to this server process right away. */
export async function saveCivitaiToken(token: unknown): Promise<void> {
  if (typeof token !== "string" || !TOKEN_RE.test(token.trim())) throw new BadRequestError("that does not look like a Civitai API key (letters, digits, - and _ only)");
  const value = token.trim();
  const file = path.join(/* turbopackIgnore: true */ process.cwd(), ".env.local");
  const text = await readFile(file, "utf8").catch(() => "");
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*CIVITAI_TOKEN\s*=/.test(l));
  if (i >= 0) lines[i] = `CIVITAI_TOKEN=${value}`;
  else {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(`CIVITAI_TOKEN=${value}`);
  }
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  process.env["CIVITAI_TOKEN"] = value;
}

export function hasCivitaiToken(): boolean {
  return Boolean(process.env["CIVITAI_TOKEN"]?.trim());
}

/**
 * Minimal, dependency-free ComfyUI client (Node >= 22: global fetch, FormData, Blob, WebSocket).
 */
import { randomUUID } from "node:crypto";
import type { ApiPrompt } from "./workflowInjector";
import type { ObjectInfo } from "./comfySchema";

export interface SystemStats {
  system: { os: string; ram_total: number; ram_free: number; comfyui_version: string; python_version: string; pytorch_version: string };
  devices: { name: string; type: string; index: number; vram_total: number; vram_free: number; torch_vram_total: number; torch_vram_free: number }[];
}

export interface OutputImage {
  filename: string;
  subfolder: string;
  type: "output" | "temp" | "input";
}

export interface ProgressEvent {
  promptId: string;
  node: string | null;
  value: number;
  max: number;
}

export interface RunResult {
  promptId: string;
  images: OutputImage[];
  durationMs: number;
}

export interface RunOptions {
  timeoutMs?: number;
  onProgress?: (event: ProgressEvent) => void;
  onNodeStart?: (node: string) => void;
  signal?: AbortSignal;
}

export class ComfyError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = "ComfyError";
  }
}

interface HistoryEntry {
  outputs?: Record<string, { images?: OutputImage[] }>;
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
}

export class ComfyClient {
  readonly baseUrl: string;
  readonly clientId: string;

  constructor(baseUrl: string = process.env["COMFY_URL"] ?? "http://127.0.0.1:8188", clientId: string = randomUUID()) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.clientId = clientId;
  }

  private async request<T>(pathName: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 30_000);
    try {
      const res = await fetch(`${this.baseUrl}${pathName}`, { ...init, signal: init?.signal ?? controller.signal });
      const text = await res.text();
      if (!res.ok) {
        let details: unknown = text;
        try {
          details = JSON.parse(text);
        } catch {
          /* plain-text error body */
        }
        throw new ComfyError(`${init?.method ?? "GET"} ${pathName} -> HTTP ${res.status}`, details);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  systemStats(): Promise<SystemStats> {
    return this.request<SystemStats>("/system_stats", { timeoutMs: 5_000 });
  }

  async isUp(): Promise<boolean> {
    try {
      await this.systemStats();
      return true;
    } catch {
      return false;
    }
  }

  objectInfo(): Promise<ObjectInfo> {
    return this.request<ObjectInfo>("/object_info", { timeoutMs: 180_000 });
  }

  /** POST /free - unload models and release cached VRAM (the 8 GB engine-switch guard). */
  async free(unloadModels = true, freeMemory = true): Promise<void> {
    await this.request("/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: unloadModels, free_memory: freeMemory }),
    });
  }

  async interrupt(): Promise<void> {
    await this.request("/interrupt", { method: "POST" });
  }

  queueStatus(): Promise<{ queue_running: unknown[]; queue_pending: unknown[] }> {
    return this.request("/queue");
  }

  async queuePrompt(prompt: ApiPrompt): Promise<string> {
    try {
      const res = await this.request<{ prompt_id: string; node_errors?: Record<string, unknown> }>("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: this.clientId }),
      });
      return res.prompt_id;
    } catch (err) {
      if (err instanceof ComfyError) throw new ComfyError(`ComfyUI rejected the prompt: ${summarizeRejection(err.details)}`, err.details);
      throw err;
    }
  }

  async history(promptId: string): Promise<HistoryEntry | undefined> {
    const all = await this.request<Record<string, HistoryEntry>>(`/history/${encodeURIComponent(promptId)}`);
    return all[promptId];
  }

  async uploadImage(data: Uint8Array, filename: string, options: { subfolder?: string; overwrite?: boolean; mask?: boolean } = {}): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(data)], { type: "image/png" }), filename);
    form.append("type", "input");
    form.append("overwrite", options.overwrite === false ? "false" : "true");
    if (options.subfolder) form.append("subfolder", options.subfolder);
    const res = await this.request<{ name: string; subfolder: string }>(options.mask ? "/upload/mask" : "/upload/image", {
      method: "POST",
      body: form,
      timeoutMs: 60_000,
    });
    return res.subfolder ? `${res.subfolder}/${res.name}` : res.name;
  }

  async downloadImage(image: OutputImage): Promise<Uint8Array> {
    const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
    const res = await fetch(`${this.baseUrl}/view?${params.toString()}`);
    if (!res.ok) throw new ComfyError(`GET /view ${image.filename} -> HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Queue a prompt and wait for it to finish. Opens the WebSocket before queueing so no
   * progress event is missed; falls back to polling /history if the socket cannot connect.
   */
  async run(prompt: ApiPrompt, options: RunOptions = {}): Promise<RunResult> {
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const socket = await this.openSocket();
    let promptId = "";
    let settled = false;
    const pollHistory = async (done: (err?: Error) => void): Promise<void> => {
      while (!settled) {
        if (promptId) {
          const entry = await this.history(promptId).catch(() => undefined);
          if (entry?.status?.completed || entry?.status?.status_str === "error") {
            done(entry.status.status_str === "error" ? new ComfyError("execution error", entry.status.messages) : undefined);
            return;
          }
        }
        await sleep(1000);
      }
    };
    const finished = new Promise<void>((resolve, reject) => {
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => done(new ComfyError(`prompt timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      options.signal?.addEventListener("abort", () => {
        void this.interrupt().catch(() => undefined);
        done(new ComfyError("cancelled"));
      });
      if (!socket) {
        void pollHistory(done);
        return;
      }
      socket.addEventListener("message", (ev: MessageEvent) => {
        if (typeof ev.data !== "string") return; // binary preview frames
        let msg: { type: string; data: Record<string, unknown> };
        try {
          msg = JSON.parse(ev.data) as typeof msg;
        } catch {
          return;
        }
        const data = msg.data ?? {};
        if (data["prompt_id"] !== undefined && data["prompt_id"] !== promptId) return;
        switch (msg.type) {
          case "progress":
            options.onProgress?.({ promptId, node: (data["node"] as string) ?? null, value: Number(data["value"]), max: Number(data["max"]) });
            break;
          case "executing":
            if (data["node"] === null) done();
            else if (typeof data["node"] === "string") options.onNodeStart?.(data["node"]);
            break;
          case "execution_success":
            done();
            break;
          case "execution_error":
            done(new ComfyError(`execution error in node ${String(data["node_id"])} (${String(data["node_type"])}): ${String(data["exception_message"]).trim()}`, data));
            break;
          case "execution_interrupted":
            done(new ComfyError("execution interrupted", data));
            break;
          default:
            break;
        }
      });
      // Socket dropped mid-run: fall back to history polling until the prompt settles.
      socket.addEventListener("close", () => void pollHistory(done));
    });
    try {
      promptId = await this.queuePrompt(prompt);
      await finished;
    } finally {
      settled = true;
      socket?.close();
    }
    const entry = await this.history(promptId);
    const images: OutputImage[] = [];
    for (const out of Object.values(entry?.outputs ?? {})) images.push(...(out.images ?? []).filter((i) => i.type === "output"));
    return { promptId, images, durationMs: Date.now() - started };
  }

  private openSocket(): Promise<WebSocket | null> {
    const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/ws?clientId=${encodeURIComponent(this.clientId)}`;
    return new Promise((resolve) => {
      let settled = false;
      try {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            ws.close();
            resolve(null);
          }
        }, 5_000);
        ws.addEventListener("open", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ws);
        });
        ws.addEventListener("error", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(null);
        });
      } catch {
        resolve(null);
      }
    });
  }
}

export function summarizeRejection(details: unknown): string {
  if (typeof details !== "object" || details === null) return String(details);
  const d = details as { error?: { message?: string; details?: string }; node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }> };
  const parts: string[] = [];
  if (d.error?.message) parts.push(`${d.error.message}${d.error.details ? ` (${d.error.details})` : ""}`);
  for (const [node, ne] of Object.entries(d.node_errors ?? {})) {
    for (const e of ne.errors ?? []) parts.push(`node ${node} ${ne.class_type ?? ""}: ${e.message ?? ""} ${e.details ?? ""}`.trim());
  }
  return parts.join("; ") || JSON.stringify(details).slice(0, 500);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

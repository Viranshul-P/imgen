/**
 * Which ComfyUI the studio and the worker talk to.
 *
 *   local  - the laptop GPU (COMFY_URL, default http://127.0.0.1:8188). Strict 8 GB rules apply.
 *   remote - a cloud GPU reached through an SSH tunnel (COMFY_REMOTE_URL, default http://127.0.0.1:8189).
 *            The 8 GB restrictions are lifted: native FP16 Flux, larger renders, and no VRAM flush between
 *            jobs of the same model family.
 *
 * The choice lives in the WorkerState row so the Next.js server and the worker process always agree.
 */
import { ComfyClient } from "./comfyClient";
import { prisma } from "./prisma";
import { BadRequestError } from "./types";

export const ENDPOINT_MODES = ["local", "remote"] as const;
export type EndpointMode = (typeof ENDPOINT_MODES)[number];

export interface ComfyEndpoint {
  mode: EndpointMode;
  /** URL of the ComfyUI currently in use. */
  url: string;
  localUrl: string;
  /** URL used when the mode is remote. */
  remoteUrl: string;
  remote: boolean;
}

export function localComfyUrl(): string {
  return (process.env["COMFY_URL"] ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
}

export function defaultRemoteUrl(): string {
  return (process.env["COMFY_REMOTE_URL"] ?? "http://127.0.0.1:8189").replace(/\/+$/, "");
}

/** Returns the normalised URL, or throws BadRequestError. Only plain http(s) URLs without credentials are accepted. */
export function validateComfyUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new BadRequestError("enter a full URL such as http://127.0.0.1:8189");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BadRequestError("the cloud GPU URL must start with http:// or https://");
  if (url.username || url.password) throw new BadRequestError("do not put a username or password in the URL");
  return `${url.protocol}//${url.host}`;
}

export async function getComfyEndpoint(): Promise<ComfyEndpoint> {
  const row = await prisma.workerState.findUnique({ where: { id: 1 }, select: { endpointMode: true, remoteUrl: true } });
  const mode: EndpointMode = row?.endpointMode === "remote" ? "remote" : "local";
  const localUrl = localComfyUrl();
  const remoteUrl = row?.remoteUrl ? row.remoteUrl : defaultRemoteUrl();
  return { mode, url: mode === "remote" ? remoteUrl : localUrl, localUrl, remoteUrl, remote: mode === "remote" };
}

export async function getComfyClient(): Promise<ComfyClient> {
  return new ComfyClient((await getComfyEndpoint()).url);
}

export async function setComfyEndpoint(change: { mode?: unknown; remoteUrl?: unknown }): Promise<ComfyEndpoint> {
  const data: { endpointMode?: EndpointMode; remoteUrl?: string } = {};
  if (change.mode !== undefined) {
    if (change.mode !== "local" && change.mode !== "remote") throw new BadRequestError("mode must be local or remote");
    data.endpointMode = change.mode;
  }
  if (change.remoteUrl !== undefined) {
    if (typeof change.remoteUrl !== "string") throw new BadRequestError("remoteUrl must be text");
    data.remoteUrl = change.remoteUrl.trim() === "" ? "" : validateComfyUrl(change.remoteUrl);
  }
  await prisma.workerState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  return getComfyEndpoint();
}

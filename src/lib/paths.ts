/** DATA_DIR layout and traversal-safe path helpers (server-side only). */
import { mkdir } from "node:fs/promises";
import path from "node:path";

export const DATA_SUBDIRS = ["raw", "finished", "uploads", "masks", "datasets", "exports"] as const;
export type DataSubdir = (typeof DATA_SUBDIRS)[number];

export function dataRoot(): string {
  // Runtime user-data location: excluded from Next.js build tracing on purpose.
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env["DATA_DIR"] ?? "./data");
}

/** Resolve a DATA_DIR-relative path, refusing anything that escapes the data directory. */
export function resolveDataPath(relative: string): string {
  const root = dataRoot();
  const full = path.resolve(/* turbopackIgnore: true */ root, relative.replace(/^[/\\]+/, ""));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`path escapes DATA_DIR: ${relative}`);
  return full;
}

/** DATA_DIR-relative, forward-slash form stored in the database. */
export function toDataRelative(full: string): string {
  return path.relative(dataRoot(), full).split(path.sep).join("/");
}

export async function ensureDataDirs(): Promise<void> {
  await Promise.all(DATA_SUBDIRS.map((d) => mkdir(path.join(/* turbopackIgnore: true */ dataRoot(), d), { recursive: true })));
}

export function safeFileStem(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";
}

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { resolveDataPath } from "@/lib/paths";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".zip": "application/zip",
};

/** GET /api/files/<DATA_DIR-relative path> - serves generated images and exports (no traversal). */
export async function GET(_request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await context.params;
  let full: string;
  try {
    full = resolveDataPath(segments.map(decodeURIComponent).join("/"));
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const info = await stat(full);
    if (!info.isFile()) return new Response("not found", { status: 404 });
    const body = await readFile(full);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": String(info.size),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

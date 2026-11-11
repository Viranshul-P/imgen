/** Route-handler helpers: JSON responses and consistent error mapping. */
import { NextResponse } from "next/server";
import { ComfyError } from "./comfyClient";
import { BadRequestError } from "./types";
import { WorkflowInjectionError } from "./workflowInjector";

export function json<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status });
}

export function errorResponse(err: unknown): NextResponse<{ error: string; details?: unknown }> {
  if (err instanceof BadRequestError || err instanceof WorkflowInjectionError) return NextResponse.json({ error: err.message }, { status: 400 });
  if (err instanceof ComfyError) return NextResponse.json({ error: err.message, details: err.details }, { status: 502 });
  const message = err instanceof Error ? err.message : String(err);
  console.error("[api]", err);
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new BadRequestError("request body must be JSON");
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestError(`${field} is required`);
  return value.trim();
}

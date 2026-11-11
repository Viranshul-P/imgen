/**
 * Run a PersonaForge Python script with ComfyUI's embedded interpreter (COMFY_PYTHON).
 *
 * Always isolated (-I): without it numpy/Pillow from the Windows user site-packages can shadow the
 * embedded ones. Scripts print one JSON object as their last stdout line; errors go to stderr.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function pythonPath(): string {
  const python = process.env["COMFY_PYTHON"];
  if (!python) throw new Error("COMFY_PYTHON is not set in .env.local (Phase 0 writes it)");
  if (!existsSync(python)) throw new Error(`COMFY_PYTHON not found: ${python}`);
  return python;
}

export function projectScript(name: string): string {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), "scripts", name);
}

/** Run scripts/<script> with args; resolves with the parsed JSON summary line. */
export async function runPythonJson<T>(script: string, args: string[], timeoutMs = 10 * 60_000): Promise<T> {
  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(pythonPath(), ["-I", projectScript(script), ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, code: exitCode });
    });
  });
  if (code !== 0) {
    const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ") || "no output";
    throw new PythonScriptError(`${script} failed (exit ${code}): ${detail}`, code === 2);
  }
  try {
    return JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "") as T;
  } catch {
    throw new Error(`${script} returned unreadable output: ${stdout.slice(0, 300)}`);
  }
}

/** Exit code 2 = the script rejected its input (maps to HTTP 400). */
export class PythonScriptError extends Error {
  constructor(
    message: string,
    readonly userError: boolean,
  ) {
    super(message);
    this.name = "PythonScriptError";
  }
}

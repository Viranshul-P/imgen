/**
 * PersonaForge Phase 3 - live-schema workflow validator and 2-step smoke tester.
 *
 *   npm run validate:workflows                  # static matrix + smoke runs
 *   npm run validate:workflows -- --static-only # schema checks only (no GPU work)
 *   npm run validate:workflows -- --only engine_a_flux_lifestyle,engine_c_wardrobe_inpaint
 *
 * Static: every class_type (including variants) must be registered, and every feature /
 * variant combination of every template must inject cleanly and pass validatePrompt()
 * against GET /object_info.
 * Smoke: each runnable template executes at 256x256 with 2 steps through ComfyUI, with a
 * POST /free VRAM flush whenever the engine or checkpoint changes (same rule as the worker).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ComfyClient, sleep } from "../src/lib/comfyClient";
import { type ObjectInfo, optionsFor, validatePrompt } from "../src/lib/comfySchema";
import { encodePngRgb } from "../src/lib/png";
import {
  type InjectOptions,
  type LoraSpec,
  type WorkflowTemplate,
  injectWorkflow,
  isLink,
  listTemplates,
  loadTemplate,
  templateClassTypes,
} from "../src/lib/workflowInjector";

const args = process.argv.slice(2);
const staticOnly = args.includes("--static-only");
const onlyArg = args.find((a) => a.startsWith("--only"));
const onlyIdx = args.indexOf("--only");
const only = new Set(
  (onlyArg?.includes("=") ? onlyArg.split("=")[1] : onlyIdx >= 0 ? args[onlyIdx + 1] : "")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [],
);

const SMOKE_IMAGE = "pf_smoke_base.png";
const SMOKE_MASK = "pf_smoke_mask.png";
/** Templates whose smoke run needs a real face photo (IP-Adapter FaceID raises on "no face"). */
const NEEDS_REAL_FACE = new Set(["genesis_dataset"]);

// Fallback pickers when a template's default model is not (yet) installed.
const MODEL_HINTS: Record<string, RegExp> = {
  SDXL_CHECKPOINT_NAME: /xl/i,
  UNET_NAME: /flux/i,
  CLIP_T5_NAME: /t5/i,
  CLIP_L_NAME: /clip_l/i,
  FACE_DETECTOR: /face/i,
  HAND_DETECTOR: /hand/i,
  CONTROLNET_POSE_NAME: /pose/i,
  CONTROLNET_DEPTH_NAME: /depth/i,
  UPSCALE_MODEL: /./,
};

interface Usage {
  classType: string;
  input: string;
}

interface CheckResult {
  template: string;
  combo: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

interface SmokeResult {
  template: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
  seconds?: number;
  images?: string[];
}

function placeholderUsages(t: WorkflowTemplate): Map<string, Usage[]> {
  const usages = new Map<string, Usage[]>();
  const visit = (classType: string, inputs: Record<string, unknown>): void => {
    for (const [input, value] of Object.entries(inputs)) {
      if (typeof value !== "string") continue;
      const m = /^\{\{([A-Z0-9_]+)\}\}$/.exec(value);
      if (!m?.[1]) continue;
      const list = usages.get(m[1]) ?? [];
      list.push({ classType, input });
      usages.set(m[1], list);
    }
  };
  for (const node of Object.values(t.nodes)) {
    visit(node.class_type, node.inputs);
    for (const v of Object.values(node._meta?.pf?.variants ?? {})) visit(v.class_type ?? node.class_type, { ...node.inputs, ...(v.inputs ?? {}) });
  }
  return usages;
}

/** Choose a value for every model / image placeholder from what the server actually offers. */
function resolveModelValues(t: WorkflowTemplate, info: ObjectInfo): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const usages = placeholderUsages(t);
  for (const [key, def] of Object.entries(t.meta.placeholders)) {
    if (!def.modelCategory) continue;
    if (def.modelCategory === "input_image") {
      values[key] = key === "USER_MASK_IMAGE" ? SMOKE_MASK : SMOKE_IMAGE;
      continue;
    }
    const use = usages.get(key)?.[0];
    if (!use) continue;
    const options = optionsFor(info, use.classType, use.input);
    const preferred = String(def.default);
    let hint = MODEL_HINTS[key];
    // Never fall back to the TAESD preview decoders (taesdxl) for real renders.
    if (key === "VAE_NAME") hint = t.meta.engine === "FLUX_GGUF" ? /^ae\./i : /sdxl_vae|fp16-fix/i;
    const pick = options.includes(preferred) ? preferred : options.find((o) => hint?.test(o));
    if (pick) values[key] = pick;
    else missing.push(`${key} (default ${preferred}; ${use.classType}.${use.input} offers ${options.length ? options.join(", ") : "nothing"})`);
  }
  return { values, missing };
}

function smokeLora(t: WorkflowTemplate, info: ObjectInfo): LoraSpec[] {
  const loras = optionsFor(info, "LoraLoader", "lora_name");
  const name =
    t.meta.engine === "FLUX_GGUF"
      ? loras.find((l) => /flux/i.test(l))
      : loras.find((l) => /sd_xl|sdxl|xl/i.test(l) && !/faceid/i.test(l));
  return name ? [{ name, strengthModel: 0.5, strengthClip: 0.5 }] : [];
}

function combos(t: WorkflowTemplate): { label: string; opts: InjectOptions }[] {
  const features = Object.keys(t.meta.features);
  const allOn = Object.fromEntries(features.map((f) => [f, true]));
  const allOff = Object.fromEntries(features.map((f) => [f, false]));
  const list: { label: string; opts: InjectOptions }[] = [{ label: "defaults", opts: {} }];
  if (features.length) list.push({ label: "all-features-off", opts: { features: allOff } });
  const variantGroups = Object.entries(t.meta.variants ?? {});
  if (variantGroups.length === 0 && features.length) list.push({ label: "all-features-on", opts: { features: allOn } });
  for (const [group, def] of variantGroups) {
    for (const option of def.options) list.push({ label: `all-features-on ${group}=${option}`, opts: { features: allOn, variants: { [group]: option } } });
  }
  return list;
}

function smokeValues(t: WorkflowTemplate, base: Record<string, string>): Record<string, string | number | boolean> {
  const p = t.meta.placeholders;
  const v: Record<string, string | number | boolean> = { ...base };
  const set = (k: string, value: string | number): void => {
    if (k in p) v[k] = value;
  };
  set("WIDTH", 256);
  set("HEIGHT", 256);
  set("STEPS", 2);
  set("DETAILER_STEPS", 2);
  set("HIRES_WIDTH", 384);
  set("HIRES_HEIGHT", 384);
  set("HIRES_STEPS", 2);
  set("CROP_TARGET_WIDTH", 256);
  set("CROP_TARGET_HEIGHT", 256);
  set("OUTPUT_WIDTH", 216);
  set("OUTPUT_HEIGHT", 270);
  set("CONTROL_RESOLUTION", 256);
  set("SEED", 1234);
  set("POSITIVE_PROMPT", "smoke test, casual phone photo of a living room");
  set("NEGATIVE_PROMPT", "blurry");
  set("FILENAME_PREFIX", `personaforge/smoke/${t.meta.name}`);
  return v;
}

async function uploadSmokeInputs(client: ComfyClient): Promise<void> {
  const base = encodePngRgb(256, 256, (x, y) => [Math.round((x / 255) * 200) + 30, Math.round((y / 255) * 160) + 40, 140]);
  const mask = encodePngRgb(256, 256, (x, y) => (x > 80 && x < 176 && y > 96 && y < 208 ? [255, 255, 255] : [0, 0, 0]));
  await client.uploadImage(base, SMOKE_IMAGE);
  await client.uploadImage(mask, SMOKE_MASK);
}

async function main(): Promise<number> {
  const client = new ComfyClient();
  if (!(await client.isUp())) {
    console.error(`ComfyUI is not reachable at ${client.baseUrl}. Start it with scripts/start_comfy_api.ps1 -Background`);
    return 2;
  }
  await uploadSmokeInputs(client);
  console.log("Fetching /object_info ...");
  const info = await client.objectInfo();
  console.log(`  ${Object.keys(info).length} node classes registered\n`);

  const names = (await listTemplates()).filter((n) => only.size === 0 || only.has(n));
  const templates = await Promise.all(names.map((n) => loadTemplate(n)));
  const checks: CheckResult[] = [];
  const modelValues = new Map<string, { values: Record<string, string>; missing: string[] }>();

  console.log("== Static validation (live schema) ==");
  for (const t of templates) {
    const unknown = templateClassTypes(t).filter((c) => !info[c]);
    if (unknown.length) {
      checks.push({ template: t.meta.name, combo: "class_types", ok: false, errors: unknown.map((c) => `unregistered class_type ${c}`), warnings: [] });
      console.log(`  FAIL ${t.meta.name}: unregistered ${unknown.join(", ")}`);
      continue;
    }
    const resolved = resolveModelValues(t, info);
    modelValues.set(t.meta.name, resolved);
    // Inputs fed by models that are not installed yet cannot pass enum checks; report them separately.
    const missingKeys = new Set(resolved.missing.map((m) => m.split(" ")[0] as string));
    const skipEnumFor = new Set<string>();
    for (const [key, uses] of placeholderUsages(t)) if (missingKeys.has(key)) for (const u of uses) skipEnumFor.add(u.input);

    for (const { label, opts } of combos(t)) {
      const errors: string[] = [];
      const warnings: string[] = resolved.missing.map((m) => `model not installed yet: ${m}`);
      try {
        const prompt = injectWorkflow(t, { ...opts, values: { ...resolved.values, ...smokeValues(t, {}) }, loras: smokeLora(t, info) });
        for (const node of Object.values(prompt)) {
          if ("batch_size" in node.inputs && node.inputs["batch_size"] !== 1) errors.push(`batch_size is ${String(node.inputs["batch_size"])}`);
          for (const value of Object.values(node.inputs)) if (typeof value === "string" && value.includes("{{")) errors.push(`unfilled placeholder ${value}`);
        }
        for (const issue of validatePrompt(prompt, info, { skipEnumFor })) {
          (issue.level === "error" ? errors : warnings).push(`node ${issue.node} ${issue.classType}: ${issue.message}`);
        }
        const loraNodes = Object.values(prompt).filter((n) => n.class_type.startsWith("LoraLoader")).length;
        if (smokeLora(t, info).length && loraNodes === 0) errors.push("LoRA chain was not inserted");
        const dangling = Object.entries(prompt).flatMap(([id, n]) =>
          Object.entries(n.inputs).filter(([, v]) => isLink(v) && !prompt[v[0]]).map(([k]) => `${id}.${k}`),
        );
        if (dangling.length) errors.push(`dangling links: ${dangling.join(", ")}`);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
      checks.push({ template: t.meta.name, combo: label, ok: errors.length === 0, errors, warnings });
      console.log(`  ${errors.length ? "FAIL" : "ok  "} ${t.meta.name.padEnd(34)} ${label}`);
      for (const e of errors) console.log(`         x ${e}`);
    }
  }
  for (const [name, r] of modelValues) for (const m of r.missing) console.log(`  note ${name}: model not installed yet -> ${m}`);

  const smoke: SmokeResult[] = [];
  if (!staticOnly) {
    console.log("\n== Smoke runs (256x256, 2 steps) ==");
    let loaded: string | null = null;
    for (const t of templates) {
      const resolved = modelValues.get(t.meta.name);
      if (!resolved) continue;
      if (checks.some((c) => c.template === t.meta.name && c.combo === "defaults" && !c.ok)) {
        smoke.push({ template: t.meta.name, status: "skipped", detail: "static validation failed" });
        continue;
      }
      if (resolved.missing.length) {
        smoke.push({ template: t.meta.name, status: "skipped", detail: `missing models: ${resolved.missing.map((m) => m.split(" ")[0]).join(", ")}` });
        console.log(`  skip ${t.meta.name}: models not installed yet`);
        continue;
      }
      if (NEEDS_REAL_FACE.has(t.meta.name)) {
        smoke.push({ template: t.meta.name, status: "skipped", detail: "needs a real master_face photo (validated statically; exercised in Phase 7)" });
        console.log(`  skip ${t.meta.name}: needs a real face reference`);
        continue;
      }
      const engineKey = `${t.meta.engine}:${resolved.values["SDXL_CHECKPOINT_NAME"] ?? resolved.values["UNET_NAME"] ?? ""}`;
      if (loaded !== null && loaded !== engineKey) {
        console.log(`  VRAM flush: ${loaded} -> ${engineKey}`);
        await client.free();
        await sleep(1500);
      }
      loaded = engineKey;
      const prompt = injectWorkflow(t, { values: smokeValues(t, resolved.values), loras: smokeLora(t, info) });
      process.stdout.write(`  run  ${t.meta.name.padEnd(34)} `);
      try {
        let lastPct = -1;
        const result = await client.run(prompt, {
          timeoutMs: 20 * 60_000,
          onProgress: (p) => {
            const pct = Math.round((p.value / Math.max(p.max, 1)) * 100);
            if (pct !== lastPct && pct % 50 === 0) {
              lastPct = pct;
              process.stdout.write(".");
            }
          },
        });
        const seconds = Math.round(result.durationMs / 100) / 10;
        if (result.images.length === 0) throw new Error("finished without saving an image");
        smoke.push({ template: t.meta.name, status: "passed", detail: "ok", seconds, images: result.images.map((i) => `${i.subfolder}/${i.filename}`) });
        console.log(` passed in ${seconds}s -> ${result.images.map((i) => i.filename).join(", ")}`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        smoke.push({ template: t.meta.name, status: "failed", detail });
        console.log(` FAILED\n         x ${detail}`);
      }
    }
    await client.free().catch(() => undefined);
  }

  const report = { checkedAt: new Date().toISOString(), server: client.baseUrl, staticChecks: checks, smoke };
  const reportPath = path.join(process.cwd(), "logs", "validate_report.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  const staticFail = checks.filter((c) => !c.ok).length;
  const smokeFail = smoke.filter((s) => s.status === "failed").length;
  console.log(`\nStatic: ${checks.length - staticFail}/${checks.length} combos ok. Smoke: ${smoke.filter((s) => s.status === "passed").length} passed, ${smokeFail} failed, ${smoke.filter((s) => s.status === "skipped").length} skipped.`);
  console.log(`Report: ${reportPath}`);
  return staticFail || smokeFail ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

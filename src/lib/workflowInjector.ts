/**
 * workflowInjector - turns a PersonaForge workflow template (ComfyUI API-format JSON plus a
 * `_pf` metadata block) into an executable ComfyUI prompt graph.
 *
 * Steps, in order:
 *   1. variants   - swap node class/inputs for a selected variant (e.g. pose vs depth preprocessor)
 *   2. features   - drop optional nodes whose feature is disabled and rewire their consumers
 *                   through each removed node's declared `bypass` (output index -> input name)
 *   3. LoRA chain - insert native LoraLoader / LoraLoaderModelOnly nodes after each LoRA anchor
 *                   and move every consumer of the anchor onto the end of the chain
 *   4. values     - fill `{{PLACEHOLDER}}` inputs with typed, range-checked values
 *   5. safety     - force batch_size = 1 everywhere (8 GB VRAM rule), strip PersonaForge metadata
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type Link = [string, number];
export type InputValue = string | number | boolean | Link | null;

export interface PfVariant {
  class_type?: string;
  inputs?: Record<string, InputValue>;
}

export interface PfNodeMeta {
  optional?: string;
  bypass?: Record<string, string>;
  variantKey?: string;
  variants?: Record<string, PfVariant>;
}

export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, InputValue>;
  _meta?: { title?: string; pf?: PfNodeMeta };
}

export type PlaceholderType = "string" | "int" | "float" | "bool";

export interface PlaceholderDef {
  type: PlaceholderType;
  default: string | number | boolean;
  min?: number;
  max?: number;
  /** Hint for UIs/validators about which model list or upload a value comes from. */
  modelCategory?: string;
}

export interface FeatureDef {
  default: boolean;
  description: string;
}

export interface VariantGroupDef {
  default: string;
  options: string[];
}

export type LoraAnchorMode = "model" | "model_clip";

export interface TemplateMeta {
  name: string;
  engine: EngineKind;
  description: string;
  placeholders: Record<string, PlaceholderDef>;
  features: Record<string, FeatureDef>;
  variants?: Record<string, VariantGroupDef>;
  loraAnchors: { node: string; mode: LoraAnchorMode }[];
}

export type EngineKind = "FLUX_GGUF" | "SDXL";

export interface WorkflowTemplate {
  meta: TemplateMeta;
  nodes: Record<string, WorkflowNode>;
}

export interface LoraSpec {
  name: string;
  strengthModel: number;
  /** Ignored for model-only anchors (Flux). Defaults to strengthModel. */
  strengthClip?: number;
}

export interface InjectOptions {
  values?: Record<string, string | number | boolean>;
  features?: Record<string, boolean>;
  variants?: Record<string, string>;
  loras?: LoraSpec[];
}

export interface ApiNode {
  class_type: string;
  inputs: Record<string, InputValue>;
  _meta?: { title?: string };
}

export type ApiPrompt = Record<string, ApiNode>;

export const LORA_STRENGTH_MIN = -1;
export const LORA_STRENGTH_MAX = 2;

export class WorkflowInjectionError extends Error {
  constructor(template: string, message: string) {
    super(`[${template}] ${message}`);
    this.name = "WorkflowInjectionError";
  }
}

const PLACEHOLDER_EXACT = /^\{\{([A-Z0-9_]+)\}\}$/;
const PLACEHOLDER_ANY = /\{\{([A-Z0-9_]+)\}\}/g;

export function isLink(value: unknown): value is Link {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

// ------------------------------------------------------------------------------ loading
export function defaultWorkflowDir(): string {
  return path.join(process.cwd(), "workflows");
}

export function parseTemplate(raw: unknown, sourceName: string): WorkflowTemplate {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkflowInjectionError(sourceName, "template root must be an object");
  }
  const record = raw as Record<string, unknown>;
  const meta = record["_pf"] as TemplateMeta | undefined;
  if (!meta || typeof meta.name !== "string" || typeof meta.placeholders !== "object") {
    throw new WorkflowInjectionError(sourceName, "missing or invalid _pf metadata block");
  }
  const nodes: Record<string, WorkflowNode> = {};
  for (const [id, value] of Object.entries(record)) {
    if (id === "_pf") continue;
    const node = value as WorkflowNode;
    if (!node || typeof node.class_type !== "string" || typeof node.inputs !== "object") {
      throw new WorkflowInjectionError(sourceName, `node ${id} is not a valid API-format node`);
    }
    nodes[id] = node;
  }
  return { meta: { ...meta, features: meta.features ?? {}, loraAnchors: meta.loraAnchors ?? [] }, nodes };
}

export async function loadTemplate(name: string, dir: string = defaultWorkflowDir()): Promise<WorkflowTemplate> {
  const file = path.join(dir, name.endsWith(".json") ? name : `${name}_api.json`);
  const raw: unknown = JSON.parse(await readFile(file, "utf-8"));
  return parseTemplate(raw, path.basename(file));
}

export async function listTemplates(dir: string = defaultWorkflowDir()): Promise<string[]> {
  const files = await readdir(dir);
  return files.filter((f) => f.endsWith("_api.json")).map((f) => f.replace(/_api\.json$/, "")).sort();
}

/** Every class_type a template can produce, including variant alternatives. */
export function templateClassTypes(template: WorkflowTemplate): string[] {
  const types = new Set<string>(["LoraLoader", "LoraLoaderModelOnly"]);
  for (const node of Object.values(template.nodes)) {
    types.add(node.class_type);
    for (const variant of Object.values(node._meta?.pf?.variants ?? {})) {
      if (variant.class_type) types.add(variant.class_type);
    }
  }
  return [...types].sort();
}

// ------------------------------------------------------------------------------ injection
function cloneNodes(nodes: Record<string, WorkflowNode>): Record<string, WorkflowNode> {
  return JSON.parse(JSON.stringify(nodes)) as Record<string, WorkflowNode>;
}

function applyVariants(t: WorkflowTemplate, nodes: Record<string, WorkflowNode>, chosen: Record<string, string>): void {
  const groups = t.meta.variants ?? {};
  for (const key of Object.keys(chosen)) {
    const group = groups[key];
    if (!group) throw new WorkflowInjectionError(t.meta.name, `unknown variant group '${key}'`);
    if (!group.options.includes(chosen[key] as string)) {
      throw new WorkflowInjectionError(t.meta.name, `variant '${key}' must be one of ${group.options.join(", ")}`);
    }
  }
  for (const node of Object.values(nodes)) {
    const pf = node._meta?.pf;
    if (!pf?.variantKey) continue;
    const group = groups[pf.variantKey];
    if (!group) throw new WorkflowInjectionError(t.meta.name, `node uses undeclared variant group '${pf.variantKey}'`);
    const selected = chosen[pf.variantKey] ?? group.default;
    if (selected === group.default) continue;
    const variant = pf.variants?.[selected];
    if (!variant) continue;
    if (variant.class_type) {
      node.class_type = variant.class_type;
      node.inputs = { ...(variant.inputs ?? {}) };
    } else if (variant.inputs) {
      node.inputs = { ...node.inputs, ...variant.inputs };
    }
  }
}

function resolveFeatures(t: WorkflowTemplate, requested: Record<string, boolean>): Record<string, boolean> {
  const enabled: Record<string, boolean> = {};
  for (const [key, def] of Object.entries(t.meta.features)) enabled[key] = def.default;
  for (const [key, value] of Object.entries(requested)) {
    if (!(key in t.meta.features)) {
      throw new WorkflowInjectionError(t.meta.name, `unknown feature '${key}' (known: ${Object.keys(t.meta.features).join(", ") || "none"})`);
    }
    enabled[key] = value;
  }
  return enabled;
}

function removeDisabled(t: WorkflowTemplate, nodes: Record<string, WorkflowNode>, enabled: Record<string, boolean>): void {
  const original = cloneNodes(nodes);
  const removed = new Set(
    Object.entries(nodes)
      .filter(([, n]) => n._meta?.pf?.optional !== undefined && !enabled[n._meta.pf.optional])
      .map(([id]) => id),
  );
  if (removed.size === 0) return;

  const resolve = (link: Link, trail: string[]): Link => {
    const [sourceId, outputIndex] = link;
    if (!removed.has(sourceId)) return link;
    if (trail.includes(sourceId)) throw new WorkflowInjectionError(t.meta.name, `bypass cycle through ${trail.join(" -> ")}`);
    const source = original[sourceId];
    const inputName = source?._meta?.pf?.bypass?.[String(outputIndex)];
    if (!source || !inputName) {
      throw new WorkflowInjectionError(
        t.meta.name,
        `node ${sourceId} (${source?.class_type ?? "?"}) was removed but output ${outputIndex} has no bypass`,
      );
    }
    const upstream = source.inputs[inputName];
    if (!isLink(upstream)) {
      throw new WorkflowInjectionError(t.meta.name, `bypass input '${inputName}' of node ${sourceId} is not a link`);
    }
    return resolve(upstream, [...trail, sourceId]);
  };

  for (const id of removed) delete nodes[id];
  for (const [id, node] of Object.entries(nodes)) {
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (isLink(value) && removed.has(value[0])) {
        try {
          node.inputs[inputName] = resolve(value, []);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          throw new WorkflowInjectionError(t.meta.name, `cannot rewire ${id}.${inputName}: ${why}`);
        }
      }
    }
  }
}

function nextNodeId(nodes: Record<string, WorkflowNode>): () => string {
  let max = Math.max(0, ...Object.keys(nodes).map((k) => Number.parseInt(k, 10)).filter(Number.isFinite));
  return () => String(++max);
}

function insertLoraChains(t: WorkflowTemplate, nodes: Record<string, WorkflowNode>, loras: LoraSpec[]): void {
  if (loras.length === 0) return;
  for (const lora of loras) {
    if (!lora.name) throw new WorkflowInjectionError(t.meta.name, "LoRA entry without a name");
    for (const s of [lora.strengthModel, lora.strengthClip ?? lora.strengthModel]) {
      if (!Number.isFinite(s) || s < LORA_STRENGTH_MIN || s > LORA_STRENGTH_MAX) {
        throw new WorkflowInjectionError(t.meta.name, `LoRA '${lora.name}' strength ${s} outside ${LORA_STRENGTH_MIN}..${LORA_STRENGTH_MAX}`);
      }
    }
  }
  const newId = nextNodeId(nodes);
  for (const anchor of t.meta.loraAnchors) {
    if (!nodes[anchor.node]) throw new WorkflowInjectionError(t.meta.name, `LoRA anchor node ${anchor.node} missing`);
    const chainIds: string[] = [];
    let modelSrc: Link = [anchor.node, 0];
    let clipSrc: Link = [anchor.node, 1];
    const chainNodes: Record<string, WorkflowNode> = {};
    for (const lora of loras) {
      const id = newId();
      if (anchor.mode === "model") {
        chainNodes[id] = {
          class_type: "LoraLoaderModelOnly",
          inputs: { model: modelSrc, lora_name: lora.name, strength_model: lora.strengthModel },
          _meta: { title: `LoRA ${lora.name}` },
        };
      } else {
        chainNodes[id] = {
          class_type: "LoraLoader",
          inputs: {
            model: modelSrc,
            clip: clipSrc,
            lora_name: lora.name,
            strength_model: lora.strengthModel,
            strength_clip: lora.strengthClip ?? lora.strengthModel,
          },
          _meta: { title: `LoRA ${lora.name}` },
        };
        clipSrc = [id, 1];
      }
      modelSrc = [id, 0];
      chainIds.push(id);
    }
    // Move every existing consumer of the anchor's MODEL (and CLIP) onto the end of the chain.
    for (const node of Object.values(nodes)) {
      for (const [name, value] of Object.entries(node.inputs)) {
        if (!isLink(value) || value[0] !== anchor.node) continue;
        if (value[1] === 0) node.inputs[name] = modelSrc;
        else if (value[1] === 1 && anchor.mode === "model_clip") node.inputs[name] = clipSrc;
      }
    }
    Object.assign(nodes, chainNodes);
  }
}

function coerce(t: WorkflowTemplate, key: string, def: PlaceholderDef, raw: string | number | boolean): string | number | boolean {
  const fail = (why: string): never => {
    throw new WorkflowInjectionError(t.meta.name, `placeholder ${key}: ${why}`);
  };
  switch (def.type) {
    case "string":
      return String(raw);
    case "bool":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "false") return raw === "true";
      return fail(`expected boolean, got ${JSON.stringify(raw)}`);
    case "int":
    case "float": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) fail(`expected number, got ${JSON.stringify(raw)}`);
      if (def.type === "int" && !Number.isInteger(n)) fail(`expected integer, got ${n}`);
      if (def.min !== undefined && n < def.min) fail(`${n} below minimum ${def.min}`);
      if (def.max !== undefined && n > def.max) fail(`${n} above maximum ${def.max}`);
      return n;
    }
  }
}

function fillPlaceholders(t: WorkflowTemplate, nodes: Record<string, WorkflowNode>, values: Record<string, string | number | boolean>): void {
  for (const key of Object.keys(values)) {
    if (!(key in t.meta.placeholders)) throw new WorkflowInjectionError(t.meta.name, `unknown placeholder value '${key}'`);
  }
  const valueOf = (key: string): string | number | boolean => {
    const def = t.meta.placeholders[key];
    if (!def) throw new WorkflowInjectionError(t.meta.name, `template references undeclared placeholder {{${key}}}`);
    return coerce(t, key, def, values[key] ?? def.default);
  };
  for (const node of Object.values(nodes)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string") continue;
      const exact = PLACEHOLDER_EXACT.exec(value);
      if (exact?.[1]) {
        node.inputs[name] = valueOf(exact[1]);
      } else if (value.includes("{{")) {
        node.inputs[name] = value.replace(PLACEHOLDER_ANY, (_, k: string) => String(valueOf(k)));
      }
    }
  }
}

/** Build an executable ComfyUI API prompt from a template. Pure: the template is not mutated. */
export function injectWorkflow(template: WorkflowTemplate, options: InjectOptions = {}): ApiPrompt {
  const nodes = cloneNodes(template.nodes);
  applyVariants(template, nodes, options.variants ?? {});
  removeDisabled(template, nodes, resolveFeatures(template, options.features ?? {}));
  insertLoraChains(template, nodes, options.loras ?? []);
  fillPlaceholders(template, nodes, options.values ?? {});

  const prompt: ApiPrompt = {};
  for (const [id, node] of Object.entries(nodes)) {
    if ("batch_size" in node.inputs) node.inputs["batch_size"] = 1;
    for (const [name, value] of Object.entries(node.inputs)) {
      if (isLink(value) && !nodes[value[0]]) {
        throw new WorkflowInjectionError(template.meta.name, `${id}.${name} links to missing node ${value[0]}`);
      }
    }
    prompt[id] = { class_type: node.class_type, inputs: node.inputs, _meta: { title: node._meta?.title ?? node.class_type } };
  }
  return prompt;
}

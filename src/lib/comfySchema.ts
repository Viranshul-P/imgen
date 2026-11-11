/**
 * Validation of ComfyUI API prompts against the live `GET /object_info` schema.
 * Catches wrong class_type names, missing/unknown inputs, enum values the server would
 * reject, out-of-range numbers and type-mismatched links before anything is queued.
 */
import { type ApiPrompt, isLink } from "./workflowInjector";

export type InputSpec = [unknown, Record<string, unknown>?] | [unknown];

export interface NodeSchema {
  input: {
    required?: Record<string, InputSpec>;
    optional?: Record<string, InputSpec>;
    hidden?: Record<string, unknown>;
  };
  output: string[];
  output_name?: string[];
  name?: string;
  display_name?: string;
  category?: string;
}

export type ObjectInfo = Record<string, NodeSchema>;

export interface SchemaIssue {
  level: "error" | "warning";
  node: string;
  classType: string;
  message: string;
}

export interface ValidateOptions {
  /** Skip enum membership checks for these input names (e.g. uploaded images not yet uploaded). */
  skipEnumFor?: Set<string>;
}

/** Enum options of an input spec, or null when the input is not an enum. */
export function enumOptions(spec: InputSpec | undefined): string[] | null {
  if (!spec) return null;
  const [type, opts] = spec;
  if (Array.isArray(type)) return type.map(String);
  if (type === "COMBO" && opts && Array.isArray(opts["options"])) return (opts["options"] as unknown[]).map(String);
  return null;
}

export function inputSpec(schema: NodeSchema, name: string): InputSpec | undefined {
  return schema.input.required?.[name] ?? schema.input.optional?.[name];
}

function typeName(spec: InputSpec): string {
  const [type] = spec;
  if (Array.isArray(type)) return "COMBO";
  return String(type);
}

function typesCompatible(outputType: string, inputType: string): boolean {
  if (outputType === "*" || inputType === "*") return true;
  if (inputType === outputType) return true;
  // Some nodes declare unions such as "IMAGE,MASK".
  return inputType.split(",").map((s) => s.trim()).includes(outputType);
}

export function validatePrompt(prompt: ApiPrompt, info: ObjectInfo, options: ValidateOptions = {}): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const push = (level: SchemaIssue["level"], node: string, classType: string, message: string): void => {
    issues.push({ level, node, classType, message });
  };

  for (const [id, node] of Object.entries(prompt)) {
    const schema = info[node.class_type];
    if (!schema) {
      push("error", id, node.class_type, "class_type is not registered on the server");
      continue;
    }
    for (const name of Object.keys(schema.input.required ?? {})) {
      if (!(name in node.inputs)) push("error", id, node.class_type, `missing required input '${name}'`);
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      const spec = inputSpec(schema, name);
      if (!spec) {
        push("warning", id, node.class_type, `input '${name}' is not in the schema (ignored by ComfyUI)`);
        continue;
      }
      const declared = typeName(spec);
      if (isLink(value)) {
        const source = prompt[value[0]];
        const sourceSchema = source ? info[source.class_type] : undefined;
        if (!source) {
          push("error", id, node.class_type, `input '${name}' links to missing node ${value[0]}`);
          continue;
        }
        if (!sourceSchema) continue; // reported on the source node itself
        const outType = sourceSchema.output[value[1]];
        if (outType === undefined) {
          push("error", id, node.class_type, `input '${name}' uses output ${value[1]} of ${source.class_type}, which has ${sourceSchema.output.length}`);
        } else if (declared !== "COMBO" && !typesCompatible(outType, declared)) {
          push("error", id, node.class_type, `input '${name}' expects ${declared} but ${source.class_type}[${value[1]}] is ${outType}`);
        }
        continue;
      }
      const opts = (spec[1] ?? {}) as Record<string, unknown>;
      const choices = enumOptions(spec);
      if (choices) {
        if (!options.skipEnumFor?.has(name) && !choices.includes(String(value))) {
          const preview = choices.slice(0, 6).join(", ") + (choices.length > 6 ? ", ..." : "");
          push("error", id, node.class_type, `input '${name}' = ${JSON.stringify(value)} not in [${preview || "<empty list>"}]`);
        }
        continue;
      }
      if (declared === "INT" || declared === "FLOAT") {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          push("error", id, node.class_type, `input '${name}' expects ${declared}, got ${JSON.stringify(value)}`);
          continue;
        }
        if (declared === "INT" && !Number.isInteger(value)) push("error", id, node.class_type, `input '${name}' expects an integer, got ${value}`);
        const min = typeof opts["min"] === "number" ? (opts["min"] as number) : undefined;
        const max = typeof opts["max"] === "number" ? (opts["max"] as number) : undefined;
        if (min !== undefined && value < min) push("error", id, node.class_type, `input '${name}' = ${value} below min ${min}`);
        if (max !== undefined && value > max) push("error", id, node.class_type, `input '${name}' = ${value} above max ${max}`);
      } else if (declared === "BOOLEAN" && typeof value !== "boolean") {
        push("error", id, node.class_type, `input '${name}' expects BOOLEAN, got ${JSON.stringify(value)}`);
      } else if (declared === "STRING" && typeof value !== "string") {
        push("error", id, node.class_type, `input '${name}' expects STRING, got ${JSON.stringify(value)}`);
      }
    }
  }
  return issues;
}

/** Options the server currently offers for one node input (model dropdowns, samplers, ...). */
export function optionsFor(info: ObjectInfo, classType: string, input: string): string[] {
  const schema = info[classType];
  return schema ? enumOptions(inputSpec(schema, input)) ?? [] : [];
}

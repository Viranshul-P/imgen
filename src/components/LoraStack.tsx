"use client";

import { Plus, X } from "lucide-react";
import { Button, Select, Slider } from "@/components/ui/primitives";
import type { LoraSpec } from "@/lib/workflowInjector";

export interface LoraStackProps {
  value: LoraSpec[];
  onChange: (next: LoraSpec[]) => void;
  available: string[];
  /** Flux LoRAs only apply to the model (LoraLoaderModelOnly); hide the CLIP slider. */
  modelOnly?: boolean;
}

/** Unlimited LoRA chain with independent weights (-1.0 to 2.0), injected as native LoraLoader nodes. */
export function LoraStack({ value, onChange, available, modelOnly = false }: LoraStackProps) {
  const update = (i: number, patch: Partial<LoraSpec>): void => onChange(value.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const unused = available.filter((n) => !value.some((l) => l.name === n));
  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 ? <p className="text-xs text-muted-foreground">No extra LoRAs. The character LoRA is added automatically when set.</p> : null}
      {value.map((lora, i) => (
        <div key={`${lora.name}-${i}`} className="grid grid-cols-[1fr_auto] gap-2 rounded-md border border-border p-2">
          <Select value={lora.name} onChange={(e) => update(i, { name: e.target.value })}>
            {[lora.name, ...unused].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <Button size="icon" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} title="Remove LoRA">
            <X />
          </Button>
          <div className="col-span-2 grid gap-1 sm:grid-cols-2 sm:gap-3">
            <Slider label="model strength" value={lora.strengthModel} min={-1} max={2} step={0.05} onChange={(v) => update(i, { strengthModel: v })} format={(v) => `M ${v.toFixed(2)}`} />
            {modelOnly ? null : (
              <Slider
                label="clip strength"
                value={lora.strengthClip ?? lora.strengthModel}
                min={-1}
                max={2}
                step={0.05}
                onChange={(v) => update(i, { strengthClip: v })}
                format={(v) => `C ${v.toFixed(2)}`}
              />
            )}
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        disabled={unused.length === 0}
        onClick={() => {
          const name = unused[0];
          if (name) onChange([...value, { name, strengthModel: 0.6, strengthClip: 0.6 }]);
        }}
      >
        <Plus /> Add LoRA
      </Button>
    </div>
  );
}

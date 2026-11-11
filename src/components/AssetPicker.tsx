"use client";

import { Upload } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/primitives";
import { cn, fileUrl } from "@/lib/utils";
import { api, uploadFile, useStudio } from "./StudioContext";

export interface PickedAsset {
  id: string;
  path: string;
}

interface AssetRow {
  id: string;
  path: string;
  kind: string;
  createdAt: string;
}

/** Pick a base frame from recent renders, or upload one. */
export function AssetPicker({ value, onChange, characterId, label = "Base frame" }: { value: PickedAsset | null; onChange: (a: PickedAsset | null) => void; characterId?: string; label?: string }) {
  const { notify, jobs } = useStudio();
  const [assets, setAssets] = React.useState<AssetRow[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const doneCount = jobs.filter((j) => j.status === "done").length;

  React.useEffect(() => {
    const q = new URLSearchParams({ kind: "raw", limit: "24", ...(characterId ? { characterId } : {}) });
    api<AssetRow[]>(`/api/assets?${q.toString()}`)
      .then(setAssets)
      .catch((e: unknown) => notify("error", String(e)));
  }, [characterId, doneCount, notify]);

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const saved = await uploadFile(file, "upload", characterId ? { characterId } : {});
      onChange(saved);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
          <Upload /> Upload
        </Button>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {value && !assets.some((a) => a.id === value.id) ? (
          // eslint-disable-next-line @next/next/no-img-element -- local data/ file
          <img src={fileUrl(value.path)} alt="selected" className="aspect-[4/5] w-full rounded object-cover ring-2 ring-primary" />
        ) : null}
        {assets.map((a) => (
          <button key={a.id} type="button" onClick={() => onChange(value?.id === a.id ? null : { id: a.id, path: a.path })} className="block">
            {/* eslint-disable-next-line @next/next/no-img-element -- local data/ file */}
            <img src={fileUrl(a.path)} alt="" className={cn("aspect-[4/5] w-full rounded object-cover", value?.id === a.id ? "ring-2 ring-primary" : "opacity-80 hover:opacity-100")} />
          </button>
        ))}
      </div>
      {assets.length === 0 && !value ? <p className="text-xs text-muted-foreground">No renders yet - generate a Stage 1 photo with Engine A/B or upload one.</p> : null}
    </div>
  );
}

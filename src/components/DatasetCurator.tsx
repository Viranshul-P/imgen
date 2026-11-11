"use client";

import { Check, Database, X } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Slider } from "@/components/ui/primitives";
import { cn, fileUrl } from "@/lib/utils";
import { api, postJson, useStudio } from "./StudioContext";

interface Frame {
  id: string;
  path: string;
  approved: boolean | null;
  caption: string;
}

export function DatasetCurator({ footer }: { footer?: React.ReactNode }) {
  const { character, notify, jobs } = useStudio();
  const [frames, setFrames] = React.useState<Frame[]>([]);
  const [count, setCount] = React.useState(35);
  const finished = jobs.filter((j) => j.status === "done" && j.template === "genesis_dataset").length;

  const [reloadTick, setReloadTick] = React.useState(0);
  const load = React.useCallback(() => setReloadTick((t) => t + 1), []);
  const characterKey = character?.id ?? "";

  React.useEffect(() => {
    if (!characterKey) return;
    let cancelled = false;
    api<{ frames: Frame[] }>(`/api/datasets?characterId=${encodeURIComponent(characterKey)}`)
      .then((res) => {
        if (!cancelled) setFrames(res.frames);
      })
      .catch((e: unknown) => notify("error", String(e)));
    return () => {
      cancelled = true;
    };
  }, [characterKey, finished, reloadTick, notify]);

  const review = async (frame: Frame, approved: boolean | null, caption?: string): Promise<void> => {
    setFrames((fs) => fs.map((f) => (f.id === frame.id ? { ...f, approved, caption: caption ?? f.caption } : f)));
    try {
      await postJson("/api/datasets", { action: "review", assetId: frame.id, approved, caption });
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
      load();
    }
  };

  const generate = async (): Promise<void> => {
    if (!character) return;
    try {
      const res = await postJson<{ queued: number }>("/api/datasets", { action: "generate", characterId: character.id, count });
      notify("ok", `Queued ${res.queued} dataset frames (IP-Adapter FaceID Plus v2)`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  if (!character) return null;
  const approved = frames.filter((f) => f.approved === true).length;
  const rejected = frames.filter((f) => f.approved === false).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="size-4" /> Dataset Curator
        </CardTitle>
        <CardDescription>Generate varied identity-locked frames from master_face.png, keep the best, train the Character LoRA locally.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Slider value={count} min={10} max={60} step={1} onChange={setCount} className="w-48" format={(v) => `${v} imgs`} />
          <Button onClick={() => void generate()} disabled={!character.masterFacePath}>
            Generate {count}-image training dataset
          </Button>
          {!character.masterFacePath ? <Badge variant="warning">select master_face.png first</Badge> : null}
          <Badge variant="success">{approved} approved</Badge>
          <Badge variant="destructive">{rejected} rejected</Badge>
          <Badge variant="outline">{frames.length - approved - rejected} undecided</Badge>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
          {frames.map((f) => (
            <div key={f.id} className={cn("flex flex-col gap-1 rounded-md border p-1", f.approved === true ? "border-emerald-600" : f.approved === false ? "border-red-700 opacity-60" : "border-border")}>
              {/* eslint-disable-next-line @next/next/no-img-element -- local data/ file */}
              <img src={fileUrl(f.path)} alt="" className="aspect-[4/5] w-full rounded object-cover" />
              <div className="flex gap-1">
                <Button size="sm" variant={f.approved === true ? "default" : "outline"} className="flex-1" onClick={() => void review(f, f.approved === true ? null : true)}>
                  <Check />
                </Button>
                <Button size="sm" variant={f.approved === false ? "destructive" : "outline"} className="flex-1" onClick={() => void review(f, f.approved === false ? null : false)}>
                  <X />
                </Button>
              </div>
              <Input
                className="h-7 text-xs"
                defaultValue={f.caption}
                placeholder="caption override"
                onBlur={(e) => {
                  if (e.target.value !== f.caption) void review(f, f.approved, e.target.value);
                }}
              />
            </div>
          ))}
        </div>
        {frames.length === 0 ? <p className="text-sm text-muted-foreground">No dataset frames yet.</p> : null}
        {footer}
      </CardContent>
    </Card>
  );
}

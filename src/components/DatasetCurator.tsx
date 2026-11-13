"use client";

import { Check, Database, Download, X } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Select, Slider } from "@/components/ui/primitives";
import { BUCKET_LABELS, DATASET_BUCKETS, MAX_TRAINING_IMAGES, isBucket } from "@/lib/buckets";
import { cn, fileUrl } from "@/lib/utils";
import { api, postJson, useStudio } from "./StudioContext";

interface ExportResult {
  images: number;
  repeats: number;
  steps_per_epoch: number;
  trigger: string;
  class_tokens: string;
  folder: string;
  zipUrl: string | null;
  warnings: string[];
  buckets?: Record<string, number>;
  sub_tokens?: Record<string, string>;
}

interface Frame {
  id: string;
  path: string;
  approved: boolean | null;
  caption: string;
  bucket: string | null;
}

export function DatasetCurator({ footer }: { footer?: React.ReactNode }) {
  const { character, notify, jobs } = useStudio();
  const [frames, setFrames] = React.useState<Frame[]>([]);
  const [count, setCount] = React.useState(35);
  const [repeats, setRepeats] = React.useState(10);
  const [exporting, setExporting] = React.useState(false);
  const [lastExport, setLastExport] = React.useState<ExportResult | null>(null);
  const [cloudExport, setCloudExport] = React.useState<ExportResult | null>(null);
  const [cloudBusy, setCloudBusy] = React.useState(false);
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

  const setBucket = async (frame: Frame, value: string): Promise<void> => {
    const bucket = isBucket(value) ? value : null;
    setFrames((fs) => fs.map((f) => (f.id === frame.id ? { ...f, bucket } : f)));
    try {
      await postJson("/api/datasets", { action: "review", assetId: frame.id, bucket });
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
      load();
    }
  };

  const cloudBundle = async (): Promise<void> => {
    if (!character) return;
    setCloudBusy(true);
    try {
      const res = await postJson<ExportResult>("/api/datasets", { action: "cloudBundle", characterId: character.id, repeats });
      setCloudExport(res);
      notify("ok", `Cloud training bundle ready (${res.images} images)`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setCloudBusy(false);
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

  const exportForTraining = async (): Promise<void> => {
    if (!character) return;
    setExporting(true);
    try {
      const res = await postJson<ExportResult>("/api/datasets", { action: "export", characterId: character.id, repeats });
      setLastExport(res);
      notify("ok", `Exported ${res.images} images for LoRA training (${res.class_tokens})`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  if (!character) return null;
  const approved = frames.filter((f) => f.approved === true).length;
  const rejected = frames.filter((f) => f.approved === false).length;
  const approvedFrames = frames.filter((f) => f.approved === true);
  const bucketCount = (b: string | null): number => approvedFrames.filter((f) => f.bucket === b).length;

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
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Approved per bucket:</span>
          {DATASET_BUCKETS.map((b) => (
            <Badge key={b} variant="outline">
              {BUCKET_LABELS[b].split(":")[0]} {bucketCount(b)}
            </Badge>
          ))}
          <Badge variant="outline">General {bucketCount(null)}</Badge>
          <Badge variant={approved > MAX_TRAINING_IMAGES ? "destructive" : "outline"}>
            {approved}/{MAX_TRAINING_IMAGES} images
          </Badge>
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
              <Select value={f.bucket ?? ""} onChange={(e) => void setBucket(f, e.target.value)} className="h-7 text-xs" title="Training bucket (gets its own sub-token)">
                <option value="">General (main trigger)</option>
                {DATASET_BUCKETS.map((b) => (
                  <option key={b} value={b}>
                    {BUCKET_LABELS[b]}
                  </option>
                ))}
              </Select>
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
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <span className="text-xs font-medium text-muted-foreground">Train the Character LoRA locally (OneTrainer / kohya_ss - see docs/TRAINING.md)</span>
          <div className="flex flex-wrap items-center gap-3">
            <Slider value={repeats} min={1} max={30} step={1} onChange={setRepeats} className="w-48" label="repeats per image" format={(v) => `${v}x repeat`} />
            <Button onClick={() => void exportForTraining()} disabled={exporting || approved === 0}>
              <Download /> {exporting ? "Exporting..." : `Export ${approved} approved frames for training`}
            </Button>
            {approved > 0 && approved < 15 ? <Badge variant="warning">25-40 approved frames recommended</Badge> : null}
          </div>
          {lastExport ? (
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>
                {lastExport.images} images x {lastExport.repeats} = {lastExport.steps_per_epoch} steps/epoch, captions start with &quot;{lastExport.trigger}, &lt;bucket sub-token&gt;&quot;. Folder: data/
                {lastExport.folder} (README.txt inside has the exact steps).
              </span>
              {lastExport.zipUrl ? (
                <a href={lastExport.zipUrl} download className="text-primary underline">
                  Download training bundle (.zip)
                </a>
              ) : null}
              {lastExport.warnings.map((w) => (
                <span key={w} className="text-amber-400">
                  {w}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <span className="text-xs font-medium text-muted-foreground">
            Train on a cloud GPU: Flux (ai-toolkit, 24/48/80 GB) and SDXL (kohya_ss / OneTrainer) at full precision, then copy the .safetensors back into models/loras
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => void cloudBundle()} disabled={cloudBusy || approved === 0 || approved > MAX_TRAINING_IMAGES}>
              <Download /> {cloudBusy ? "Packing..." : "Generate Cloud Training Bundle (.zip)"}
            </Button>
            {approved > MAX_TRAINING_IMAGES ? <Badge variant="destructive">trim to {MAX_TRAINING_IMAGES} approved images</Badge> : null}
          </div>
          {cloudExport ? (
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>
                {cloudExport.images} images, sub-tokens: {Object.values(cloudExport.sub_tokens ?? {}).join(", ") || "none (single trigger)"}. README_CLOUD.txt inside has the steps.
              </span>
              {cloudExport.zipUrl ? (
                <a href={cloudExport.zipUrl} download className="text-primary underline">
                  Download cloud training bundle (.zip)
                </a>
              ) : null}
              {cloudExport.warnings.map((w) => (
                <span key={w} className="text-amber-400">
                  {w}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {footer}
      </CardContent>
    </Card>
  );
}

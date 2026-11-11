"use client";

import { Images } from "lucide-react";
import * as React from "react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Field, Select } from "@/components/ui/primitives";
import { QUALITY_FLAGS, type QualityFlag, parseJson } from "@/lib/types";
import { cn, fileUrl } from "@/lib/utils";
import { api, postJson, useStudio } from "./StudioContext";

export interface VaultAsset {
  id: string;
  path: string;
  kind: string;
  stage: number | null;
  campaignId: string | null;
  flags: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  derived: { id: string; path: string; kind: string }[];
  job: { label: string; template: string } | null;
}

const FLAG_LABEL: Record<QualityFlag, string> = {
  hands_ok: "Hands look right",
  face_consistent: "Face matches character",
  no_ai_sheen: "No glossy AI sheen",
  background_lived_in: "Background feels lived-in",
  ready_to_post: "Ready to post",
};

/** Drag-to-compare: raw ComfyUI PNG on the left, Phone Look Finisher JPEG on the right. */
export function BeforeAfterSlider({ before, after }: { before: string; after: string }) {
  const [pos, setPos] = React.useState(50);
  return (
    <div className="relative w-full select-none overflow-hidden rounded-lg border border-border">
      {/* eslint-disable-next-line @next/next/no-img-element -- local data/ file */}
      <img src={after} alt="finished" className="block h-auto w-full" draggable={false} />
      <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local data/ file */}
        <img src={before} alt="raw" className="block h-auto w-full" draggable={false} />
      </div>
      <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${pos}%` }} />
      <span className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs">Raw</span>
      <span className="absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs">Phone Look</span>
      <input
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label="before/after position"
        className="absolute inset-x-0 bottom-2 mx-auto w-2/3 accent-primary"
      />
    </div>
  );
}

export function ContentVault({ toolbar }: { toolbar?: (selected: VaultAsset[], reload: () => void) => React.ReactNode }) {
  const { characterId, campaigns, notify, jobs } = useStudio();
  const [assets, setAssets] = React.useState<VaultAsset[]>([]);
  const [campaignId, setCampaignId] = React.useState("");
  const [stage, setStage] = React.useState("");
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const finished = jobs.filter((j) => j.status === "done").length;

  const [reloadTick, setReloadTick] = React.useState(0);
  const load = React.useCallback(() => setReloadTick((t) => t + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ kind: "raw", limit: "300" });
    if (characterId) q.set("characterId", characterId);
    if (campaignId) q.set("campaignId", campaignId);
    if (stage) q.set("stage", stage);
    api<VaultAsset[]>(`/api/assets?${q.toString()}`)
      .then((list) => {
        if (!cancelled) setAssets(list);
      })
      .catch((e: unknown) => notify("error", String(e)));
    return () => {
      cancelled = true;
    };
  }, [characterId, campaignId, stage, finished, reloadTick, notify]);

  const active = assets.find((a) => a.id === activeId) ?? null;
  const activeFlags = active ? parseJson<Partial<Record<QualityFlag, boolean>>>(active.flags, {}) : {};
  const finishedVersion = active?.derived.find((d) => d.kind === "finished");
  const stages = [...new Set(assets.map((a) => a.stage).filter((s): s is number => s !== null))].sort((a, b) => a - b);

  const toggleFlag = async (flag: QualityFlag, value: boolean): Promise<void> => {
    if (!active) return;
    const flags = { ...activeFlags, [flag]: value };
    setAssets((list) => list.map((a) => (a.id === active.id ? { ...a, flags: JSON.stringify(flags) } : a)));
    try {
      await postJson("/api/assets", { id: active.id, flags }, "PATCH");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const toggleSelected = (id: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Images className="size-4" /> Content Vault
          </CardTitle>
          <CardDescription>Every render, filterable by campaign and stage. Click to inspect, tick to select for export.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Campaign" className="w-56">
              <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">all</option>
                {campaigns
                  .filter((c) => !characterId || c.characterId === characterId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Stage" className="w-32">
              <Select value={stage} onChange={(e) => setStage(e.target.value)}>
                <option value="">all</option>
                {stages.map((s) => (
                  <option key={s} value={s}>
                    stage {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Badge variant="outline">{assets.length} images</Badge>
            <Badge variant="secondary">{selected.size} selected</Badge>
            {toolbar?.(assets.filter((a) => selected.has(a.id)), load)}
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-7">
            {assets.map((a) => (
              <div key={a.id} className="relative">
                <button type="button" className="block w-full" onClick={() => setActiveId(a.id)}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local data/ file */}
                  <img src={fileUrl(a.path)} alt="" className={cn("aspect-[4/5] w-full rounded object-cover", activeId === a.id && "ring-2 ring-primary")} />
                </button>
                <input type="checkbox" className="absolute left-1 top-1 size-4 accent-primary" checked={selected.has(a.id)} onChange={() => toggleSelected(a.id)} aria-label="select for export" />
                {a.derived.some((d) => d.kind === "finished") ? <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px]">phone</span> : null}
                {a.stage !== null ? <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[10px]">S{a.stage}</span> : null}
              </div>
            ))}
          </div>
          {assets.length === 0 ? <p className="text-sm text-muted-foreground">No renders yet.</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{active ? (active.job?.label ?? "Render") : "Select an image"}</CardTitle>
          {active ? (
            <CardDescription>
              {active.width}x{active.height} - {new Date(active.createdAt).toLocaleString()}
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {active ? (
            <>
              {finishedVersion ? (
                <BeforeAfterSlider before={fileUrl(active.path)} after={fileUrl(finishedVersion.path)} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- local data/ file
                <img src={fileUrl(active.path)} alt="" className="w-full rounded-lg border border-border" />
              )}
              {!finishedVersion ? <p className="text-xs text-muted-foreground">No Phone Look version yet - export it to compare raw vs finished.</p> : null}
              <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <span className="text-xs font-medium text-muted-foreground">Quality checklist</span>
                {QUALITY_FLAGS.map((f) => (
                  <Checkbox key={f} checked={Boolean(activeFlags[f])} onChange={(v) => void toggleFlag(f, v)} label={FLAG_LABEL[f]} />
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Pick a render from the grid.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

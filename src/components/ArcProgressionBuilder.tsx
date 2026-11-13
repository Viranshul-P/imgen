"use client";

import { ListOrdered, Plus, Upload, X } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Field, Input, Select, Slider, Textarea } from "@/components/ui/primitives";
import { SCENE_KITS } from "@/lib/sceneKits";
import { DEFAULT_JOB_OPTIONS } from "@/lib/types";
import { fileUrl } from "@/lib/utils";
import type { LoraSpec } from "@/lib/workflowInjector";
import { AssetPicker, type PickedAsset } from "./AssetPicker";
import { JobQueue } from "./JobQueue";
import { LoraStack } from "./LoraStack";
import { postJson, uploadFile, useStudio } from "./StudioContext";
import { WardrobeMaskCanvas } from "./WardrobeMaskCanvas";

interface StageDraft {
  stage: number;
  prompt: string;
  denoise: number;
  poseImagePath?: string;
}

const MIN_STAGES = 5;
const MAX_STAGES = 10;

function initialStages(mode: "inpaint" | "pose"): StageDraft[] {
  // Inpaint mode: Stage 1 is the base frame itself, so generated stages start at 2.
  const first = mode === "inpaint" ? 2 : 1;
  return Array.from({ length: MIN_STAGES - (mode === "inpaint" ? 1 : 0) }, (_, i) => ({ stage: first + i, prompt: "", denoise: 0.88 }));
}

export function ArcProgressionBuilder() {
  const { catalog, characterId, character, campaigns, reloadCampaigns, notify } = useStudio();
  const [campaignId, setCampaignId] = React.useState("");
  const [newCampaign, setNewCampaign] = React.useState("");
  const [name, setName] = React.useState("Outfit progression");
  const [mode, setMode] = React.useState<"inpaint" | "pose">("inpaint");
  const [base, setBase] = React.useState<PickedAsset | null>(null);
  const [mask, setMask] = React.useState<{ id: string; path: string } | null>(null);
  const [stages, setStages] = React.useState<StageDraft[]>(initialStages("inpaint"));
  const [sceneKit, setSceneKit] = React.useState("mirror_selfie_bedroom");
  const [checkpoint, setCheckpoint] = React.useState("");
  const [loras, setLoras] = React.useState<LoraSpec[]>([]);
  const [seed, setSeed] = React.useState("");
  const [poseStrength, setPoseStrength] = React.useState(0.7);
  /** ReActor master-face swap (pose mode only: inpaint stages keep the base frame's face pixel-locked). */
  const [reactorMasterFace, setReactorMasterFace] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const characterCampaigns = campaigns.filter((c) => c.characterId === characterId);
  const sdxlLoras = (catalog?.loras ?? []).filter((l) => !/flux/i.test(l));
  const lastStage = stages[stages.length - 1]?.stage ?? 1;

  const switchMode = (m: "inpaint" | "pose"): void => {
    setMode(m);
    setStages(initialStages(m));
  };

  const createCampaign = async (): Promise<void> => {
    if (!characterId || !newCampaign.trim()) return;
    try {
      const c = await postJson<{ id: string }>("/api/campaigns", { kind: "campaign", name: newCampaign.trim(), characterId });
      await reloadCampaigns();
      setCampaignId(c.id);
      setNewCampaign("");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const updateStage = (i: number, patch: Partial<StageDraft>): void => setStages((s) => s.map((st, j) => (j === i ? { ...st, ...patch } : st)));

  const generate = async (): Promise<void> => {
    if (!campaignId) {
      notify("error", "Pick or create a campaign first");
      return;
    }
    setSubmitting(true);
    try {
      const res = await postJson<{ queued: number }>("/api/campaigns", {
        kind: "arc",
        campaignId,
        name,
        mode,
        baseAssetId: mode === "inpaint" ? base?.id : undefined,
        maskPath: mode === "inpaint" ? mask?.path : undefined,
        stages: stages.map((s) => ({ stage: s.stage, prompt: s.prompt, denoise: mode === "inpaint" ? s.denoise : undefined, poseImagePath: s.poseImagePath })),
        sceneKit,
        checkpoint: checkpoint || undefined,
        loras,
        seed: seed.trim() ? Number(seed) : undefined,
        poseStrength,
        options: { ...DEFAULT_JOB_OPTIONS, enableUpscale: false, enableReactorMasterFace: mode === "pose" && Boolean(character?.masterFacePath) && reactorMasterFace },
      });
      notify("ok", `Queued ${res.queued} stages - VRAM flushes are handled between engines`);
      await reloadCampaigns();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!character) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">Create a character in the Character &amp; Dataset tab first.</CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ListOrdered className="size-4" /> Arc Progression Builder
          </CardTitle>
          <CardDescription>5-10 stage sets in the exact same room and lighting.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Campaign">
              <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">select...</option>
                {characterCampaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.arcs.length} arcs)
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="New campaign">
              <div className="flex gap-2">
                <Input value={newCampaign} onChange={(e) => setNewCampaign(e.target.value)} placeholder="name" />
                <Button size="icon" variant="outline" onClick={() => void createCampaign()} title="Create campaign">
                  <Plus />
                </Button>
              </div>
            </Field>
            <Field label="Arc name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Mode">
              <Select value={mode} onChange={(e) => switchMode(e.target.value as "inpaint" | "pose")}>
                <option value="inpaint">Mode 1 - Inpaint progression on base frame (Engine C)</option>
                <option value="pose">Mode 2 - Pose/Depth-guided progression (Engine B)</option>
              </Select>
            </Field>
            <Field label="Scene kit / environment preset">
              <Select value={sceneKit} onChange={(e) => setSceneKit(e.target.value)}>
                {SCENE_KITS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="SDXL checkpoint">
              <Select value={checkpoint} onChange={(e) => setCheckpoint(e.target.value)}>
                <option value="">{character.sdxlCheckpoint ?? "default (RealVisXL V5)"}</option>
                {(catalog?.checkpoints ?? []).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
          </div>

          {mode === "inpaint" ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <AssetPicker
                value={base}
                onChange={(a) => {
                  setBase(a);
                  setMask(null);
                }}
                characterId={characterId}
                label="Stage 1 base photo (mirror selfie, bed selfie, ...)"
              />
              {base ? <WardrobeMaskCanvas imageUrl={fileUrl(base.path)} imagePath={base.path} onExported={setMask} characterId={characterId} /> : null}
              {mask ? <Badge variant="success">outfit mask ready</Badge> : <Badge variant="warning">paint the outfit region and click &ldquo;Use this mask&rdquo;</Badge>}
            </div>
          ) : (
            <Field label={`Pose strength (${poseStrength.toFixed(2)})`}>
              <Slider value={poseStrength} min={0.3} max={1.1} step={0.05} onChange={setPoseStrength} />
            </Field>
          )}

          <div className="flex flex-col gap-2">
            {stages.map((s, i) => (
              <div key={s.stage} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[70px_1fr_auto]">
                <Badge variant="outline" className="h-fit justify-center">
                  Stage {s.stage}
                </Badge>
                <div className="flex flex-col gap-2">
                  <Textarea className="min-h-16" value={s.prompt} onChange={(e) => updateStage(i, { prompt: e.target.value })} placeholder="what changes in this stage (outfit / styling)" />
                  {mode === "inpaint" ? (
                    <Slider value={s.denoise} min={0.55} max={0.92} step={0.01} onChange={(v) => updateStage(i, { denoise: v })} format={(v) => `dn ${v.toFixed(2)}`} />
                  ) : (
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                      <Upload className="size-4" />
                      {s.poseImagePath ? "pose reference set" : "add pose reference"}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void uploadFile(f, "upload", { characterId }).then((saved) => updateStage(i, { poseImagePath: saved.path }));
                        }}
                      />
                      {s.poseImagePath ? (
                        // eslint-disable-next-line @next/next/no-img-element -- local upload preview
                        <img src={fileUrl(s.poseImagePath)} alt="" className="size-10 rounded object-cover" />
                      ) : null}
                    </label>
                  )}
                </div>
                <Button size="icon" variant="ghost" disabled={stages.length <= 1} onClick={() => setStages((st) => st.filter((_, j) => j !== i))} title="Remove stage">
                  <X />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={lastStage >= MAX_STAGES}
              onClick={() => setStages((st) => [...st, { stage: lastStage + 1, prompt: "", denoise: 0.88 }])}
            >
              <Plus /> Add stage
            </Button>
          </div>

          <Checkbox
            checked={mode === "pose" && Boolean(character.masterFacePath) && reactorMasterFace}
            onChange={setReactorMasterFace}
            label="ReActor: swap in this character's master face on every stage"
            disabled={mode !== "pose" || !character.masterFacePath}
            hint={
              mode !== "pose"
                ? "Inpaint mode keeps the base frame's face pixel-locked, so no swap is needed"
                : character.masterFacePath
                  ? "Source is always the character's own generated master_face.png; the swap is blended 60% over the original face, then FaceDetailer at 0.28"
                  : "Pick a master face in the Character tab first"
            }
          />

          <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
            <Field label="Stage LoRAs (applied to every stage, after the Character LoRA)">
              <LoraStack value={loras} onChange={setLoras} available={sdxlLoras} />
            </Field>
            <Field label="Seed (same for all stages)">
              <Input value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))} placeholder="random" />
            </Field>
          </div>

          <Button size="lg" onClick={() => void generate()} disabled={submitting}>
            {submitting ? "Queueing..." : "Generate Full Progression Arc"}
          </Button>
        </CardContent>
      </Card>
      <JobQueue title="Arc queue" />
    </div>
  );
}

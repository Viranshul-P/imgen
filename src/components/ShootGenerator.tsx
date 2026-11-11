"use client";

import { AlertTriangle, Camera, Upload } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Field, Input, Select, Slider, Textarea } from "@/components/ui/primitives";
import { detectSheenWords } from "@/lib/promptBuilder";
import { SCENE_KITS, getSceneKit } from "@/lib/sceneKits";
import { DEFAULT_JOB_OPTIONS, FINISHER_PRESETS, type JobOptions } from "@/lib/types";
import { fileUrl } from "@/lib/utils";
import type { LoraSpec } from "@/lib/workflowInjector";
import { AssetPicker, type PickedAsset } from "./AssetPicker";
import { JobQueue } from "./JobQueue";
import { LoraStack } from "./LoraStack";
import { postJson, uploadFile, useStudio } from "./StudioContext";
import { WardrobeMaskCanvas } from "./WardrobeMaskCanvas";

type Engine = "A" | "B" | "C";

const DEFAULT_KIT = "mirror_selfie_bedroom";

/** Spec 3.1 default realism LoRA weights, pre-filled when the files are installed. */
const REALISM_DEFAULTS: Record<"A" | "B", LoraSpec[]> = {
  A: [
    { name: "flux_amateur_photography.safetensors", strengthModel: 0.65 },
    { name: "flux_realism_lora.safetensors", strengthModel: 0.55 },
  ],
  B: [],
};

function isFluxLora(name: string): boolean {
  return /flux/i.test(name);
}

export function ShootGenerator() {
  const { catalog, character, characterId, campaigns, notify } = useStudio();
  const initialKit = getSceneKit(DEFAULT_KIT);
  const [engine, setEngine] = React.useState<Engine>("A");
  const [sceneKit, setSceneKit] = React.useState<string>(DEFAULT_KIT);
  const [prompt, setPrompt] = React.useState("");
  const [negative, setNegative] = React.useState("");
  const [checkpoint, setCheckpoint] = React.useState("");
  const [unet, setUnet] = React.useState("");
  /** null = show the engine's realism defaults; set once the user edits the stack. */
  const [lorasOverride, setLorasOverride] = React.useState<LoraSpec[] | null>(null);
  const [count, setCount] = React.useState(1);
  const [seed, setSeed] = React.useState("");
  const [aspect, setAspect] = React.useState<"4:5" | "9:16">(initialKit?.aspect ?? "4:5");
  const [guidance, setGuidance] = React.useState(initialKit?.guidance ?? 2.6);
  const [cfg, setCfg] = React.useState(5);
  const [steps, setSteps] = React.useState("");
  const [options, setOptions] = React.useState<JobOptions>({ ...DEFAULT_JOB_OPTIONS, finisherPreset: initialKit?.finisherPreset ?? DEFAULT_JOB_OPTIONS.finisherPreset });
  const [control, setControl] = React.useState<{ path: string; mode: "pose" | "depth"; strength: number } | null>(null);
  const [useFaceRef, setUseFaceRef] = React.useState(false);
  const [base, setBase] = React.useState<PickedAsset | null>(null);
  const [mask, setMask] = React.useState<{ id: string; path: string } | null>(null);
  const [denoise, setDenoise] = React.useState(0.75);
  const [campaignId, setCampaignId] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const controlInput = React.useRef<HTMLInputElement>(null);

  const sheen = detectSheenWords(prompt);
  const allLoras = catalog?.loras ?? [];
  const engineLoras = allLoras.filter((n) => (engine === "A" ? isFluxLora(n) : !isFluxLora(n)));
  const loras = lorasOverride ?? REALISM_DEFAULTS[engine === "A" ? "A" : "B"].filter((l) => allLoras.includes(l.name));

  const changeEngine = (next: Engine): void => {
    setEngine(next);
    setLorasOverride(null); // fall back to the new engine's realism LoRA defaults
  };

  const changeSceneKit = (id: string): void => {
    setSceneKit(id);
    const k = getSceneKit(id);
    if (k) {
      setAspect(k.aspect);
      setGuidance(k.guidance);
      setOptions((o) => ({ ...o, finisherPreset: k.finisherPreset }));
    }
  };

  const characterCampaigns = campaigns.filter((c) => c.characterId === characterId);

  const submit = async (): Promise<void> => {
    if (engine === "C" && (!base || !mask)) {
      notify("error", "Engine C needs a base frame and an exported mask");
      return;
    }
    setSubmitting(true);
    try {
      const res = await postJson<{ queued: number }>("/api/jobs", {
        kind: "shoot",
        engine,
        characterId: characterId || null,
        campaignId: campaignId || null,
        sceneKit: sceneKit === "custom" ? undefined : sceneKit,
        prompt,
        negativePrompt: negative || undefined,
        checkpoint: engine !== "A" && checkpoint ? checkpoint : undefined,
        unet: engine === "A" && unet ? unet : undefined,
        loras,
        candidateCount: count,
        seed: seed.trim() ? Number(seed) : undefined,
        aspect,
        steps: steps.trim() ? Number(steps) : undefined,
        cfg: engine !== "A" ? cfg : undefined,
        guidance: engine === "A" ? guidance : undefined,
        options: { ...options, enableCrossEngineFaceLock: engine === "A" && options.enableCrossEngineFaceLock },
        control: engine === "B" && control ? { imagePath: control.path, mode: control.mode, strength: control.strength } : undefined,
        faceReferencePath: engine === "B" && useFaceRef && character?.masterFacePath ? character.masterFacePath : undefined,
        inpaint: engine === "C" && base && mask ? { baseImagePath: base.path, maskPath: mask.path, denoise } : undefined,
      });
      notify("ok", `Queued ${res.queued} job(s)`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const setOpt = <K extends keyof JobOptions>(key: K, value: JobOptions[K]): void => setOptions((o) => ({ ...o, [key]: value }));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Camera className="size-4" /> Shoot Generator
          </CardTitle>
          <CardDescription>Single shots or overnight batches. Every candidate is its own batch_size=1 job.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Engine">
              <Select value={engine} onChange={(e) => changeEngine(e.target.value as Engine)}>
                <option value="A">A - Flux GGUF (candid, ~2 min)</option>
                <option value="B">B - SDXL (fast, pose control)</option>
                <option value="C">C - SDXL inpaint (wardrobe)</option>
              </Select>
            </Field>
            {engine === "A" ? (
              <Field label="Flux UNet">
                <Select value={unet} onChange={(e) => setUnet(e.target.value)}>
                  <option value="">default (flux1-dev-Q4_K_S)</option>
                  {(catalog?.unets ?? []).map((u) => (
                    <option key={u}>{u}</option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="SDXL checkpoint">
                <Select value={checkpoint} onChange={(e) => setCheckpoint(e.target.value)}>
                  <option value="">{character?.sdxlCheckpoint ? `character default (${character.sdxlCheckpoint})` : "default (RealVisXL V5)"}</option>
                  {(catalog?.checkpoints ?? []).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Campaign">
              <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">none</option>
                {characterCampaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Field label="Amateur Scene Kit">
              <Select value={sceneKit} onChange={(e) => changeSceneKit(e.target.value)}>
                {SCENE_KITS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label} ({k.id})
                  </option>
                ))}
                <option value="custom">custom (prompt only)</option>
              </Select>
            </Field>
            <Field label="Aspect">
              <Select value={aspect} onChange={(e) => setAspect(e.target.value as "4:5" | "9:16")}>
                <option value="4:5">4:5 feed</option>
                <option value="9:16">9:16 story</option>
              </Select>
            </Field>
          </div>

          <Field label={character ? `Prompt (prefixed with ${character.triggerToken} + locked descriptors)` : "Prompt"}>
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="what she is wearing / doing, in plain words" />
          </Field>
          {sheen.length ? (
            <div className="flex items-center gap-2 text-xs text-amber-400">
              <AlertTriangle className="size-4" />
              Studio AI sheen words push away from the phone look: {sheen.map((w) => <Badge key={w} variant="warning">{w}</Badge>)}
            </div>
          ) : null}
          {engine !== "A" ? (
            <Field label="Extra negative">
              <Input value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="added to the built-in anti-studio negative" />
            </Field>
          ) : null}

          {engine === "B" ? (
            <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">OpenPose / Depth reference</span>
                <div
                  className="flex min-h-28 cursor-pointer items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground"
                  onClick={() => controlInput.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files[0];
                    if (f) void uploadFile(f, "upload").then((s) => setControl({ path: s.path, mode: control?.mode ?? "pose", strength: control?.strength ?? 0.7 }));
                  }}
                >
                  {control ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local upload preview
                    <img src={fileUrl(control.path)} alt="reference" className="max-h-40 rounded" />
                  ) : (
                    <span className="flex items-center gap-2">
                      <Upload className="size-4" /> drop or click to add a pose reference
                    </span>
                  )}
                </div>
                <input
                  ref={controlInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadFile(f, "upload").then((s) => setControl({ path: s.path, mode: control?.mode ?? "pose", strength: control?.strength ?? 0.7 }));
                  }}
                />
              </div>
              <div className="flex flex-col gap-3">
                <Field label="Control type">
                  <Select value={control?.mode ?? "pose"} disabled={!control} onChange={(e) => control && setControl({ ...control, mode: e.target.value as "pose" | "depth" })}>
                    <option value="pose">OpenPose (DWPose skeleton)</option>
                    <option value="depth">Depth (Depth Anything V2)</option>
                  </Select>
                </Field>
                <Field label="Control strength">
                  <Slider value={control?.strength ?? 0.7} min={0.2} max={1.2} step={0.05} onChange={(v) => control && setControl({ ...control, strength: v })} />
                </Field>
                {control ? (
                  <Button size="sm" variant="ghost" onClick={() => setControl(null)}>
                    Remove reference
                  </Button>
                ) : null}
                <Checkbox
                  checked={useFaceRef}
                  onChange={setUseFaceRef}
                  disabled={!character?.masterFacePath}
                  label="IP-Adapter FaceID from master_face.png"
                  hint="Identity bootstrap before the Character LoRA is trained"
                />
              </div>
            </div>
          ) : null}

          {engine === "C" ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <AssetPicker
                value={base}
                onChange={(a) => {
                  setBase(a);
                  setMask(null);
                }}
                characterId={characterId || undefined}
                label="Stage base frame"
              />
              {base ? <WardrobeMaskCanvas imageUrl={fileUrl(base.path)} onExported={setMask} characterId={characterId || undefined} /> : null}
              <Field label={`Inpaint denoise (${denoise.toFixed(2)})`}>
                <Slider value={denoise} min={0.55} max={0.92} step={0.01} onChange={setDenoise} />
              </Field>
              {mask ? <Badge variant="success">mask ready</Badge> : <Badge variant="warning">paint and export a mask</Badge>}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-4">
            <Field label={`Candidates (${count})`}>
              <Slider value={count} min={1} max={20} step={1} onChange={setCount} />
            </Field>
            {engine === "A" ? (
              <Field label={`Flux guidance (${guidance.toFixed(1)})`}>
                <Slider value={guidance} min={1.8} max={4} step={0.1} onChange={setGuidance} />
              </Field>
            ) : (
              <Field label={`CFG (${cfg.toFixed(1)})`}>
                <Slider value={cfg} min={4.5} max={5.5} step={0.1} onChange={setCfg} />
              </Field>
            )}
            <Field label="Steps">
              <Input value={steps} onChange={(e) => setSteps(e.target.value.replace(/[^0-9]/g, ""))} placeholder={engine === "A" ? "24" : "28"} />
            </Field>
            <Field label="Seed">
              <Input value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))} placeholder="random" />
            </Field>
          </div>

          <Field label={`LoRA stack (${engine === "A" ? "Flux, model-only" : "SDXL"})`}>
            <LoraStack value={loras} onChange={setLorasOverride} available={engineLoras} modelOnly={engine === "A"} />
          </Field>

          <div className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
            <Checkbox checked={options.enableFaceDetailer} onChange={(v) => setOpt("enableFaceDetailer", v)} label="FaceDetailer (eyes/lips, keeps pores)" />
            <Checkbox checked={options.enableHandDetailer} onChange={(v) => setOpt("enableHandDetailer", v)} label="Hand detailer" disabled={engine !== "B"} />
            <Checkbox
              checked={options.enableCrossEngineFaceLock}
              onChange={(v) => setOpt("enableCrossEngineFaceLock", v)}
              label="Cross-Engine SDXL Face Lock"
              disabled={engine !== "A" || !character?.sdxlLora}
              hint="After the Flux render, flush VRAM and re-detail the face with the SDXL Character LoRA (denoise 0.35)"
            />
            <Checkbox checked={options.enableUpscale} onChange={(v) => setOpt("enableUpscale", v)} label="Upscale then downscale to 1080 wide" disabled={engine === "C"} />
            <Checkbox checked={options.enablePhoneFinisher} onChange={(v) => setOpt("enablePhoneFinisher", v)} label="Phone Look Finisher" />
            <Select value={options.finisherPreset} onChange={(e) => setOpt("finisherPreset", e.target.value as JobOptions["finisherPreset"])} disabled={!options.enablePhoneFinisher}>
              {FINISHER_PRESETS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
          </div>

          <Button size="lg" onClick={() => void submit()} disabled={submitting}>
            {submitting ? "Queueing..." : `Queue ${count} ${count === 1 ? "shot" : "shots"} on Engine ${engine}`}
          </Button>
        </CardContent>
      </Card>
      <JobQueue />
    </div>
  );
}

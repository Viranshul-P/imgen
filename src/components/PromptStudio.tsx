"use client";

import { RotateCcw, Send, Sparkles, Square, Terminal } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Field, Input, Progress, Select, Slider, Textarea } from "@/components/ui/primitives";
import { detectSheenWords } from "@/lib/promptBuilder";
import { DEFAULT_JOB_OPTIONS, FINISHER_PRESETS, type FinisherPreset } from "@/lib/types";
import { cn, fileUrl } from "@/lib/utils";
import type { LoraSpec } from "@/lib/workflowInjector";
import { api, postJson, useStudio } from "./StudioContext";

type Engine = "A" | "B";

/** Optional add-on weights (model files, not prompt text) - same defaults as the Shoot tab. */
const FLUX_REALISM_LORAS: LoraSpec[] = [
  { name: "flux_amateur_photography.safetensors", strengthModel: 0.65 },
  { name: "flux_realism_lora.safetensors", strengthModel: 0.55 },
];

interface PromptJob {
  id: string;
  status: string;
  label: string;
  progress: number;
  progressText: string;
  error: string | null;
  durationMs: number | null;
  params: string;
  createdAt: string;
  assets: { id: string; path: string; kind: string }[];
}

interface SentValues {
  POSITIVE_PROMPT?: string;
  NEGATIVE_PROMPT?: string;
}

function sentPrompt(job: PromptJob): SentValues {
  try {
    return (JSON.parse(job.params) as { values?: SentValues }).values ?? {};
  } catch {
    return {};
  }
}

/**
 * Prompt tab: a plain prompt box whose text goes to the model exactly as typed. Nothing is added
 * to the prompt (no character description, scene kit or default negatives); the only extras are
 * the optional switches shown on screen.
 */
export function PromptStudio() {
  const { catalog, jobs: liveJobs, notify } = useStudio();
  const [engine, setEngine] = React.useState<Engine>("A");
  const [prompt, setPrompt] = React.useState("");
  const [negative, setNegative] = React.useState("");
  const [aspect, setAspect] = React.useState<"4:5" | "9:16">("4:5");
  const [count, setCount] = React.useState(1);
  const [seed, setSeed] = React.useState("");
  const [guidance, setGuidance] = React.useState(2.6);
  const [cfg, setCfg] = React.useState(5);
  const [checkpoint, setCheckpoint] = React.useState("");
  const [realismLoras, setRealismLoras] = React.useState(true);
  const [faceFix, setFaceFix] = React.useState(true);
  const [hires, setHires] = React.useState(false);
  const [detailDaemon, setDetailDaemon] = React.useState(true);
  const [phoneLook, setPhoneLook] = React.useState(false);
  const [phonePreset, setPhonePreset] = React.useState<FinisherPreset>("iphone_indoor_warm");
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [history, setHistory] = React.useState<PromptJob[]>([]);
  const [viewing, setViewing] = React.useState<string | null>(null);

  const installed = catalog?.loras ?? [];
  const loras = engine === "A" && realismLoras ? FLUX_REALISM_LORAS.filter((l) => installed.includes(l.name)) : [];
  const sdxlCheckpoints = (catalog?.checkpoints ?? []).filter((c) => /xl/i.test(c));
  const sheen = detectSheenWords(prompt);

  // History of Prompt-tab jobs; reloads whenever one of them changes state in the live stream.
  const liveKey = liveJobs
    .filter((j) => j.label.startsWith("Prompt"))
    .map((j) => `${j.id}:${j.status}`)
    .join(",");
  React.useEffect(() => {
    let cancelled = false;
    api<PromptJob[]>("/api/jobs?labelPrefix=Prompt&limit=24")
      .then((list) => {
        if (!cancelled) setHistory(list);
      })
      .catch((e: unknown) => notify("error", String(e)));
    return () => {
      cancelled = true;
    };
  }, [liveKey, notify]);

  const live = new Map(liveJobs.map((j) => [j.id, j]));
  const merged = history.map((h) => {
    const l = live.get(h.id);
    return l ? { ...h, status: l.status, progress: l.progress, progressText: l.progressText, error: l.error, assets: l.assets.length ? l.assets : h.assets } : h;
  });

  const submit = async (): Promise<void> => {
    if (!prompt.trim()) {
      notify("error", "Type a prompt first");
      return;
    }
    setSubmitting(true);
    try {
      const res = await postJson<{ queued: number }>("/api/jobs", {
        kind: "shoot",
        rawPrompt: true,
        engine,
        characterId: null,
        prompt,
        negativePrompt: engine === "B" && negative.trim() ? negative : undefined,
        checkpoint: engine === "B" && checkpoint ? checkpoint : undefined,
        loras,
        candidateCount: count,
        seed: seed.trim() ? Number(seed) : undefined,
        aspect,
        guidance: engine === "A" ? guidance : undefined,
        cfg: engine === "B" ? cfg : undefined,
        options: {
          ...DEFAULT_JOB_OPTIONS,
          enableFaceDetailer: faceFix,
          enableHiresFix: hires,
          enableDetailDaemon: detailDaemon,
          enablePhoneFinisher: phoneLook,
          finisherPreset: phonePreset,
        },
      });
      notify("ok", `Sent to ${engine === "A" ? "Flux" : "SDXL"}: ${res.queued} image(s) queued`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (id: string): Promise<void> => {
    try {
      await api(`/api/jobs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const reuse = (job: PromptJob): void => {
    const sent = sentPrompt(job);
    setPrompt(sent.POSITIVE_PROMPT ?? "");
    setNegative(sent.NEGATIVE_PROMPT ?? "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const viewingJob = merged.find((j) => j.id === viewing) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="size-4" /> Prompt
          </CardTitle>
          <CardDescription>Type anything. Your words go to the model exactly as written - nothing is added to the prompt.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            {(["A", "B"] as const).map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setEngine(e)}
                className={cn("rounded-lg border p-3 text-left text-sm transition-colors", engine === e ? "border-primary bg-primary/10" : "border-border hover:bg-secondary")}
              >
                <div className="font-medium">{e === "A" ? "Flux" : "SDXL"}</div>
                <div className="text-xs text-muted-foreground">{e === "A" ? "Most realistic - use this for posts. Understands sentences, ~3-5 min" : "Quick drafts, likes short phrases, ~1 min. Looks more 'AI'"}</div>
              </button>
            ))}
          </div>

          <Field label="Prompt">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
              }}
              rows={6}
              placeholder={
                engine === "A"
                  ? "A candid phone photo of a 25 year old woman with long auburn hair sitting on a kitchen counter, morning light from the window, holding a coffee cup."
                  : "candid phone photo, young woman, long auburn hair, sitting on kitchen counter, morning window light, coffee cup"
              }
            />
          </Field>
          {sheen.length ? (
            <Badge variant="warning" className="self-start">
              These words tend to make images look glossy and fake: {sheen.join(", ")}
            </Badge>
          ) : null}

          {engine === "B" ? (
            <Field label="Avoid (negative prompt, optional)">
              <Textarea value={negative} onChange={(e) => setNegative(e.target.value)} rows={2} className="min-h-14" placeholder="e.g. blurry, extra fingers, watermark" />
            </Field>
          ) : (
            <p className="text-xs text-muted-foreground">Flux ignores &quot;avoid&quot; text, so just describe what you want.</p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Shape">
              <Select value={aspect} onChange={(e) => setAspect(e.target.value as "4:5" | "9:16")}>
                <option value="4:5">Portrait 4:5 (feed post)</option>
                <option value="9:16">Tall 9:16 (story)</option>
              </Select>
            </Field>
            <Field label={`Images: ${count}`}>
              <Slider value={count} min={1} max={8} step={1} onChange={setCount} label="number of images" format={(v) => `${v}`} />
            </Field>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <span className="text-xs font-medium text-muted-foreground">Optional extras (none of these change your prompt text)</span>
            {engine === "A" ? (
              <Checkbox
                checked={realismLoras}
                onChange={setRealismLoras}
                label="Realism add-ons (amateur-photo LoRAs)"
                hint="Extra model weights that make Flux look like a real phone photo instead of glossy AI art"
              />
            ) : null}
            <Checkbox
              checked={detailDaemon}
              onChange={setDetailDaemon}
              label="Natural detail boost (Detail Daemon) - no extra time"
              hint="Keeps more real skin, hair and fabric texture while the image is drawn, so it looks less smooth and AI-like"
            />
            <Checkbox
              checked={hires}
              onChange={setHires}
              label={`Optional: high resolution pass (1.5x, can over-sharpen skin) - adds ~${engine === "A" ? "1-2 min" : "20 s"}`}
              hint="Enlarges the image 1.5x and lets the model redraw skin, eyes, hair and fabric at the bigger size"
            />
            <Checkbox checked={faceFix} onChange={setFaceFix} label="Sharpen face details (FaceDetailer)" hint="Re-draws the face area at higher detail after the image is made" />
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox checked={phoneLook} onChange={setPhoneLook} label="Also save a Phone Look version" />
              <Select value={phonePreset} onChange={(e) => setPhonePreset(e.target.value as FinisherPreset)} disabled={!phoneLook} className="w-56">
                {FINISHER_PRESETS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </div>
          </div>

          <button type="button" className="self-start text-xs text-muted-foreground underline" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "Hide" : "Show"} advanced settings
          </button>
          {showAdvanced ? (
            <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
              {engine === "A" ? (
                <Field label={`Guidance ${guidance.toFixed(1)} (lower = more natural)`}>
                  <Slider value={guidance} min={1.8} max={4} step={0.1} onChange={setGuidance} label="flux guidance" format={(v) => v.toFixed(1)} />
                </Field>
              ) : (
                <>
                  <Field label={`CFG ${cfg.toFixed(1)}`}>
                    <Slider value={cfg} min={4.5} max={5.5} step={0.1} onChange={setCfg} label="cfg" format={(v) => v.toFixed(1)} />
                  </Field>
                  <Field label="SDXL model">
                    <Select value={checkpoint} onChange={(e) => setCheckpoint(e.target.value)}>
                      <option value="">default (RealVisXL V5)</option>
                      {sdxlCheckpoints.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </Select>
                  </Field>
                </>
              )}
              <Field label="Seed (same seed + same prompt = same image)">
                <Input value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))} placeholder="random" />
              </Field>
            </div>
          ) : null}

          <div className="flex flex-col gap-1 rounded-lg bg-secondary/60 p-3 text-xs">
            <span className="font-medium text-muted-foreground">Sent to the model</span>
            <code className="whitespace-pre-wrap break-words">{prompt.trim() || "(your prompt)"}</code>
            {engine === "B" && negative.trim() ? <code className="whitespace-pre-wrap break-words text-muted-foreground">avoid: {negative.trim()}</code> : null}
            {loras.length ? <span className="text-muted-foreground">+ add-ons: {loras.map((l) => `${l.name.replace(".safetensors", "")} ${l.strengthModel}`).join(", ")}</span> : null}
          </div>

          <Button size="lg" onClick={() => void submit()} disabled={submitting || !prompt.trim()}>
            <Send /> {submitting ? "Sending..." : `Generate ${count} ${count === 1 ? "image" : "images"} with ${engine === "A" ? "Flux" : "SDXL"}`}
          </Button>
          <p className="text-xs text-muted-foreground">Tip: Ctrl+Enter in the prompt box also generates.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> Results
          </CardTitle>
          <CardDescription>Your latest prompt images. Click one to view it large.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {viewingJob ? (
            <div className="flex flex-col gap-2">
              {(() => {
                const raw = viewingJob.assets.find((a) => a.kind === "raw");
                const phone = viewingJob.assets.find((a) => a.kind === "finished");
                return raw ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element -- local data/ file */}
                    <img src={fileUrl(raw.path)} alt="" className="w-full rounded-lg border border-border" />
                    <div className="flex flex-wrap gap-3 text-sm">
                      <a href={fileUrl(raw.path)} download className="text-primary underline">
                        Download PNG
                      </a>
                      {phone ? (
                        <a href={fileUrl(phone.path)} download className="text-primary underline">
                          Download Phone Look JPEG
                        </a>
                      ) : null}
                      <button type="button" className="text-muted-foreground underline" onClick={() => setViewing(null)}>
                        Close
                      </button>
                    </div>
                  </>
                ) : null;
              })()}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {merged.map((j) => {
              const raw = j.assets.find((a) => a.kind === "raw");
              const active = j.status === "queued" || j.status === "running";
              return (
                <div key={j.id} className={cn("flex flex-col gap-1 rounded-md border p-1", viewing === j.id ? "border-primary" : "border-border")}>
                  {raw ? (
                    <button type="button" onClick={() => setViewing(j.id)}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- local data/ file */}
                      <img src={fileUrl(raw.path)} alt="" className="aspect-[4/5] w-full rounded object-cover" />
                    </button>
                  ) : (
                    <div className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-2 rounded bg-secondary p-2 text-center text-xs text-muted-foreground">
                      {active ? (
                        <>
                          <span>{j.status === "queued" ? "Waiting in line..." : j.progressText || "Starting..."}</span>
                          <Progress value={j.progress} className="w-full" />
                        </>
                      ) : (
                        <span className="text-red-400">{j.status === "failed" ? `Failed: ${(j.error ?? "").slice(0, 120)}` : j.status}</span>
                      )}
                    </div>
                  )}
                  <span className="line-clamp-2 text-[11px] text-muted-foreground" title={sentPrompt(j).POSITIVE_PROMPT}>
                    {sentPrompt(j).POSITIVE_PROMPT ?? j.label}
                  </span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => reuse(j)} title="Put this prompt back in the box">
                      <RotateCcw /> Reuse
                    </Button>
                    {active ? (
                      <Button size="sm" variant="outline" onClick={() => void cancel(j.id)} title="Cancel">
                        <Square />
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          {merged.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet - type a prompt and press Generate.</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

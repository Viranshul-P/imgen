"use client";

import { Check, Dna, Sparkles, Upload, UserPlus } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Slider, Textarea } from "@/components/ui/primitives";
import { BUCKET_LABELS, DATASET_BUCKETS, type DatasetBucket, type SubTokens, parseSubTokens } from "@/lib/buckets";
import { cn, fileUrl } from "@/lib/utils";
import { type CharacterDTO, api, postJson, uploadFile, useStudio } from "./StudioContext";

interface CandidateAsset {
  id: string;
  path: string;
  characterId: string | null;
  job: { template: string } | null;
}

type Draft = Pick<CharacterDTO, "name" | "triggerToken" | "descriptors" | "negativePrompt" | "sdxlCheckpoint" | "sdxlLora" | "sdxlLoraWeight" | "fluxLora" | "fluxLoraWeight">;

const EMPTY: Draft = {
  name: "",
  triggerToken: "",
  descriptors: "",
  negativePrompt: "",
  sdxlCheckpoint: null,
  sdxlLora: null,
  sdxlLoraWeight: 0.85,
  fluxLora: null,
  fluxLoraWeight: 0.85,
};

export function CharacterDNAEditor() {
  const { characters, character, characterId, setCharacterId, reloadCharacters, catalog, notify, jobs } = useStudio();
  const [creating, setCreating] = React.useState(false);
  // Draft is tied to the form it belongs to: switching character / "new" resets it without an effect.
  const formKey = creating ? "new" : (character?.id ?? "");
  const [draftState, setDraftState] = React.useState<{ key: string; draft: Draft }>({ key: "", draft: EMPTY });
  const draft: Draft = draftState.key === formKey ? draftState.draft : creating || !character ? EMPTY : { ...character };
  const [candidateCount, setCandidateCount] = React.useState(6);
  const [candidates, setCandidates] = React.useState<CandidateAsset[]>([]);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const finished = jobs.filter((j) => j.status === "done").length;

  React.useEffect(() => {
    if (!characterId) return;
    let cancelled = false;
    api<CandidateAsset[]>(`/api/assets?kind=raw&characterId=${encodeURIComponent(characterId)}&limit=60`)
      .then((list) => {
        if (!cancelled) setCandidates(list.filter((a) => a.job?.template === "genesis_master_face_candidates"));
      })
      .catch((e: unknown) => notify("error", String(e)));
    return () => {
      cancelled = true;
    };
  }, [characterId, finished, notify]);
  const visibleCandidates = candidates.filter((c) => c.characterId === characterId);

  // Multi-bucket sub-tokens are edited as an object and sent as an object (the DTO carries them as JSON text).
  const [subState, setSubState] = React.useState<{ key: string; tokens: SubTokens }>({ key: "", tokens: {} });
  const subTokens: SubTokens = subState.key === formKey ? subState.tokens : creating || !character ? {} : parseSubTokens(character.subTokens);
  const setSubToken = (bucket: DatasetBucket, value: string): void =>
    setSubState({ key: formKey, tokens: { ...subTokens, [bucket]: value.toLowerCase().replace(/[^a-z0-9_]/g, "") } });

  /** Only the fields this form edits: spreading the whole character would re-send JSON-text fields as strings. */
  const payload = (): Record<string, unknown> => ({
    name: draft.name,
    triggerToken: draft.triggerToken,
    descriptors: draft.descriptors,
    negativePrompt: draft.negativePrompt,
    sdxlCheckpoint: draft.sdxlCheckpoint,
    sdxlLora: draft.sdxlLora,
    sdxlLoraWeight: draft.sdxlLoraWeight,
    fluxLora: draft.fluxLora,
    fluxLoraWeight: draft.fluxLoraWeight,
    subTokens,
  });

  const save = async (): Promise<void> => {
    try {
      if (creating) {
        const created = await postJson<CharacterDTO>("/api/characters", payload());
        setCreating(false);
        await reloadCharacters();
        setCharacterId(created.id);
        notify("ok", `Created ${created.name}`);
      } else if (character) {
        await postJson("/api/characters", { id: character.id, ...payload() }, "PATCH");
        await reloadCharacters();
        notify("ok", "Character DNA saved");
      }
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const setMasterFace = async (assetId: string): Promise<void> => {
    if (!character) return;
    try {
      await postJson("/api/characters", { id: character.id, masterFaceAssetId: assetId }, "PATCH");
      await reloadCharacters();
      notify("ok", "master_face.png selected");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const generateCandidates = async (): Promise<void> => {
    if (!character) return;
    try {
      const res = await postJson<{ queued: number }>("/api/jobs", { kind: "genesis_faces", characterId: character.id, count: candidateCount });
      notify("ok", `Queued ${res.queued} master face candidates`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void => setDraftState({ key: formKey, draft: { ...draft, [k]: v } });
  const sdxlLoras = (catalog?.loras ?? []).filter((l) => !/flux/i.test(l));
  const fluxLoras = (catalog?.loras ?? []).filter((l) => /flux/i.test(l));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Dna className="size-4" /> Character DNA
        </CardTitle>
        <CardDescription>One fictional character: trigger token, locked descriptors and identity LoRAs.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Select className="max-w-xs" value={creating ? "" : characterId} onChange={(e) => (setCreating(false), setCharacterId(e.target.value))} disabled={characters.length === 0}>
            {characters.length === 0 ? <option value="">no characters yet</option> : null}
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.triggerToken})
              </option>
            ))}
          </Select>
          <Button variant={creating ? "default" : "outline"} onClick={() => setCreating((v) => !v)}>
            <UserPlus /> {creating ? "Cancel new" : "New character"}
          </Button>
        </div>

        {creating || character ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Vira" />
              </Field>
              <Field label="Trigger token (unique, a-z 0-9 _)">
                <Input value={draft.triggerToken} onChange={(e) => set("triggerToken", e.target.value.toLowerCase())} placeholder="v1ra_person" />
              </Field>
            </div>
            <Field label="Locked physical descriptors (eye colour, hair texture, natural beauty marks, proportions)">
              <Textarea value={draft.descriptors} onChange={(e) => set("descriptors", e.target.value)} placeholder="hazel eyes, wavy shoulder-length dark brown hair, small beauty mark under left eye, freckles across nose" />
            </Field>
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <span className="text-xs font-medium text-muted-foreground">
                Training sub-tokens (multi-bucket LoRA). Leave blank to use {draft.triggerToken || "<trigger>"}_face, _body, _chest and _lower.
              </span>
              <div className="grid gap-3 sm:grid-cols-2">
                {DATASET_BUCKETS.map((b) => (
                  <Field key={b} label={BUCKET_LABELS[b]}>
                    <Input value={subTokens[b] ?? ""} onChange={(e) => setSubToken(b, e.target.value)} placeholder={`${draft.triggerToken || "trigger"}_${b}`} />
                  </Field>
                ))}
              </div>
            </div>
            <Field label="Character negative">
              <Input value={draft.negativePrompt} onChange={(e) => set("negativePrompt", e.target.value)} placeholder="tattoos, blonde hair" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Default SDXL checkpoint">
                <Select value={draft.sdxlCheckpoint ?? ""} onChange={(e) => set("sdxlCheckpoint", e.target.value || null)}>
                  <option value="">RealVisXL V5 (default)</option>
                  {(catalog?.checkpoints ?? []).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label={`SDXL Character LoRA (${draft.sdxlLoraWeight.toFixed(2)})`}>
                <Select value={draft.sdxlLora ?? ""} onChange={(e) => set("sdxlLora", e.target.value || null)}>
                  <option value="">not trained yet</option>
                  {sdxlLoras.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </Select>
                <Slider value={draft.sdxlLoraWeight} min={0.5} max={1.2} step={0.05} onChange={(v) => set("sdxlLoraWeight", v)} />
              </Field>
              <Field label={`Flux Character LoRA (${draft.fluxLoraWeight.toFixed(2)})`}>
                <Select value={draft.fluxLora ?? ""} onChange={(e) => set("fluxLora", e.target.value || null)}>
                  <option value="">not trained yet</option>
                  {fluxLoras.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </Select>
                <Slider value={draft.fluxLoraWeight} min={0.5} max={1.2} step={0.05} onChange={(v) => set("fluxLoraWeight", v)} />
              </Field>
            </div>
            <Button onClick={() => void save()}>{creating ? "Create character" : "Save DNA"}</Button>
          </>
        ) : null}

        {character && !creating ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium">master_face.png</span>
              {character.masterFacePath ? <Badge variant="success">selected</Badge> : <Badge variant="warning">not selected</Badge>}
              <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
                <Upload /> Upload
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadFile(f, "upload", { characterId: character.id }).then((a) => setMasterFace(a.id));
                }}
              />
              <div className="flex items-center gap-2">
                <Slider value={candidateCount} min={1} max={20} step={1} onChange={setCandidateCount} className="w-32" />
                <Button size="sm" onClick={() => void generateCandidates()}>
                  <Sparkles /> Generate {candidateCount} candidates
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {character.masterFacePath ? (
                // eslint-disable-next-line @next/next/no-img-element -- local data/ file
                <img src={fileUrl(character.masterFacePath)} alt="master face" className="aspect-square w-full rounded object-cover ring-2 ring-primary" />
              ) : null}
              {visibleCandidates.map((c) => (
                <button key={c.id} type="button" className="group relative block" onClick={() => void setMasterFace(c.id)} title="Use as master_face.png">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local data/ file */}
                  <img src={fileUrl(c.path)} alt="" className={cn("aspect-square w-full rounded object-cover", c.path === character.masterFacePath ? "ring-2 ring-primary" : "opacity-80 group-hover:opacity-100")} />
                  <span className="absolute bottom-1 right-1 hidden rounded bg-black/70 p-1 group-hover:block">
                    <Check className="size-3" />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

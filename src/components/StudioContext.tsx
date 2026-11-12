"use client";

import * as React from "react";
import type { ModelCatalog } from "@/lib/modelDiscovery";

export interface CharacterDTO {
  id: string;
  name: string;
  triggerToken: string;
  descriptors: string;
  negativePrompt: string;
  masterFacePath: string | null;
  sdxlCheckpoint: string | null;
  sdxlLora: string | null;
  sdxlLoraWeight: number;
  fluxLora: string | null;
  fluxLoraWeight: number;
  defaultLoras: string;
  /** JSON text of custom multi-bucket sub-tokens, e.g. {"body":"vira_fullbody"}. */
  subTokens: string;
  _count?: { jobs: number; assets: number; campaigns: number };
}

export interface ArcDTO {
  id: string;
  name: string;
  mode: string;
  stages: string;
  createdAt: string;
}

export interface CampaignDTO {
  id: string;
  name: string;
  description: string;
  characterId: string;
  arcs: ArcDTO[];
  _count?: { assets: number; jobs: number };
}

export interface AssetRef {
  id: string;
  path: string;
  kind: string;
}

export interface StreamJob {
  id: string;
  status: string;
  label: string;
  template: string;
  progress: number;
  progressText: string;
  error: string | null;
  stage: number | null;
  durationMs: number | null;
  assets: AssetRef[];
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function postJson<T>(url: string, data: unknown, method: "POST" | "PATCH" = "POST"): Promise<T> {
  return api<T>(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

export async function uploadFile(file: Blob, kind: "upload" | "mask", extra: Record<string, string> = {}): Promise<{ id: string; path: string }> {
  const form = new FormData();
  form.append("file", file, kind === "mask" ? "mask.png" : "upload.png");
  form.append("kind", kind);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return api("/api/uploads", { method: "POST", body: form });
}

interface StudioState {
  catalog: ModelCatalog | null;
  catalogError: string | null;
  refreshModels: () => Promise<void>;
  characters: CharacterDTO[];
  reloadCharacters: () => Promise<void>;
  characterId: string;
  setCharacterId: (id: string) => void;
  character: CharacterDTO | null;
  campaigns: CampaignDTO[];
  reloadCampaigns: () => Promise<void>;
  jobs: StreamJob[];
  toast: { kind: "ok" | "error"; text: string } | null;
  notify: (kind: "ok" | "error", text: string) => void;
}

const StudioCtx = React.createContext<StudioState | null>(null);

export function useStudio(): StudioState {
  const ctx = React.useContext(StudioCtx);
  if (!ctx) throw new Error("useStudio must be used inside <StudioProvider>");
  return ctx;
}

const CHARACTER_KEY = "pf.characterId";

/** Keep the current selection if it still exists, else the remembered one, else the first character. */
function pickCharacterId(list: CharacterDTO[], current: string): string {
  if (current && list.some((c) => c.id === current)) return current;
  let saved = "";
  try {
    saved = window.localStorage.getItem(CHARACTER_KEY) ?? "";
  } catch {
    /* storage unavailable (private window) */
  }
  return list.some((c) => c.id === saved) ? saved : (list[0]?.id ?? "");
}

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const [catalog, setCatalog] = React.useState<ModelCatalog | null>(null);
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const [characters, setCharacters] = React.useState<CharacterDTO[]>([]);
  const [characterId, setCharacterIdState] = React.useState("");
  const [campaigns, setCampaigns] = React.useState<CampaignDTO[]>([]);
  const [jobs, setJobs] = React.useState<StreamJob[]>([]);
  const [toast, setToast] = React.useState<StudioState["toast"]>(null);

  const notify = React.useCallback((kind: "ok" | "error", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 6000);
  }, []);

  const refreshModels = React.useCallback(async () => {
    try {
      setCatalog(await api<ModelCatalog>("/api/comfy/models?refresh=1"));
      setCatalogError(null);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const applyCharacters = React.useCallback((list: CharacterDTO[]) => {
    setCharacters(list);
    setCharacterIdState((current) => pickCharacterId(list, current));
  }, []);

  const reloadCharacters = React.useCallback(async () => {
    applyCharacters(await api<CharacterDTO[]>("/api/characters"));
  }, [applyCharacters]);

  const reloadCampaigns = React.useCallback(async () => {
    setCampaigns(await api<CampaignDTO[]>("/api/campaigns"));
  }, []);

  const setCharacterId = React.useCallback((id: string) => {
    setCharacterIdState(id);
    try {
      window.localStorage.setItem(CHARACTER_KEY, id);
    } catch {
      /* storage unavailable */
    }
  }, []);

  // Initial load: fetch in the effect, set state only in the async callbacks.
  React.useEffect(() => {
    let cancelled = false;
    api<ModelCatalog>("/api/comfy/models")
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch((err: unknown) => {
        if (!cancelled) setCatalogError(err instanceof Error ? err.message : String(err));
      });
    api<CharacterDTO[]>("/api/characters")
      .then((list) => {
        if (!cancelled) applyCharacters(list);
      })
      .catch((e: unknown) => notify("error", String(e)));
    api<CampaignDTO[]>("/api/campaigns")
      .then((list) => {
        if (!cancelled) setCampaigns(list);
      })
      .catch((e: unknown) => notify("error", String(e)));
    return () => {
      cancelled = true;
    };
  }, [applyCharacters, notify]);

  React.useEffect(() => {
    const source = new EventSource("/api/jobs/stream");
    source.addEventListener("jobs", (ev) => {
      const data = JSON.parse((ev as MessageEvent<string>).data) as { jobs: StreamJob[] };
      setJobs(data.jobs);
    });
    return () => source.close();
  }, []);

  const character = characters.find((c) => c.id === characterId) ?? null;
  const value: StudioState = {
    catalog,
    catalogError,
    refreshModels,
    characters,
    reloadCharacters,
    characterId,
    setCharacterId,
    character,
    campaigns,
    reloadCampaigns,
    jobs,
    toast,
    notify,
  };
  return <StudioCtx.Provider value={value}>{children}</StudioCtx.Provider>;
}

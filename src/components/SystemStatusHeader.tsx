"use client";

import { Activity, Cloud, Cpu, Layers, RefreshCw, Trash2 } from "lucide-react";
import * as React from "react";
import { Badge, Button, Input, Progress, Select } from "@/components/ui/primitives";
import { cn, formatBytes } from "@/lib/utils";
import { api, postJson, useStudio } from "./StudioContext";

interface StatusResponse {
  endpoint?: { mode: "local" | "remote"; url: string; localUrl: string; remoteUrl: string };
  comfy: { up: false } | { up: true; version: string; device: string; vramTotal: number; vramFree: number; ramTotal: number; ramFree: number };
  worker: { alive: boolean; activeEngine?: string; activeModel?: string; flushCount?: number };
  queue: { queued: number; running: number; done: number; failed: number };
  running: { label: string; progress: number; progressText: string } | null;
}

function Meter({ label, used, total }: { label: string; used: number; total: number }) {
  const ratio = total > 0 ? used / total : 0;
  return (
    <div className="min-w-40 flex-1">
      <div className="mb-1 flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {formatBytes(used)} / {formatBytes(total)}
        </span>
      </div>
      <Progress value={ratio} className={cn(ratio > 0.9 && "[&>div]:bg-red-500")} />
    </div>
  );
}

const ENGINE_LABEL: Record<string, string> = { FLUX_GGUF: "Engine A - Flux GGUF", SDXL: "SDXL (B/C)" };

export function SystemStatusHeader() {
  const { refreshModels, notify, catalog } = useStudio();
  const [status, setStatus] = React.useState<StatusResponse | null>(null);
  const [busy, setBusy] = React.useState<"free" | "models" | "endpoint" | null>(null);
  const [urlEdit, setUrlEdit] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const s = await api<StatusResponse>("/api/comfy/status");
        if (alive) setStatus(s);
      } catch {
        if (alive) setStatus(null);
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const freeVram = async (): Promise<void> => {
    setBusy("free");
    try {
      await api("/api/comfy/free", { method: "POST" });
      notify("ok", "VRAM freed - models unloaded");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const reloadModels = async (): Promise<void> => {
    setBusy("models");
    await refreshModels();
    setBusy(null);
    notify("ok", "Model lists refreshed from ComfyUI");
  };

  const endpoint = status?.endpoint;
  const remote = endpoint?.mode === "remote";
  const remoteUrl = urlEdit ?? endpoint?.remoteUrl ?? "";

  /** Switch between the laptop GPU and a cloud GPU tunnel (both the studio and the worker follow). */
  const changeEndpoint = async (change: { mode?: "local" | "remote"; remoteUrl?: string }): Promise<void> => {
    setBusy("endpoint");
    try {
      const res = await postJson<{ mode: "local" | "remote"; url: string; reachable: boolean }>("/api/comfy/endpoint", change);
      setUrlEdit(null);
      await refreshModels();
      if (res.mode === "remote") {
        notify(res.reachable ? "ok" : "error", res.reachable ? `Cloud GPU connected (${res.url}). 8 GB limits are off.` : `Nothing answers at ${res.url}. Start the SSH tunnel first (see docs/CLOUD.md).`);
      } else {
        notify("ok", "Using the local laptop GPU (8 GB rules on)");
      }
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const comfy = status?.comfy;
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-4 px-4 py-3">
        <div className="flex items-center gap-2">
          <Layers className="size-5 text-primary" />
          <span className="font-semibold">PersonaForge</span>
        </div>
        <Badge variant={comfy?.up ? "success" : "destructive"}>
          <Cpu className="size-3" />
          {comfy?.up ? `ComfyUI ${comfy.version}` : "ComfyUI offline"}
        </Badge>
        <Badge variant={status?.worker.alive ? "success" : "warning"}>
          <Activity className="size-3" />
          {status?.worker.alive ? "worker running" : "worker stopped"}
        </Badge>
        <div className="flex items-center gap-2">
          <Cloud className={cn("size-4", remote ? "text-primary" : "text-muted-foreground")} />
          <Select
            value={endpoint?.mode ?? "local"}
            onChange={(e) => void changeEndpoint({ mode: e.target.value as "local" | "remote" })}
            disabled={busy !== null || !endpoint}
            className="h-8 w-56 text-xs"
            title="Which GPU runs your images"
          >
            <option value="local">Local Laptop GPU (8 GB rules)</option>
            <option value="remote">Remote Cloud GPU Tunnel</option>
          </Select>
          {remote ? (
            <>
              <Input
                value={remoteUrl}
                onChange={(e) => setUrlEdit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void changeEndpoint({ remoteUrl });
                }}
                placeholder="http://127.0.0.1:8189"
                className="h-8 w-52 text-xs"
                aria-label="Cloud GPU URL"
              />
              {urlEdit !== null && urlEdit !== endpoint?.remoteUrl ? (
                <Button size="sm" variant="outline" onClick={() => void changeEndpoint({ remoteUrl })} disabled={busy !== null}>
                  Save URL
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
        <Badge variant="outline">{status?.worker.activeEngine ? ENGINE_LABEL[status.worker.activeEngine] ?? status.worker.activeEngine : "no engine loaded"}</Badge>
        {comfy?.up ? (
          <div className="flex min-w-80 flex-1 flex-wrap gap-4">
            <Meter label="VRAM" used={comfy.vramTotal - comfy.vramFree} total={comfy.vramTotal} />
            <Meter label="RAM" used={comfy.ramTotal - comfy.ramFree} total={comfy.ramTotal} />
          </div>
        ) : (
          <div className="flex-1 text-xs text-muted-foreground">
            {remote ? "Start the SSH tunnel to the cloud GPU (see docs/CLOUD.md)" : "Start ComfyUI: scripts\\start_comfy_api.ps1 -Background"}
          </div>
        )}
        <div className="text-xs text-muted-foreground tabular-nums">
          queue {status?.queue.queued ?? 0} | running {status?.queue.running ?? 0} | failed {status?.queue.failed ?? 0}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void reloadModels()} disabled={busy !== null} title={catalog ? `Last refresh ${new Date(catalog.fetchedAt).toLocaleTimeString()}` : undefined}>
            <RefreshCw className={cn(busy === "models" && "animate-spin")} /> Refresh Models
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void freeVram()} disabled={busy !== null || !comfy?.up}>
            <Trash2 /> Free VRAM
          </Button>
        </div>
      </div>
      {status?.running ? (
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 pb-2 text-xs text-muted-foreground">
          <span className="truncate">Running: {status.running.label}</span>
          <Progress value={status.running.progress} className="h-1.5 max-w-64" />
          <span className="truncate">{status.running.progressText}</span>
        </div>
      ) : null}
    </header>
  );
}

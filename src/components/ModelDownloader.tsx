"use client";

import { Download, X } from "lucide-react";
import * as React from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Field, Input, Progress, Select } from "@/components/ui/primitives";
import { api, postJson, useStudio } from "./StudioContext";

interface DownloadRow {
  id: string;
  target: "local" | "remote";
  folder: "checkpoints" | "loras";
  source: string;
  filename: string;
  status: "resolving" | "downloading" | "verifying" | "done" | "failed";
  bytes: number;
  total: number | null;
  percent: number | null;
  error: string | null;
  warning: string | null;
  civitai?: { modelName: string; versionName: string; type: string; baseModel: string };
}

interface DownloadList {
  target: "local" | "remote";
  remoteFetcherUrl: string;
  hasCivitaiToken: boolean;
  downloads: DownloadRow[];
}

const ACTIVE = new Set(["resolving", "downloading", "verifying"]);

function gib(bytes: number): string {
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(2)} GiB` : `${(bytes / 2 ** 20).toFixed(0)} MiB`;
}

/** "Download Custom Model / LoRA" dialog: Civitai version ID or direct URL -> the active ComfyUI's models folder. */
export function ModelDownloader({ onClose }: { onClose: () => void }) {
  const { refreshModels, notify } = useStudio();
  const [source, setSource] = React.useState("");
  const [folder, setFolder] = React.useState<"checkpoints" | "loras">("loras");
  const [token, setToken] = React.useState("");
  const [saveToken, setSaveToken] = React.useState(true);
  const [list, setList] = React.useState<DownloadList | null>(null);
  const [busy, setBusy] = React.useState(false);
  /** Downloads already announced as finished (so /object_info is refreshed once per download). */
  const seenDone = React.useRef<Set<string> | null>(null);

  const load = React.useCallback(async () => {
    try {
      const next = await api<DownloadList>("/api/comfy/download-model");
      setList(next);
      const done = next.downloads.filter((d) => d.status === "done").map((d) => d.id);
      if (seenDone.current === null) seenDone.current = new Set(done);
      const fresh = done.filter((id) => !seenDone.current?.has(id));
      if (fresh.length) {
        fresh.forEach((id) => seenDone.current?.add(id));
        await refreshModels(); // ComfyUI re-scans its model folders on /object_info
        notify("ok", `Downloaded ${fresh.length} model file(s); model lists refreshed`);
      }
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  }, [refreshModels, notify]);

  const active = list?.downloads.some((d) => ACTIVE.has(d.status)) ?? false;
  // Initial load: state is only set from the timer callback, never synchronously in the effect.
  React.useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 1000);
    return () => clearInterval(t);
  }, [active, load]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      const row = await postJson<DownloadRow>("/api/comfy/download-model", {
        source,
        folder,
        civitaiToken: token.trim() || undefined,
        saveToken: token.trim() ? saveToken : undefined,
      });
      notify("ok", `Downloading ${row.filename || "model"} into ${folder}/`);
      setSource("");
      setToken("");
      await load();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-16" onClick={onClose}>
      <Card className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Download Custom Model / LoRA">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Download className="size-4" /> Download Custom Model / LoRA
            </span>
            <Button size="icon" variant="ghost" onClick={onClose} title="Close">
              <X />
            </Button>
          </CardTitle>
          <CardDescription>
            Saves the .safetensors file straight into the{" "}
            {list?.target === "remote" ? <b>cloud GPU</b> : <b>laptop</b>} ComfyUI&apos;s <code>models/{folder}</code> folder, then refreshes the model lists.
            {list?.target === "remote" ? ` Remote mode uses the cloud fetcher at ${list.remoteFetcherUrl}.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
            <Field label="Civitai model version ID, or a direct download URL">
              <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. 128713  or  https://huggingface.co/.../file.safetensors" />
            </Field>
            <Field label="Target folder">
              <Select value={folder} onChange={(e) => setFolder(e.target.value as "checkpoints" | "loras")}>
                <option value="loras">loras</option>
                <option value="checkpoints">checkpoints</option>
              </Select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label={list?.hasCivitaiToken ? "Civitai API key (one is already set; leave blank to keep it)" : "Civitai API key (optional; some models need one)"}>
              <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="civitai.com > Account settings > API keys" autoComplete="off" />
            </Field>
            <Checkbox checked={saveToken} onChange={setSaveToken} label="Save to .env.local" disabled={!token.trim()} hint="Otherwise the key is kept only until the studio restarts" />
          </div>
          <p className="text-xs text-muted-foreground">
            The version ID is the number after <code>?modelVersionId=</code> on a Civitai model page. Only .safetensors files are accepted; Civitai downloads are
            checked against their SHA-256. The key is only ever sent to civitai.com.
          </p>
          <Button onClick={() => void start()} disabled={busy || !source.trim()}>
            {busy ? "Starting..." : "Download"}
          </Button>

          {list?.downloads.length ? (
            <div className="flex flex-col gap-3">
              {list.downloads.map((d) => (
                <div key={d.id} className="flex flex-col gap-1 rounded-md border border-border p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={d.status === "done" ? "success" : d.status === "failed" ? "destructive" : "outline"}>{d.status}</Badge>
                    <span className="font-medium">{d.filename || d.source}</span>
                    <span className="text-muted-foreground">
                      {d.target === "remote" ? "cloud" : "laptop"} / {d.folder}
                    </span>
                    {d.civitai?.type ? (
                      <span className="text-muted-foreground">
                        {d.civitai.modelName} · {d.civitai.type} · {d.civitai.baseModel}
                      </span>
                    ) : null}
                  </div>
                  {ACTIVE.has(d.status) ? (
                    <div className="flex items-center gap-2">
                      <Progress value={(d.percent ?? 0) / 100} className="h-1.5" />
                      <span className="w-40 shrink-0 text-right tabular-nums">
                        {d.percent !== null ? `${d.percent.toFixed(1)}%` : "…"} {d.total ? `of ${gib(d.total)}` : gib(d.bytes)}
                      </span>
                    </div>
                  ) : null}
                  {d.warning ? <span className="text-amber-400">{d.warning}</span> : null}
                  {d.error ? <span className="text-destructive">{d.error}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

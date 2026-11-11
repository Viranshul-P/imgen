"use client";

import { RotateCcw, X } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Progress } from "@/components/ui/primitives";
import { fileUrl } from "@/lib/utils";
import { api, postJson, useStudio } from "./StudioContext";

const STATUS_VARIANT: Record<string, "secondary" | "success" | "warning" | "destructive" | "outline"> = {
  queued: "outline",
  running: "warning",
  done: "success",
  failed: "destructive",
  cancelled: "secondary",
};

/** Live queue fed by GET /api/jobs/stream (SSE). */
export function JobQueue({ title = "Queue", filter }: { title?: string; filter?: (template: string) => boolean }) {
  const { jobs, notify } = useStudio();
  const visible = jobs.filter((j) => (filter ? filter(j.template) : true));

  const cancel = async (id: string): Promise<void> => {
    try {
      await api(`/api/jobs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };
  const retry = async (id: string): Promise<void> => {
    try {
      await postJson("/api/jobs", { kind: "retry", id });
      notify("ok", "Job re-queued");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex max-h-[560px] flex-col gap-2 overflow-y-auto">
        {visible.length === 0 ? <p className="text-sm text-muted-foreground">Nothing queued. Finished jobs stay here for a minute; everything is kept in the Vault.</p> : null}
        {visible.map((job) => (
          <div key={job.id} className="flex gap-3 rounded-md border border-border p-2">
            {job.assets[0] ? (
              // eslint-disable-next-line @next/next/no-img-element -- thumbnails of local outputs served by /api/files
              <img src={fileUrl(job.assets[0].path)} alt="" className="size-14 shrink-0 rounded object-cover" />
            ) : (
              <div className="size-14 shrink-0 rounded bg-secondary" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <Badge variant={STATUS_VARIANT[job.status] ?? "outline"}>{job.status}</Badge>
                <span className="truncate text-sm">{job.label}</span>
              </div>
              {job.status === "running" ? <Progress value={job.progress} /> : null}
              <span className="truncate text-xs text-muted-foreground">
                {job.status === "failed" ? job.error : job.progressText}
                {job.durationMs ? ` - ${(job.durationMs / 1000).toFixed(1)}s` : ""}
              </span>
            </div>
            {job.status === "queued" || job.status === "running" ? (
              <Button size="icon" variant="ghost" onClick={() => void cancel(job.id)} title="Cancel">
                <X />
              </Button>
            ) : job.status === "failed" || job.status === "cancelled" ? (
              <Button size="icon" variant="ghost" onClick={() => void retry(job.id)} title="Retry">
                <RotateCcw />
              </Button>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

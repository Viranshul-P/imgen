"use client";

import { Camera, Dna, Images, ListOrdered } from "lucide-react";
import * as React from "react";
import { ArcProgressionBuilder } from "@/components/ArcProgressionBuilder";
import { CharacterDNAEditor } from "@/components/CharacterDNAEditor";
import { ContentVault } from "@/components/ContentVault";
import { DatasetCurator } from "@/components/DatasetCurator";
import { ShootGenerator } from "@/components/ShootGenerator";
import { StudioProvider, useStudio } from "@/components/StudioContext";
import { SystemStatusHeader } from "@/components/SystemStatusHeader";
import { Tabs } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "shoot", label: "Shoot", icon: <Camera /> },
  { id: "arc", label: "Progression Arc", icon: <ListOrdered /> },
  { id: "character", label: "Character & Dataset", icon: <Dna /> },
  { id: "vault", label: "Vault", icon: <Images /> },
];

function Toast() {
  const { toast } = useStudio();
  if (!toast) return null;
  return (
    <div
      role="status"
      className={cn(
        "fixed bottom-4 right-4 z-50 max-w-md rounded-lg border px-4 py-3 text-sm shadow-lg",
        toast.kind === "error" ? "border-red-800 bg-red-950 text-red-200" : "border-emerald-800 bg-emerald-950 text-emerald-200",
      )}
    >
      {toast.text}
    </div>
  );
}

function Studio() {
  const [tab, setTab] = React.useState("shoot");
  const { catalogError } = useStudio();
  return (
    <>
      <SystemStatusHeader />
      <main className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-4">
        <Tabs items={TABS} value={tab} onChange={setTab} />
        {catalogError ? <p className="text-sm text-amber-400">Model lists unavailable: {catalogError}. Start ComfyUI and press Refresh Models.</p> : null}
        {tab === "shoot" ? <ShootGenerator /> : null}
        {tab === "arc" ? <ArcProgressionBuilder /> : null}
        {tab === "character" ? (
          <div className="flex flex-col gap-4">
            <CharacterDNAEditor />
            <DatasetCurator />
          </div>
        ) : null}
        {tab === "vault" ? <ContentVault /> : null}
      </main>
      <Toast />
    </>
  );
}

export default function Page() {
  return (
    <StudioProvider>
      <Studio />
    </StudioProvider>
  );
}

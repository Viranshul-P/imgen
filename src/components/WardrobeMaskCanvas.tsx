"use client";

import { Brush, Download, Eraser, FlipHorizontal2, Redo2, Sparkles, Trash, Undo2 } from "lucide-react";
import * as React from "react";
import { Button, Checkbox, Field, Slider } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { AUTO_MASK_LABELS, type AutoMaskCategory } from "@/lib/autoMaskShared";
import { fileUrl } from "@/lib/utils";
import { postJson, uploadFile, useStudio } from "./StudioContext";

const PAINT = "rgb(255, 40, 90)";
const HISTORY_LIMIT = 40;

export interface WardrobeMaskCanvasProps {
  /** URL of the base stage image the mask is painted over. */
  imageUrl: string;
  /** Called with the uploaded binary mask (white = repaint, black = keep pixel-identical). */
  onExported: (mask: { id: string; path: string }) => void;
  /** DATA_DIR-relative path of the same image; enables the 1-click auto-mask toolbar. */
  imagePath?: string;
  characterId?: string;
  className?: string;
}

export function WardrobeMaskCanvas({ imageUrl, imagePath, onExported, characterId, className }: WardrobeMaskCanvasProps) {
  const { notify } = useStudio();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const drawing = React.useRef<{ x: number; y: number } | null>(null);
  const undoStack = React.useRef<ImageData[]>([]);
  const redoStack = React.useRef<ImageData[]>([]);
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = React.useState<"paint" | "erase">("paint");
  const [brush, setBrush] = React.useState(48);
  const [feather, setFeather] = React.useState(true);
  const [history, setHistory] = React.useState({ undo: 0, redo: 0 });
  const [exporting, setExporting] = React.useState(false);
  const [autoCats, setAutoCats] = React.useState<AutoMaskCategory[]>(["upper"]);
  const [autoBusy, setAutoBusy] = React.useState(false);

  const ctx = (): CanvasRenderingContext2D | null => canvasRef.current?.getContext("2d", { willReadFrequently: true }) ?? null;

  const snapshot = (): void => {
    const c = ctx();
    if (!c || !size) return;
    undoStack.current.push(c.getImageData(0, 0, size.w, size.h));
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
    setHistory({ undo: undoStack.current.length, redo: 0 });
  };

  const restore = (from: React.RefObject<ImageData[]>, to: React.RefObject<ImageData[]>): void => {
    const c = ctx();
    const image = from.current.pop();
    if (!c || !size || !image) return;
    to.current.push(c.getImageData(0, 0, size.w, size.h));
    c.putImageData(image, 0, 0);
    setHistory({ undo: undoStack.current.length, redo: redoStack.current.length });
  };
  const undo = (): void => restore(undoStack, redoStack);
  const redo = (): void => restore(redoStack, undoStack);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toCanvas = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number; scale: number } => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale, scale };
  };

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }, scale: number): void => {
    const c = ctx();
    if (!c) return;
    c.globalCompositeOperation = mode === "erase" ? "destination-out" : "source-over";
    c.strokeStyle = PAINT;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.lineWidth = brush * scale;
    c.beginPath();
    c.moveTo(from.x, from.y);
    c.lineTo(to.x, to.y);
    c.stroke();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    snapshot();
    const p = toCanvas(e);
    drawing.current = { x: p.x, y: p.y };
    stroke(p, { x: p.x + 0.01, y: p.y }, p.scale);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drawing.current) return;
    const p = toCanvas(e);
    stroke(drawing.current, p, p.scale);
    drawing.current = { x: p.x, y: p.y };
  };
  const onPointerUp = (): void => {
    drawing.current = null;
  };

  const invert = (): void => {
    const c = ctx();
    if (!c || !size) return;
    snapshot();
    const img = c.getImageData(0, 0, size.w, size.h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const painted = (d[i + 3] ?? 0) > 127;
      d[i] = 255;
      d[i + 1] = 40;
      d[i + 2] = 90;
      d[i + 3] = painted ? 0 : 255;
    }
    c.globalCompositeOperation = "source-over";
    c.putImageData(img, 0, 0);
  };

  const clear = (): void => {
    const c = ctx();
    if (!c || !size) return;
    snapshot();
    c.clearRect(0, 0, size.w, size.h);
  };

  /** Ask the server (SegFormer B2 clothes) for a mask of the ticked garments and paint it onto the canvas for fine-tuning. */
  const autoMask = async (): Promise<void> => {
    const c = ctx();
    if (!c || !size || !imagePath) return;
    setAutoBusy(true);
    try {
      const res = await postJson<{ path: string; coverage: number }>("/api/comfy/auto-mask", { imagePath, categories: autoCats, characterId });
      if (res.coverage < 0.002) {
        notify("error", "No matching clothing was found in this frame. Try other garments or paint by hand.");
        return;
      }
      const maskImg = new Image();
      await new Promise<void>((resolve, reject) => {
        maskImg.onload = () => resolve();
        maskImg.onerror = () => reject(new Error("could not load the generated mask"));
        maskImg.src = fileUrl(res.path);
      });
      const tmp = document.createElement("canvas");
      tmp.width = size.w;
      tmp.height = size.h;
      const t = tmp.getContext("2d", { willReadFrequently: true });
      if (!t) return;
      t.drawImage(maskImg, 0, 0, size.w, size.h);
      const src = t.getImageData(0, 0, size.w, size.h);
      snapshot();
      const out = c.getImageData(0, 0, size.w, size.h);
      for (let i = 0; i < src.data.length; i += 4) {
        if ((src.data[i] ?? 0) > 127) {
          out.data[i] = 255;
          out.data[i + 1] = 40;
          out.data[i + 2] = 90;
          out.data[i + 3] = 255;
        }
      }
      c.putImageData(out, 0, 0);
      notify("ok", `Auto-mask covers ${Math.round(res.coverage * 100)}% of the frame. Adjust with the brush, then click "Use this mask".`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setAutoBusy(false);
    }
  };

  const exportMask = async (): Promise<void> => {
    const c = ctx();
    if (!c || !size) return;
    const src = c.getImageData(0, 0, size.w, size.h).data;
    const out = document.createElement("canvas");
    out.width = size.w;
    out.height = size.h;
    const o = out.getContext("2d");
    if (!o) return;
    const img = o.createImageData(size.w, size.h);
    let painted = 0;
    for (let i = 0; i < src.length; i += 4) {
      const v = (src[i + 3] ?? 0) > 127 ? 255 : 0;
      if (v) painted++;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    if (painted === 0) {
      notify("error", "Paint the outfit/body region first - the mask is empty");
      return;
    }
    o.putImageData(img, 0, 0);
    setExporting(true);
    try {
      const blob = await new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png"));
      const saved = await uploadFile(blob, "mask", characterId ? { characterId } : {});
      onExported(saved);
      notify("ok", `Mask exported (${Math.round((painted / (size.w * size.h)) * 100)}% of frame)`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1">
          <Button size="sm" variant={mode === "paint" ? "default" : "outline"} onClick={() => setMode("paint")}>
            <Brush /> Brush
          </Button>
          <Button size="sm" variant={mode === "erase" ? "default" : "outline"} onClick={() => setMode("erase")}>
            <Eraser /> Eraser
          </Button>
        </div>
        <Field label="Brush size" className="w-48">
          <Slider value={brush} min={4} max={200} step={2} onChange={setBrush} format={(v) => `${v}px`} />
        </Field>
        <Checkbox checked={feather} onChange={setFeather} label="Feather preview" hint="Preview of the GrowMask + Gaussian feather Engine C applies" />
        <div className="flex gap-1">
          <Button size="icon" variant="outline" onClick={undo} disabled={history.undo === 0} title="Undo (Ctrl+Z)">
            <Undo2 />
          </Button>
          <Button size="icon" variant="outline" onClick={redo} disabled={history.redo === 0} title="Redo (Ctrl+Y)">
            <Redo2 />
          </Button>
          <Button size="icon" variant="outline" onClick={invert} title="Invert mask">
            <FlipHorizontal2 />
          </Button>
          <Button size="icon" variant="outline" onClick={clear} title="Clear mask">
            <Trash />
          </Button>
        </div>
        <Button size="sm" onClick={() => void exportMask()} disabled={!size || exporting}>
          <Download /> {exporting ? "Exporting..." : "Use this mask"}
        </Button>
      </div>
      {imagePath ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2">
          <span className="text-xs font-medium text-muted-foreground">1-Click Auto-Mask Outfit</span>
          {(Object.keys(AUTO_MASK_LABELS) as AutoMaskCategory[]).map((cat) => (
            <Checkbox
              key={cat}
              checked={autoCats.includes(cat)}
              onChange={(on) => setAutoCats((list) => (on ? [...list, cat] : list.filter((x) => x !== cat)))}
              label={AUTO_MASK_LABELS[cat]}
            />
          ))}
          <Button size="sm" variant="outline" onClick={() => void autoMask()} disabled={!size || autoBusy || autoCats.length === 0} title="Finds the ticked garments and paints them onto the mask">
            <Sparkles /> {autoBusy ? "Finding clothes..." : "Auto-mask"}
          </Button>
        </div>
      ) : null}
      <div className="relative w-full max-w-[640px] select-none overflow-hidden rounded-lg border border-border">
        {/* eslint-disable-next-line @next/next/no-img-element -- local data/ file served by our own API, sized to its natural resolution */}
        <img
          src={imageUrl}
          alt="Base stage frame"
          className="block h-auto w-full"
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
            setSize({ w, h });
            undoStack.current = [];
            redoStack.current = [];
            setHistory({ undo: 0, redo: 0 });
          }}
        />
        {size ? (
          <canvas
            ref={canvasRef}
            width={size.w}
            height={size.h}
            className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
            style={{ opacity: 0.55, filter: feather ? "blur(6px)" : undefined }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Paint over the outfit/body region to change. Everything left unpainted (face, room, mirror, lighting) stays pixel-identical.
      </p>
    </div>
  );
}

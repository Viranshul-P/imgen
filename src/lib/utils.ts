import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui class combiner: conditional classes + Tailwind conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function fileUrl(dataRelativePath: string): string {
  return `/api/files/${dataRelativePath.split("/").map(encodeURIComponent).join("/")}`;
}

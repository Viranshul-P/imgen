/** Multi-bucket full-character training: categories, labels and sub-token helpers (client and server safe). */
export const DATASET_BUCKETS = ["face", "body", "chest", "lower"] as const;
export type DatasetBucket = (typeof DATASET_BUCKETS)[number];

export const BUCKET_LABELS: Record<DatasetBucket, string> = {
  face: "Bucket 1: Face & Angles",
  body: "Bucket 2: Full Body & Posture",
  chest: "Bucket 3: Upper Torso / Chest Proportions",
  lower: "Bucket 4: Lower Body / Hip & Framing Details",
};

/** Training cap for one multi-bucket dataset. */
export const MAX_TRAINING_IMAGES = 50;

export type SubTokens = Partial<Record<DatasetBucket, string>>;

const SUB_TOKEN_RE = /^[a-z0-9_]{3,48}$/;

export function isBucket(value: unknown): value is DatasetBucket {
  return typeof value === "string" && (DATASET_BUCKETS as readonly string[]).includes(value);
}

export function parseSubTokens(text: string | null | undefined): SubTokens {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const out: SubTokens = {};
    for (const b of DATASET_BUCKETS) if (typeof raw[b] === "string" && SUB_TOKEN_RE.test(raw[b])) out[b] = raw[b];
    return out;
  } catch {
    return {};
  }
}

/** The sub-token used for a bucket: the character's custom one, else "<trigger>_<bucket>". */
export function subTokenFor(trigger: string, bucket: DatasetBucket, custom: SubTokens): string {
  return custom[bucket] ?? `${trigger}_${bucket}`;
}

/** Returns an error message, or null when the custom sub-tokens are valid. */
export function validateSubTokens(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "subTokens must be an object";
  const seen = new Set<string>();
  for (const [key, v] of Object.entries(value)) {
    if (!isBucket(key)) return `unknown bucket '${key}'`;
    if (v === "" || v === null || v === undefined) continue;
    if (typeof v !== "string" || !SUB_TOKEN_RE.test(v)) return `sub-token for ${key} must be 3-48 characters of a-z, 0-9 or _`;
    if (seen.has(v)) return "each sub-token must be different";
    seen.add(v);
  }
  return null;
}

/** Client-safe constants for the auto-mask feature (the server logic lives in autoMask.ts). */
export const AUTO_MASK_CATEGORIES = ["upper", "skirt", "pants", "dress", "belt", "scarf"] as const;
export type AutoMaskCategory = (typeof AUTO_MASK_CATEGORIES)[number];

export const AUTO_MASK_LABELS: Record<AutoMaskCategory, string> = {
  upper: "Upper-clothes",
  skirt: "Skirt",
  pants: "Pants",
  dress: "Dress",
  belt: "Belt",
  scarf: "Scarf",
};

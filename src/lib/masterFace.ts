/**
 * A character's master face must be an image PersonaForge itself generated for that same fictional
 * character (genesis candidate, render or dataset frame). Uploaded photos are never accepted, so the
 * ReActor master-face swap can never be pointed at a real person's face.
 */
import { prisma } from "./prisma";
import { BadRequestError } from "./types";

export const MASTER_FACE_KINDS = ["raw", "finished", "dataset"] as const;

export const MASTER_FACE_RULE =
  "the master face must be an image generated in PersonaForge for this character (uploaded photos can't be used)";

interface AssetLike {
  kind: string;
  characterId: string | null;
}

export function isGeneratedForCharacter(asset: AssetLike, characterId: string | null | undefined): boolean {
  return Boolean(characterId) && asset.characterId === characterId && (MASTER_FACE_KINDS as readonly string[]).includes(asset.kind);
}

/** Re-checks at plan time that the stored master face path still points at a generated asset of this character. */
export async function assertGeneratedMasterFace(character: { id: string; masterFacePath: string | null }): Promise<string> {
  if (!character.masterFacePath) throw new BadRequestError("this character has no master face yet; pick one in the Character tab first");
  const asset = await prisma.asset.findFirst({
    where: { path: character.masterFacePath, characterId: character.id, kind: { in: [...MASTER_FACE_KINDS] } },
    select: { id: true },
  });
  if (!asset) throw new BadRequestError(MASTER_FACE_RULE);
  return character.masterFacePath;
}

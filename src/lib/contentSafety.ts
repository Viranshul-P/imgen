/**
 * Minor-safety guard for every prompt the studio sends to a model.
 *
 * PersonaForge characters are fictional adults. A prompt that combines nudity/sexual terms with
 * anything that suggests a minor - or that uses "girl"/"boy" with no stated adult age - is
 * rejected before it is queued. Non-sexual prompts are never affected.
 */
import { BadRequestError } from "./types";

const SEXUAL =
  /\b(nude|nudes|naked|nsfw|topless|bottomless|sex|sexy|sexual|porn|porno|pornographic|pussy|vagina|vulva|penis|nipples?|areolas?|breasts?|boobs?|tits|genitals?|erotic|explicit|lingerie|undress(?:ed|ing)?|strip(?:ping|ped)?|orgasm|masturbat\w*|seductive|provocative)\b/i;

const MINOR =
  /\b(child|children|kid|kids|minor|minors|underage|under-age|teen|teens|teenage|teenager|teenagers|preteen|pre-teen|tween|schoolgirl|schoolboy|school girl|school boy|loli|lolita|shota|young[- ]looking|youthful[- ]looking|little girl|little boy|baby|toddler|infant|middle school|high school|elementary school|junior high|childlike|child-like|petite young|barely legal|jailbait)\b/i;

/** Ages 0-17 written as "16 year old", "16-year-old", "16yo", "age 16". */
const MINOR_AGE = /\b(?:([0-9]|1[0-7])\s*(?:-|\s)?\s*(?:years?|yrs?|y\.?o\.?)(?:\s*-?\s*old)?|age[ds]?\s*([0-9]|1[0-7]))\b/i;

/** An explicit adult age (18-99) or adult noun, required when "girl"/"boy" appears in a sexual prompt. */
const ADULT_MARKER = /\b(?:(1[89]|[2-9][0-9])\s*(?:-|\s)?\s*(?:years?|yrs?|y\.?o\.?)|adult|grown|woman|women|man|men|lady|ladies)\b/i;
const GIRL_BOY = /\b(girl|girls|boy|boys|gal)\b/i;

export const MINOR_SAFETY_MESSAGE =
  "Blocked: prompts with nudity or sexual content must clearly describe an adult (for example \"a 25 year old woman\") and can't include anything that suggests a minor.";

/** True when the text is sexual and could depict a minor. */
export function violatesMinorSafety(...texts: (string | null | undefined)[]): boolean {
  const text = texts.filter(Boolean).join(" \n ");
  if (!SEXUAL.test(text)) return false;
  if (MINOR.test(text) || MINOR_AGE.test(text)) return true;
  if (GIRL_BOY.test(text) && !ADULT_MARKER.test(text)) return true;
  return false;
}

export function assertMinorSafe(...texts: (string | null | undefined)[]): void {
  if (violatesMinorSafety(...texts)) throw new BadRequestError(MINOR_SAFETY_MESSAGE);
}

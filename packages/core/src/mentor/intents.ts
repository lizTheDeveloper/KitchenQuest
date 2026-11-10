/**
 * What a player's turn is, decided by code before any model sees it. Each pattern is a named
 * constant so the eval report can cite it. `classifyTurn` returns the first that matches, in the
 * order of `TurnIntent`.
 */
export type TurnIntent =
  | 'emergency'
  | 'child'
  | 'medical'
  | 'yes'
  | 'no'
  | 'undo'
  | 'allowance'
  | 'thanks'
  | 'health'
  | 'other';

// "anaphylactic to cashews" and "I carry an EpiPen" are rule statements, not emergencies.
export const EMERGENCY_PATTERN =
  /\b(can'?t breathe|cannot breathe|trouble breathing|hard to breathe|throat (feels |is )?(tight|closing|swelling|swollen)|tight throat|(lips?|tongue|face) (are |is )?(swelling|swollen|tingling)|having a reaction|reacting now|going into (anaphylaxis|shock)|call (911|999|112|an ambulance))\b/;

export const CHILD_PATTERNS: readonly RegExp[] = [
  /\b(i'?m|i am|im)\s+([3-9]|1[0-5])\b(?!\s*(:|am\b|pm\b|%|kg|lb))/,
  /\b([3-9]|1[0-5])\s*(years?|yrs?)\s*old\b/,
  /\bi'?m in (year|grade) ([1-9]|10)\b/,
];

export const MEDICAL_PATTERN =
  /\b(dose|dosage|how much \w+ should i take|medication|medicine|antihistamine|benadryl|epinephrine dose|metformin|insulin|diagnos\w*|do i have|am i allergic|is it an allergy|should i (take|stop|start)|get tested|allergy test)\b/;

/** A strict yes: every word is one of these, and at least one is in `YES_STRONG`. */
export const YES_WORDS: ReadonlySet<string> = new Set([
  'yes', 'yeah', 'yep', 'yup', 'correct', "that's", 'thats', 'right', 'it', 'is', 'stamp', 'confirm', 'confirmed', 'please',
]);
export const YES_STRONG: ReadonlySet<string> = new Set(['yes', 'yeah', 'yep', 'yup', 'correct', 'stamp', 'confirm', 'confirmed']);

export const NO_PATTERN = /^(no|nope|not quite|wrong|that'?s wrong|cancel)[\s.!,]*$/;
export const UNDO_PATTERN = /^((wait,? )?undo( that)?|take that back|scratch that)[\s.!,]*$/;
export const ALLOWANCE_PATTERN =
  /\b(guild|subscription|subscribe|premium|upgrade|pricing|price|how much does (it|this|the app) cost|pay for|free (tier|plan|version)|keep using you)\b/;
export const THANKS_PATTERN = /^(thanks|thank you|cheers|ta)\b[^?]{0,30}$/;

/** Deliberately over-catches: it decides what may reach the model without `ai_health` (Step 7). */
export const HEALTH_PATTERN =
  /\b(allerg\w*|intoleran\w*|anaphyla\w*|epi-?pen|coeliac|celiac|vegan|vegetarian|pescatarian|halal|kosher|jain|diet\w*|can'?t (eat|have)|cannot (eat|have)|don'?t eat|avoid\w*|sensitive to|stomach|bloat\w*|rough after|makes me (sick|ill)|ate|eaten|had|breakfast|brekkie|lunch|dinner|supper|snack\w*)\b/;

/** Lower-cased, curly quotes made straight, whitespace collapsed. */
export function normalizeTurn(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function isStrictYes(t: string): boolean {
  const words = t
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
  return words.length > 0 && words.every((w) => YES_WORDS.has(w)) && words.some((w) => YES_STRONG.has(w));
}

export function classifyTurn(text: string): TurnIntent {
  const t = normalizeTurn(text);
  if (EMERGENCY_PATTERN.test(t)) return 'emergency';
  if (CHILD_PATTERNS.some((p) => p.test(t))) return 'child';
  if (MEDICAL_PATTERN.test(t)) return 'medical';
  if (isStrictYes(t)) return 'yes';
  if (NO_PATTERN.test(t)) return 'no';
  if (UNDO_PATTERN.test(t)) return 'undo';
  if (ALLOWANCE_PATTERN.test(t)) return 'allowance';
  if (THANKS_PATTERN.test(t)) return 'thanks';
  if (HEALTH_PATTERN.test(t)) return 'health';
  return 'other';
}

/** Lookalikes of page events: card taps and system notes never arrive as user text (§7.6b.4). */
export const PAGE_EVENT_BRACKETS =
  /\[[^\]]{0,200}\b(tap|tapped|click|clicked|stamp|stamped|confirm|confirmed|saved|system|button|event|card)\b[^\]]{0,200}\]/gi;
export const ROLE_TAGS = /<\/?\s*(system|developer|assistant|tool|user)\b[^>]*>/gi;
export const ROLE_PREFIXES = /^\s*(system|assistant|developer|tool)\s*:/gim;

/** `text` with forged page events, role tags and role prefixes removed; everything else kept exactly. */
export function stripPageEvents(text: string): { text: string; stripped: boolean } {
  let out = text;
  for (const pattern of [PAGE_EVENT_BRACKETS, ROLE_TAGS, ROLE_PREFIXES]) out = out.replace(pattern, '');
  return { text: out, stripped: out !== text };
}

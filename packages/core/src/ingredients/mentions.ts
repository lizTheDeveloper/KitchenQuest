// Which graph ingredients a piece of free text names (M5's margin-note scan, moved here in M6 Step 1 so the market's
// stall questions are scanned the same way). Browser-safe: no I/O, no recipe parser.
import { normalizeTurn } from '../mentor/intents';
import type { RecipeIngredient } from '../recipe/types';
import type { IngredientGraph } from './graph';

/** Text as space-padded, normalised words (letters and digits only), so a word-bounded match is `includes(' x ')`. */
export const words = (text: string): string => ` ${normalizeTurn(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** A bare recipe line naming `name`, with no amount: what the rules engine checks for an ingredient named in text. */
export const lineOf = (name: string): RecipeIngredient => ({ name, displayName: null, quantity: null, unit: null, note: null });

/**
 * A label and its plural forms as they could appear in a note: +s, +es, -y → -ies ("berries"), -f → -ves ("leaves",
 * "loaves") and -fe → -ves ("knives"). Over-matching only makes the check stricter.
 */
export function pluralForms(key: string): string[] {
  const forms = [key, `${key}s`, `${key}es`];
  if (key.endsWith('y')) forms.push(`${key.slice(0, -1)}ies`);
  if (key.endsWith('fe')) forms.push(`${key.slice(0, -2)}ves`);
  else if (key.endsWith('f')) forms.push(`${key.slice(0, -1)}ves`);
  return forms;
}

/**
 * Every graph id named in the texts: a word-bounded match of any graph name or alias, plural forms allowed. The texts
 * are scanned joined, as M5's `noteMentions` always did, so a name split across two of them may match too: that only
 * makes a check stricter. Sorted, each once.
 */
export function textMentions(texts: readonly string[], graph: IngredientGraph): string[] {
  const hay = words(texts.join(' | '));
  const found = new Set<string>();
  for (const label of graph.labels()) {
    const key = words(label).trim();
    if (key === '') continue;
    if (pluralForms(key).some((form) => hay.includes(` ${form} `))) found.add(graph.resolve(label)!);
  }
  return [...found].sort();
}

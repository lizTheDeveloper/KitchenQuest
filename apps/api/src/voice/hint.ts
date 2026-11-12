// M7 C-13: the STT vocabulary hint, the words the player is likely to say, so the recogniser favours them. It goes to
// the self-hosted voice service only (never a processor, never logged), and never carries a user id (C-15).
import { ALLERGEN_ROOTS, HINT_MAX_WORDS, planWeekStart } from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import type { Catalog } from '../catalog.js';
import { hasConsent } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { profiles } from '../db/schema.js';
import { loadPantry } from '../pantry/store.js';
import { loadRules } from '../rules/store.js';
import type { Db } from '../types.js';
import { loadPlan, loadRunForPlan } from '../week/store.js';

/** As core's upstream parser: one hint entry is at most this long. */
const HINT_ENTRY_MAX = 64;

/** A hint entry: lower-cased letters, digits, spaces, hyphens and apostrophes, at most HINT_ENTRY_MAX; '' when none. */
function clean(name: string): string {
  const s = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > HINT_ENTRY_MAX ? '' : s;
}

const wordsIn = (entry: string) => entry.split(' ').length;

/**
 * The hint for the player's next utterance, in this order, each entry once, at most HINT_MAX_WORDS words in all:
 * 1. with `health_data` in force only: the names of their rule targets (C-13: health data);
 * 2. always: the graph's major allergens (ALLERGEN_ROOTS), so a misheard allergen is the one least likely;
 * 3. with `health_data` only: their pantry item names, then the rows of this plan week's market run.
 * `today` is the player's local date (the run's plan week); it defaults to the UTC date of `now`.
 */
export async function sttHint(db: Db, keyring: Keyring, catalog: Catalog, userId: string, now: Date, today: string = now.toISOString().slice(0, 10)): Promise<string[]> {
  const { graph } = catalog;
  const name = (id: string) => (graph.has(id) ? graph.get(id).name : id.replace(/_/g, ' '));
  const health = await hasConsent(db, userId, 'health_data', now);
  const ruleNames: string[] = [];
  const rest: string[] = [];
  if (health) {
    for (const rule of await loadRules(db, keyring, userId)) for (const id of rule.target.ids) ruleNames.push(name(id));
    for (const item of await loadPantry(db, keyring, userId)) rest.push(item.name);
    const marketDays = (await db.select({ marketDays: profiles.marketDays }).from(profiles).where(eq(profiles.userId, userId))).at(0)?.marketDays ?? [];
    const plan = await loadPlan(db, keyring, userId, planWeekStart(today, marketDays));
    const run = plan === null ? null : await loadRunForPlan(db, keyring, userId, plan.id);
    if (run !== null && run.doneAt === null) for (const row of run.items) rest.push(row.name);
  }
  const allergens = [...ALLERGEN_ROOTS].filter((id) => graph.has(id)).map(name);
  const out: string[] = [];
  const seen = new Set<string>();
  let words = 0;
  for (const raw of [...ruleNames, ...allergens, ...rest]) {
    const entry = clean(raw);
    if (entry === '' || seen.has(entry)) continue;
    if (words + wordsIn(entry) > HINT_MAX_WORDS) continue;
    seen.add(entry);
    out.push(entry);
    words += wordsIn(entry);
  }
  return out;
}

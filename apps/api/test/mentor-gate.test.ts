// Task 9 fix round 1 (review flakes): the N6/N7 code-card gate, tested directly on the functions /mentor/turn calls,
// with no HTTP and no database. mentor-plan.test.ts keeps one or two /mentor/turn probes per gate as integration smoke.
// The turn (apps/api/src/mentor/turn.ts):
//   - stage 4: a health text (core `isHealthText`, via ./health) with no ai_health → `needs_ai_health`, no model, no card;
//   - stage 5b: code's own plan card only from the closed grammar (`planIntent`) on a turn that isn't health;
//   - after the model: code cards only when `codeCardHealth` is false, from `planWordsIn`, `reminderSlots` and
//     `marketDayStated` (each consumes the whole message, or gives nothing, N6).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { codeCardHealth, marketDayStated, parseRecipe, planIntent, planWordsIn, playerOwnWords, reminderSlots, stripPageEvents } from '@kitchenquest/core';
import { describe, expect, test } from 'vitest';
import { defaultCatalog } from '../src/catalog.js';
import { isHealthText } from '../src/mentor/health.js';
import { RECIPES_DIR } from '../src/recipes/sync.js';
import { N6_TEXTS, N7_TEXTS } from './helpers/gate-texts.js';

const catalog = defaultCatalog();
const graph = catalog.graph;
const cookFiles = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? cookFiles(f) : f.endsWith('.cook') ? [f] : []; });
const dishes = cookFiles(RECIPES_DIR).map((f) => ({ slug: f.slice(RECIPES_DIR.length).replace(/\.cook$/, ''), title: parseRecipe(readFileSync(f, 'utf8')).meta.title }));

/** Whether any code card can come of this text on a turn whose model makes no call (both players: the code paths alone). */
function codeCard(text: string): boolean {
  if (!isHealthText(text, catalog) && planIntent(text, dishes) !== null) return true;
  const own = stripPageEvents(playerOwnWords(text)).text;
  if (codeCardHealth(own, graph, catalog.ruleTerms)) return false;
  return planWordsIn(text, dishes, graph) !== null || reminderSlots(text, dishes, graph).length > 0 || marketDayStated(text, dishes, graph) !== null;
}

describe('the N6/N7 code-card gate, directly (fix round 1)', () => {
  test('the canon dishes are read', () => {
    expect(dishes.map((d) => d.slug).sort()).toContain('india/kerala/parippu');
  });

  test('N6: a clause outside the closed grammar anywhere in the message → no code card', () => {
    expect(N6_TEXTS.filter(codeCard)).toEqual([]);
  });

  test('N6: closed clauses with a neutral clause still make their cards (the gate is not just "never")', () => {
    for (const t of ['remind me about dinner at 6pm, thanks', 'ok, my market day is saturday', "put parippu on monday and my market's saturday, thanks"]) expect(codeCard(t), t).toBe(true);
  });

  test('N7: every health text is health (needs_ai_health without ai_health) and makes no code card with it', () => {
    expect(N7_TEXTS.filter((t) => !isHealthText(t, catalog))).toEqual([]);
    expect(N7_TEXTS.filter(codeCard)).toEqual([]);
  });
});

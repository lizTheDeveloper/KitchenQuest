// M7 Step 1 — THE GATE (§12, D2, Ruling 4): every entry of the mishearing set, no tolerance, holdout included. A
// failing holdout row is reported to the controller, never tuned on.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import ingredients from '../../../data/ingredients.json';
import ruleTerms from '../../../data/rule-terms.json';
import { HEALTH_PATTERN, heardCheck, IngredientGraph, KNOWN_CONFUSIONS, normalizeTurn, spell, type RuleTerm } from '../src/index';

interface Entry { group: string; said: string; saidId?: string; heard: string; heardWord: string; holdout?: boolean; source: string }
const GROUPS = ['real_food_swap', 'non_word', 'split', 'spelled'];
const load = (path: string) => parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { entries: Entry[]; plain: string[] };
const set = load('./fixtures/voice-mishearing.yaml');
const graph = IngredientGraph.fromData(ingredients);
const terms = ruleTerms as RuleTerm[];

describe('the mishearing gate', () => {
  for (const e of set.entries)
    test(`${e.group}${e.holdout ? ' (holdout)' : ''}: ${e.said} → ${e.heard}`, () => {
      const chk = heardCheck(e.heard, graph, terms);
      expect(chk).not.toBeNull();
      const t = chk!.terms.find((x) => x.heard === e.heardWord)!;
      expect(t, JSON.stringify(chk!.terms.map((x) => x.heard))).toBeDefined();
      expect(t.spelled).toBe(spell(e.heardWord));
      expect(chk!.speakSpelling).toBe(true);
      if (e.saidId) expect([t.id, ...t.alternatives.map((a) => a.id)]).toContain(e.saidId);
    });

  test('no `plain` utterance gets a check', () => {
    expect(set.plain.length).toBeGreaterThanOrEqual(20);
    for (const p of set.plain) expect(heardCheck(p, graph, terms), p).toBeNull();
  });

  test('at least 30% of entries are holdout: true, spread over every group', () => {
    expect(set.entries.length).toBeGreaterThanOrEqual(40);
    expect(set.entries.filter((e) => e.holdout).length / set.entries.length).toBeGreaterThanOrEqual(0.3);
    expect([...new Set(set.entries.map((e) => e.group))].sort()).toEqual([...GROUPS].sort());
    for (const g of GROUPS) {
      const rows = set.entries.filter((e) => e.group === g);
      expect(rows.some((e) => e.holdout), g).toBe(true);
      expect(rows.some((e) => !e.holdout), g).toBe(true);
    }
  });

  test('every entry is well formed: health wording, a graph saidId, the heard word in the heard text, a known source', () => {
    for (const e of set.entries) {
      expect(HEALTH_PATTERN.test(normalizeTurn(e.heard)), e.heard).toBe(true);
      if (e.saidId) expect(graph.has(e.saidId), e.saidId).toBe(true);
      expect(` ${normalizeTurn(e.heard).replace(/[^\p{L}\p{N}]+/gu, ' ')} `, e.heard).toContain(` ${e.heardWord} `);
      expect(['spike §2', 'synthetic'], e.source).toContain(e.source);
    }
    expect(set.entries.some((e) => e.source === 'spike §2')).toBe(true);
  });

  // D2. Lives here rather than in src/voice/phonetic.test.ts: it reads the fixture file, and src/ is type-checked
  // without Node's types.
  test("every KNOWN_CONFUSIONS entry has a spike citation or covers ≥ 2 non-holdout fixture rows, and none equals a holdout row's (heardWord, saidId)", () => {
    expect(KNOWN_CONFUSIONS.length).toBeGreaterThan(0);
    for (const c of KNOWN_CONFUSIONS) {
      const rows = set.entries.filter((e) => e.heardWord === c.heard && e.saidId === c.id);
      if (c.cite === null) expect(rows.filter((e) => !e.holdout).length, `${c.heard}→${c.id}`).toBeGreaterThanOrEqual(2);
      else expect(c.cite).toMatch(/^spike §\d+$/);
      expect(rows.filter((e) => e.holdout), `${c.heard}→${c.id}`).toEqual([]);
    }
  });
});

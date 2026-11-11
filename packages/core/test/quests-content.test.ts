// The shipped quests, recipes and techniques: the copies src/ tests use equal the files, and the shipped quests pass
// validateQuests (with Step 4's planned recognize steps too) against the real catalogue.
import { readFileSync, readdirSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { validateQuests, type Quest, type QuestStep } from '../src/index';
import { catalogueOf, COOKS, graph, STALLS } from '../src/quests/fixtures';
import { SHIPPED_QUESTS, SHIPPED_RECIPE_SOURCES, SHIPPED_TECHNIQUES } from '../src/quests/shipped.fixture';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');
const shipped = ['leela', 'marisol', 'haruka'].map((c) => (parse(read(`content/cooks/${c}.yaml`)) as { quest: Quest }).quest);

describe('shipped quest content', () => {
  test('the src/ test copies equal the shipped files', () => {
    expect(SHIPPED_QUESTS).toEqual(shipped);
    expect(SHIPPED_TECHNIQUES).toEqual((parse(read('data/techniques.yaml')) as { techniques: unknown }).techniques);
    const files = (readdirSync(`${ROOT}recipes`, { recursive: true }) as string[]).filter((f) => f.endsWith('.cook')).map((f) => f.split(sep).join('/'));
    expect(Object.fromEntries(files.map((f) => [f.replace(/\.cook$/, ''), read(`recipes/${f}`)]))).toEqual(SHIPPED_RECIPE_SOURCES);
  });

  test('every cook file has its id in the cook set and every stall file in the stall set', () => {
    expect(new Set(readdirSync(`${ROOT}content/cooks`).map((f) => f.replace(/\.yaml$/, '')))).toEqual(COOKS);
    expect(new Set(readdirSync(`${ROOT}content/market`).map((f) => f.replace(/\.yaml$/, '')))).toEqual(STALLS);
  });

  test('the shipped quests pass validateQuests, and so do Step 4\'s planned recognize steps (C2)', () => {
    expect(validateQuests(shipped, catalogueOf(shipped), COOKS, STALLS, graph)).toEqual([]);
    const technique: Record<string, string> = { leela: 'patience', marisol: 'tempering', haruka: 'patience' };
    const withRecognize = shipped.map((q): Quest => {
      const rec: QuestStep = { type: 'recognize', technique: technique[q.cook], lines: [], otherwise: [] };
      return { ...q, steps: [...q.steps.slice(0, -1), rec, ...q.steps.slice(-1)] };
    });
    expect(validateQuests(withRecognize, catalogueOf(withRecognize), COOKS, STALLS, graph)).toEqual([]);
  });
});

// The shipped quests, frames, recipes and techniques: the copies src/ tests use equal the files, the shipped quests
// pass validateQuests (recognize steps included) and the shipped frames validateFrames, against the real catalogue.
import { readFileSync, readdirSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { validateFrames, validateQuests, type Frame, type Quest } from '../src/index';
import { catalogueOf, COOKS, graph, STALLS } from '../src/quests/fixtures';
import { SHIPPED_FRAMES, SHIPPED_QUESTS, SHIPPED_RECIPE_SOURCES, SHIPPED_TECHNIQUES } from '../src/quests/shipped.fixture';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');
const shipped = ['leela', 'marisol', 'haruka'].map((c) => (parse(read(`content/cooks/${c}.yaml`)) as { quest: Quest }).quest);
const frames = readdirSync(`${ROOT}content/frames`).filter((f) => f.endsWith('.yaml')).sort().map((f) => parse(read(`content/frames/${f}`)) as Frame);

describe('shipped quest content', () => {
  test('the src/ test copies equal the shipped files', () => {
    expect(SHIPPED_QUESTS).toEqual(shipped);
    expect(SHIPPED_FRAMES).toEqual(frames);
    expect(SHIPPED_TECHNIQUES).toEqual((parse(read('data/techniques.yaml')) as { techniques: unknown }).techniques);
    const files = (readdirSync(`${ROOT}recipes`, { recursive: true }) as string[]).filter((f) => f.endsWith('.cook')).map((f) => f.split(sep).join('/'));
    expect(Object.fromEntries(files.map((f) => [f.replace(/\.cook$/, ''), read(`recipes/${f}`)]))).toEqual(SHIPPED_RECIPE_SOURCES);
  });

  test('every cook file has its id in the cook set and every stall file in the stall set', () => {
    expect(new Set(readdirSync(`${ROOT}content/cooks`).map((f) => f.replace(/\.yaml$/, '')))).toEqual(COOKS);
    expect(new Set(readdirSync(`${ROOT}content/market`).map((f) => f.replace(/\.yaml$/, '')))).toEqual(STALLS);
  });

  test('the shipped quests pass validateQuests, recognize steps included (C2: Leela patience, Marisol tempering, Haruka patience)', () => {
    expect(validateQuests(shipped, catalogueOf(shipped), COOKS, STALLS, graph)).toEqual([]);
    const recognized = Object.fromEntries(shipped.map((q) => [q.cook, q.steps.filter((s) => s.type === 'recognize').map((s) => s.type === 'recognize' && s.technique)]));
    expect(recognized).toEqual({ leela: ['patience'], marisol: ['tempering'], haruka: ['patience'] });
  });

  test('the shipped frames pass validateFrames: drafts, credited to the editors, slots naming graph ids only (C12, Ruling 13)', () => {
    expect(frames.map((f) => f.id)).toEqual(['fried-rice', 'green-sauce', 'quick-tomato-sauce']);
    expect(validateFrames(frames, graph, new Set(SHIPPED_TECHNIQUES.map((t) => t.id)))).toEqual([]);
    for (const f of frames) {
      expect(f.status, f.id).toBe('draft');
      expect(f.credit, f.id).toBe('Drafted by Kitchen Quest editors');
    }
    expect(Object.fromEntries(frames.map((f) => [f.id, f.technique]))).toEqual({ 'fried-rice': 'stir-fry', 'green-sauce': 'emulsion', 'quick-tomato-sauce': 'quick-sauce' });
    const rescuer = (id: string) => frames.filter((f) => f.rescues.includes(id)).map((f) => f.id);
    expect([rescuer('herb'), rescuer('tomato'), rescuer('cooked_rice')]).toEqual([['green-sauce'], ['quick-tomato-sauce'], ['fried-rice']]);
  });

  test('every food-safety step of the seed frames is flagged # REVIEW: (cold rice, raw egg)', () => {
    const text = read('content/frames/fried-rice.yaml');
    for (const needle of ['{rice}, break up', '{egg}']) {
      const lines = text.split('\n');
      const at = lines.findIndex((l) => l.includes(needle));
      expect(at, needle).toBeGreaterThan(0);
      expect(lines[at - 1], needle).toMatch(/# REVIEW: food safety/);
    }
    expect(text).toMatch(/# REVIEW: food safety\. Cooked rice/);
  });
});

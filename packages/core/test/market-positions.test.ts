// Ruling 7, pinned on the shipped stall banks: the correct option is written first in most questions, so the fixed
// per-question option order must spread it. Across each stall's bank, no display position holds more than half of the
// correct answers. (Step 5 repeats this on the compiled content; this reads the YAML as written.)
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { optionOrder } from '../src/market/round';

type Q = { id: string; options: { correct: boolean }[] };
const read = (f: string) => parse(readFileSync(new URL(`../../../content/market/${f}.yaml`, import.meta.url), 'utf8')) as {
  questions: Q[];
  variants?: { protein_counter?: { questions: Q[] } };
  seasonal?: Record<string, Record<string, unknown>>;
};

/** Each bank a player can meet at a stall: the base stall (with every seasonal question), and the Protein Counter. */
function banks(): { name: string; qs: Q[] }[] {
  return ['bram', 'wen', 'okafor-sato', 'spice'].flatMap((f) => {
    const d = read(f);
    const seasonal = Object.values(d.seasonal ?? {}).flatMap((months) => Object.values(months).filter((l): l is Q[] => Array.isArray(l)).flat());
    const out = [{ name: `${f}`, qs: [...d.questions, ...seasonal] }];
    if (d.variants?.protein_counter) out.push({ name: `${f} protein_counter`, qs: d.variants.protein_counter.questions });
    return out;
  });
}

test('over a stall bank of 15+ questions whose correct option is always file index 0, no display position holds more than half', () => {
  const all = banks();
  expect(all.map((b) => b.name)).toEqual(['bram', 'bram protein_counter', 'wen', 'okafor-sato', 'spice']);
  // The premise: the shipped banks are big, and their correct option is (almost) always written first.
  for (const b of all) expect(b.qs.length, b.name).toBeGreaterThanOrEqual(14);
  expect(all.filter((b) => b.name !== 'wen').every((b) => b.qs.every((q) => q.options[0].correct))).toBe(true);
  for (const b of all) {
    const at = [0, 0, 0, 0];
    for (const q of b.qs) at[optionOrder(q.id, q.options.length).indexOf(q.options.findIndex((o) => o.correct))]++;
    expect(Math.max(...at), `${b.name}: ${at.join(',')}`).toBeLessThanOrEqual(b.qs.length / 2);
  }
});

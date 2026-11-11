import { describe, expect, test } from 'vitest';
import type { ParsedRecipe } from '../recipe/types';
import { stepPlainText } from '../recipe/steps';
import { canon, dish, graph, PEANUT, subs } from '../week/fixtures';
import { applyNotes, checkWithNotes, MAX_NOTE_OPS, NOTE_TEXT_MAX, parseMarginNote, validateNote, type MarginNote, type NoteOp } from './margin-notes';

const DAY = '2026-11-11';
const PARIPPU = 'india/kerala/parippu';
const parippu = canon.get(PARIPPU)!;
const lentilSoup = dish('leela', ['lentils', 'salt', 'onion']);
const note = (ops: NoteOp[], recipe = PARIPPU): MarginNote => ({ recipe, ops, text: null, at: DAY });

/** Deep-freeze a value, so any mutation throws. */
function frozen<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const k of Object.keys(v)) frozen((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

describe('parseMarginNote', () => {
  test('"added lime, used chickpeas instead of lentils, less salt" → add lime, swap lentils→chickpeas, rest "less salt"', () => {
    expect(parseMarginNote('added lime, used chickpeas instead of lentils, less salt', lentilSoup, graph)).toEqual({
      ops: [
        { op: 'add', name: 'lime' },
        { op: 'swap', from: 'lentils', to: 'chickpeas' },
      ],
      rest: 'less salt',
    });
  });

  test('other phrasings: swapped X for Y, no / left out, "and" lists, amounts dropped; a removal names the recipe line', () => {
    expect(parseMarginNote('Swapped the shallots for leeks; no pappadam. I added a squeeze of lime and some coriander!', parippu, graph)).toEqual({
      ops: [
        { op: 'swap', from: 'shallots', to: 'leeks' },
        { op: 'remove', name: 'pappadam' },
        { op: 'add', name: 'lime' },
        { op: 'add', name: 'coriander' },
      ],
      rest: null,
    });
    // "moong dal" resolves to the recipe's "split moong dal" line, so applyNotes finds it.
    expect(parseMarginNote('left out the moong dal', parippu, graph).ops).toEqual([{ op: 'remove', name: 'split moong dal' }]);
  });

  test('nothing readable → only rest, capped at NOTE_TEXT_MAX; at most MAX_NOTE_OPS ops', () => {
    expect(parseMarginNote('lovely on a cold night', parippu, graph)).toEqual({ ops: [], rest: 'lovely on a cold night' });
    expect(parseMarginNote('', parippu, graph)).toEqual({ ops: [], rest: null });
    expect([...(parseMarginNote('x'.repeat(400), parippu, graph).rest ?? '')]).toHaveLength(NOTE_TEXT_MAX);
    const many = Array.from({ length: 15 }, (_, i) => `added thing${i}`).join(', ');
    const r = parseMarginNote(many, parippu, graph);
    expect(r.ops).toHaveLength(MAX_NOTE_OPS);
    expect(r.rest).toBe('added thing12, added thing13, added thing14');
  });
});

describe('applyNotes and checkWithNotes', () => {
  test('parseMarginNote + checkWithNotes: "used peanut butter" on a peanut-rule player → ⛔ with the finding', () => {
    const { ops } = parseMarginNote('used peanut butter', parippu, graph);
    expect(ops).toEqual([{ op: 'add', name: 'peanut butter' }]);
    const r = checkWithNotes(parippu, [note(ops)], [PEANUT], graph, subs, DAY);
    expect(r.status).toBe('blocked');
    expect(r.findings).toContainEqual(expect.objectContaining({ ingredient: 'peanut butter', ingredientId: 'peanut_butter', status: 'blocked', ruleId: 'r-peanut' }));
    expect(r.severe).toBe(true);
  });

  test('a swap is re-checked: "used peanut butter instead of coconut" is ⛔; a swap of a line the recipe lacks still adds what was used', () => {
    const swap = checkWithNotes(lentilSoup, [note([{ op: 'swap', from: 'onion', to: 'peanut butter' }])], [PEANUT], graph, subs, DAY);
    expect(swap.status).toBe('blocked');
    const missing = applyNotes(lentilSoup, [note([{ op: 'swap', from: 'coconut', to: 'peanut butter' }])]);
    expect(missing.ingredients.map((i) => i.name)).toEqual(['lentils', 'salt', 'onion', 'peanut butter']);
    expect(checkWithNotes(lentilSoup, [note([{ op: 'swap', from: 'coconut', to: 'peanut butter' }])], [PEANUT], graph, subs, DAY).status).toBe('blocked');
    // An unresolved addition is ❓, never ✅.
    expect(checkWithNotes(lentilSoup, [note([{ op: 'add', name: 'mystery paste' }])], [], graph, subs, DAY).status).toBe('unverified');
  });

  test('applyNotes never mutates the canon recipe; validateNote rejects sacred recipes', () => {
    const before = JSON.stringify(parippu);
    const locked = frozen(structuredCloneLike(parippu));
    const notes = [note([{ op: 'add', name: 'lime' }, { op: 'remove', name: 'shallots' }, { op: 'swap', from: 'ghee', to: 'coconut oil' }])];
    const out = applyNotes(locked, notes);
    expect(JSON.stringify(locked)).toBe(before);
    expect(out).not.toBe(locked);
    expect(out.ingredients.map((i) => i.name)).not.toContain('shallots');
    expect(out.ingredients.map((i) => i.name)).toContain('lime');
    expect(out.ingredients.find((i) => i.name === 'coconut oil' && i.quantity === 1 && i.unit === 'tsp')).toBeDefined();
    // The step that named the removed shallots keeps the recipe's words for them; the rest still point at their lines.
    const text = out.steps.map((s) => stepPlainText(out, s)).join(' ');
    expect(text).toContain('Add shallots, thinly sliced');
    expect(text).toContain('a spoon of coconut oil');
    expect(applyNotes(parippu, [])).toEqual(parippu);
    // A removal of a missing name is a no-op.
    expect(applyNotes(parippu, [note([{ op: 'remove', name: 'saffron' }])]).ingredients).toEqual(parippu.ingredients);

    const sacred: ReadonlyMap<string, ParsedRecipe> = new Map([[PARIPPU, parippu], ['test/sacred', dish('leela', ['salt'], { sacred: true })]]);
    expect(validateNote(note([{ op: 'add', name: 'lime' }], 'test/sacred'), sacred)).toEqual(['note: sacred recipes take no margin notes']);
  });
});

/** A plain-data deep copy (the recipe is JSON-safe). */
function structuredCloneLike<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('validateNote', () => {
  const recipes: ReadonlyMap<string, ParsedRecipe> = new Map([[PARIPPU, parippu]]);
  test('accepts a well-formed note, text-only included', () => {
    expect(validateNote(note([{ op: 'swap', from: 'ghee', to: 'coconut oil' }]), recipes)).toEqual([]);
    expect(validateNote({ recipe: PARIPPU, ops: [], text: 'less salt', at: '2026-11-11T19:30:00Z' }, recipes)).toEqual([]);
  });

  test('≤ 12 ops; names 1–80; text ≤ 280; known recipe; a date; no extra fields; never throws', () => {
    const many = Array.from({ length: 13 }, (): NoteOp => ({ op: 'add', name: 'lime' }));
    expect(validateNote(note(many), recipes)).toEqual(['note: more than 12 ops']);
    expect(validateNote(note([{ op: 'add', name: '' }]), recipes)).toEqual(['note: op 0: name is not 1–80 characters']);
    expect(validateNote(note([{ op: 'add', name: 'x'.repeat(81) }]), recipes)).toEqual(['note: op 0: name is not 1–80 characters']);
    expect(validateNote(note([{ op: 'swap', from: 'a', to: 3 } as never]), recipes)).toEqual(['note: op 0: to is not 1–80 characters']);
    expect(validateNote(note([{ op: 'paint', name: 'x' } as never]), recipes)).toEqual(['note: op 0: op is not add, swap or remove']);
    expect(validateNote(note([{ op: 'add', name: 'x', who: 'Sam' } as never]), recipes)).toEqual(['note: op 0: unknown field "who"']);
    expect(validateNote({ ...note([]), text: 'y'.repeat(281) }, recipes)).toContain('note: text is not null or at most 280 characters');
    expect(validateNote(note([]), recipes)).toEqual(['note: empty']);
    expect(validateNote(note([{ op: 'add', name: 'x' }], 'nope'), recipes)).toEqual(['note: unknown recipe']);
    expect(validateNote({ ...note([{ op: 'add', name: 'x' }]), at: 'yesterday' }, recipes)).toEqual(['note: at is not a date']);
    expect(validateNote({ ...note([{ op: 'add', name: 'x' }]), photo: 'x' }, recipes)).toEqual(['note: unknown field "photo"']);
    for (const junk of [null, 1, 'n', [], { ops: 'x' }, { ops: [null] }]) expect(() => validateNote(junk, recipes)).not.toThrow();
  });
});

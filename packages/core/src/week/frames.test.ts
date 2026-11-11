import { describe, expect, test } from 'vitest';
import type { PantryItem } from '../mentor/cards';
import { alternativesOn } from '../quests/alternatives';
import { SHIPPED_TECHNIQUES } from '../quests/shipped.fixture';
import { stepPlainText } from '../recipe/steps';
import type { Rule } from '../rules/types';
import { avoid, canon, dish, FRAMES, graph, PEANUT, subs } from './fixtures';
import { fillFrame, frameOptions, validateFrames, type Frame } from './frames';

const TODAY = '2026-11-11';
const ctx = (rules: Rule[] = []) => ({ rules, graph, subs, today: TODAY });
const have = (name: string, extra: Partial<PantryItem> = {}): PantryItem => ({ name, ingredientId: graph.resolve(name), ...extra });
const [friedRice, greenSauce, tomatoSauce] = FRAMES;
const TECHNIQUES = new Set(SHIPPED_TECHNIQUES.map((t) => t.id));

describe('fillFrame', () => {
  test('fillFrame: never picks a blocked candidate; unresolved pantry name not auto-picked; picked → frame ❓; empty required slot reported', () => {
    // Blocked: peanut is a kind of nut, but the player avoids peanut; cashew fits and passes.
    const sauce = fillFrame(greenSauce, [have('peanut'), have('cashew'), have('coriander'), have('lime'), have('sunflower oil')], ctx([PEANUT]));
    expect(sauce.fills.nut).toEqual({ name: 'cashew', ingredientId: 'cashew' });
    expect(sauce.check.status).toBe('ok');
    expect(sauce.emptyRequired).toEqual([]);
    // Even when the player picks it, a blocked filler is never used.
    const picked = fillFrame(greenSauce, [have('peanut'), have('coriander'), have('lime'), have('sunflower oil')], ctx([PEANUT]), { nut: 'peanut' });
    expect(picked.fills.nut).toBeNull();
    expect(picked.recipe.ingredients.map((i) => i.name)).not.toContain('peanut');
    expect(picked.check.status).toBe('ok');

    // Unresolved: "jasmine-ish rice" is never chosen for the player; the required rice slot stays empty and says so.
    const pantry = [have('jasmine-ish rice'), have('sunflower oil')];
    const empty = fillFrame(friedRice, pantry, ctx());
    expect(empty.fills.rice).toBeNull();
    expect(empty.emptyRequired).toEqual(['rice']);
    expect(empty.check.status).toBe('unverified');
    expect(empty.check.findings).toContainEqual({ ingredient: 'rice', ingredientId: null, kind: 'unresolved', status: 'unverified' });
    // The player picks it: it fills the slot, and the frame is ❓ (the engine still can't verify it).
    const mine = fillFrame(friedRice, pantry, ctx(), { rice: 'jasmine-ish rice' });
    expect(mine.fills.rice).toEqual({ name: 'jasmine-ish rice', ingredientId: null });
    expect(mine.emptyRequired).toEqual([]);
    expect(mine.check.status).toBe('unverified');
  });

  test('a label-dependent filler (❓ under a rule) is never auto-picked; a ✅ one is preferred; the player may pick the ❓ one', () => {
    const pantry = [have('soy sauce'), have('cold rice'), have('coconut oil')];
    const auto = fillFrame(friedRice, pantry, ctx([avoid('sesame')]));
    expect(auto.fills.sauce).toBeNull();
    expect(auto.check.status).toBe('ok');
    const picked = fillFrame(friedRice, pantry, ctx([avoid('sesame')]), { sauce: 'soy sauce' });
    expect(picked.fills.sauce).toEqual({ name: 'soy sauce', ingredientId: 'soy_sauce' });
    expect(picked.check.status).toBe('unverified');
  });

  test('a swap filler is chosen after the ✅ ones and the dish carries the labelled swap (subs reach the check)', () => {
    const swapOnly = fillFrame(tomatoSauce, [have('tomato'), have('coconut oil')], ctx([avoid('coconut')]));
    expect(swapOnly.fills.oil).toEqual({ name: 'coconut oil', ingredientId: 'coconut_oil' });
    expect(swapOnly.check.status).toBe('swap');
    expect(swapOnly.check.findings[0].swap).toMatchObject({ toId: 'neutral_oil' });
    const both = fillFrame(tomatoSauce, [have('coconut oil'), have('tomato'), have('sunflower oil')], ctx([avoid('coconut')]));
    expect(both.fills.oil).toEqual({ name: 'sunflower oil', ingredientId: 'neutral_oil' });
    expect(both.check.status).toBe('ok');
  });

  test('fills: kinds of an accepted id fit (coriander for herb); earliest bought first; one item per slot; optional empty slots are null and their steps drop', () => {
    const pantry = [
      have('parsley', { addedOn: '2026-11-10', source: 'market' }),
      have('coriander', { addedOn: '2026-11-08', source: 'market' }),
      have('lime'),
      have('sunflower oil'),
    ];
    const f = fillFrame(greenSauce, pantry, ctx());
    expect(f.fills).toEqual({ herb: { name: 'coriander', ingredientId: 'coriander' }, acid: { name: 'lime', ingredientId: 'lime' }, oil: { name: 'sunflower oil', ingredientId: 'neutral_oil' }, nut: null });
    expect(f.recipe.steps.map((s) => stepPlainText(f.recipe, s))).toEqual(['Chop coriander fine.', 'Squeeze in lime.', 'Beat in sunflower oil slowly.']);
    expect(f.recipe.meta).toMatchObject({ title: 'Green sauce', skills: ['emulsion'], sacred: false, status: 'draft' });
    // The player's pick wins for its slot.
    expect(fillFrame(greenSauce, pantry, ctx(), { herb: 'parsley' }).fills.herb?.name).toBe('parsley');
    // One pantry item fills one slot: the only oil goes to the first oil slot.
    const fr = fillFrame(friedRice, [have('cold rice'), have('sunflower oil')], ctx());
    expect(fr.fills).toMatchObject({ rice: { name: 'cold rice' }, oil: { name: 'sunflower oil' }, veg: null, egg: null, sauce: null });
  });

  test('the whole filled dish is checked: an allium rule never lets an onion in, and an empty pantry is ❓, never ✅', () => {
    const f = fillFrame(tomatoSauce, [have('tomato'), have('onion'), have('sunflower oil')], ctx([avoid('allium')]));
    expect(f.fills.allium).toBeNull();
    expect(f.check.status).toBe('ok');
    const none = fillFrame(tomatoSauce, [], ctx());
    expect(none.emptyRequired).toEqual(['tomato', 'oil']);
    expect(none.check.status).toBe('unverified');
    expect(none.recipe.ingredients).toEqual([]);
  });

  test('frameOptions plug into the quest engine: an ok frame stands in, a ❓ one never does', () => {
    const recipes = new Map([...canon, ['test/stir', dish('haruka', ['cooked rice'], { skills: ['stir-fry'] })]]);
    const rc = { rules: [] as Rule[], graph, subs, recipes };
    const full = frameOptions(FRAMES, [have('cold rice'), have('sunflower oil')], ctx());
    expect(full).toEqual([
      { id: 'fried-rice', technique: 'stir-fry', status: 'ok' },
      { id: 'green-sauce', technique: 'emulsion', status: 'unverified' },
      { id: 'quick-tomato-sauce', technique: 'quick-sauce', status: 'unverified' },
    ]);
    expect(alternativesOn('test/stir', TODAY, { ...rc, frames: full })).toEqual([{ kind: 'frame', id: 'fried-rice', status: 'ok' }]);
    const bare = frameOptions(FRAMES, [], ctx());
    expect(alternativesOn('test/stir', TODAY, { ...rc, frames: bare })).toEqual([]);
  });
});

describe('validateFrames', () => {
  test('the seed frames are valid', () => {
    expect(validateFrames(FRAMES, graph, TECHNIQUES)).toEqual([]);
  });

  test('reports bad content and never throws', () => {
    const f = greenSauce;
    const bad = (over: Partial<Record<keyof Frame, unknown>>) => validateFrames([{ ...f, ...over } as Frame], graph, TECHNIQUES);
    expect(bad({ id: 'Green Sauce' })).toEqual(['frame "Green Sauce": id is not kebab-case']);
    expect(bad({ technique: 'juggling' })).toEqual(['frame "green-sauce": unknown technique "juggling"']);
    expect(bad({ status: 'final' })).toEqual(['frame "green-sauce": status is not draft or reviewed']);
    expect(bad({ title: ' ', credit: '' })).toEqual(['frame "green-sauce": no title', 'frame "green-sauce": no credit']);
    expect(bad({ slots: [] })).toContain('frame "green-sauce": no slots');
    expect(bad({ slots: [{ key: 'herb', accepts: ['herb'], optional: true }], steps: ['{herb}'], rescues: [] })).toEqual(['frame "green-sauce": no required slot']);
    expect(bad({ slots: [...f.slots, { key: 'herb', accepts: ['dragonfruit'], optional: 'no' }] })).toEqual([
      'frame "green-sauce": duplicate slot "herb"',
      'frame "green-sauce": slot 4 optional is not a boolean',
      'frame "green-sauce": slot 4 accepts unknown ingredient "dragonfruit"',
    ]);
    expect(bad({ steps: ['Chop {herbs}.', '{acid} {oil}'] })).toEqual(['frame "green-sauce": step uses unknown slot "{herbs}"', 'frame "green-sauce": required slot "herb" is in no step']);
    expect(bad({ rescues: ['tomato', 'not_an_id'] })).toEqual(['frame "green-sauce": rescues "tomato", which no slot accepts', 'frame "green-sauce": rescues unknown ingredient "not_an_id"']);
    expect(bad({ rescues: ['coriander'] })).toEqual([]); // a kind of an accepted id
    expect(validateFrames([f, f], graph, TECHNIQUES)).toEqual(['frame "green-sauce": duplicate id']);
    for (const junk of [null, 'x', [null], [{}], [{ slots: [null], steps: [1], rescues: 'x' }]]) expect(() => validateFrames(junk as Frame[], graph, TECHNIQUES)).not.toThrow();
  });
});

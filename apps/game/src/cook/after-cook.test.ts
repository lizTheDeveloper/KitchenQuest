// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';
import type { MarginNote, ProgressEvent, Rule } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { ApiResult } from '../api/types';
import { content, graph } from '../content';
import { createDialogue } from '../mentor/dialogue';
import { createCardWriter } from '../mentor/writer';
import { activeRules } from '../recipes/rules';
import { createStore, type PlayerState } from '../state/store';
import { afterCook, type AfterCookDeps } from './after-cook';

const T0 = new Date('2026-11-10T19:30:00');
const SLUG = 'india/kerala/parippu';
const TODAY = '2026-11-10';
const ok = <T>(data: T, status = 200): ApiResult<T> => ({ ok: true, status, data });
const fail = (status: number, code: string): ApiResult<never> => ({ ok: false, status, error: { code, message: '' } });
type Handler = (...args: unknown[]) => ApiResult<unknown>;
const peanut: Rule = { id: 'p1', target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' };
const pan = content.pan.triggers;
const isLine = (trigger: string, text: string | null | undefined) => pan[trigger].lines.some((l) => {
  const re = new RegExp(`^${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\w+\\\}/g, '.+')}$`);
  return text !== null && text !== undefined && re.test(text.trim());
});

function setup(opts: { signedIn?: boolean; consent?: 'granted' | 'missing'; familyTable?: boolean; rules?: Rule[]; script?: Partial<Record<keyof ApiClient, Handler>>; grant?: boolean } = {}) {
  const patch: Partial<PlayerState> = opts.signedIn === false ? {} : { account: { email: 'cook@example.com' }, accountRules: opts.rules ?? [] };
  const store = createStore(null);
  store.update((s) => ({ ...s, ...patch, settings: { ...s.settings, familyTable: opts.familyTable ?? false } }));
  const calls: { name: string; args: unknown[] }[] = [];
  const script: Partial<Record<keyof ApiClient, Handler>> = {
    createMeal: (m) => ok({ meal: { ...(m as object), id: 'meal-1' } }, 201),
    deleteMeal: () => ok(null, 204),
    recordShared: () => ok({ id: 's-1' }, 201),
    deleteShared: () => ok(null, 204),
    createNote: (n) => ok({ note: { ...(n as MarginNote), id: 'n-1', check: { status: 'ok', findings: [], severe: false, disclaimer: null } } }, 201),
    deleteNote: () => ok(null, 204),
    ...opts.script,
  };
  const client = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => {
      calls.push({ name, args });
      const f = script[name as keyof ApiClient];
      return f ? Promise.resolve(f(...args)) : Promise.reject(new Error(`unexpected call: ${name}`));
    },
  }) as ApiClient;
  const dialogue = createDialogue(content.pan);
  const writer = createCardWriter({ client, store, dialogue, graph, ruleTerms: content.ruleTerms, now: () => T0 });
  const recorded: ProgressEvent[] = [];
  const consentAsks: number[] = [];
  let consent = opts.consent ?? 'granted';
  const deps: AfterCookDeps = {
    writer, dialogue, now: () => T0,
    record: async (e) => { recorded.push(...e); },
    signedIn: () => store.get().account !== null,
    familyTable: () => store.get().settings.familyTable,
    healthConsent: () => consent,
    rules: () => activeRules(store.get(), graph),
    notes: async () => [],
    askConsent: async () => { consentAsks.push(1); if (opts.grant) consent = 'granted'; return opts.grant ?? false; },
  };
  const slot = document.createElement('div');
  document.body.append(slot);
  const run = (slug: string | null = SLUG, frame: string | null = null) =>
    afterCook(slot, { slug, frame, recipe: slug === null ? content.recipes[SLUG] : content.recipes[slug], at: TODAY }, deps);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const button = (name: string | RegExp, within: ParentNode = slot) => {
    const b = [...within.querySelectorAll('button')].find((x) => (typeof name === 'string' ? x.textContent === name : name.test(x.textContent ?? '')));
    if (!b) throw new Error(`no button ${String(name)} in ${slot.textContent}`);
    return b;
  };
  const slip = (kind: string) => slot.querySelector<HTMLElement>(`.bureau-slip[data-kind="${kind}"]`);
  return { deps, store, calls, recorded, consentAsks, slot, run, flush, button, slip };
}

afterEach(() => { document.body.replaceChildren(); });

describe('after cook (M5 Step 11)', () => {
  test('all three steps skippable; skipping writes nothing and costs nothing', async () => {
    const t = setup();
    let done = false;
    void t.run().then(() => { done = true; });
    await t.flush();
    // 1: who ate, its read-back focused (never the Stamp button, audit R2)
    const who = t.slip('cooked_for')!;
    expect(document.activeElement).toBe(who.querySelector('.slip-readback'));
    expect(isLine('cook.who_ate', who.querySelector('.slip-readback p')?.textContent)).toBe(true);
    t.button('Skip', who).click();
    await t.flush();
    // 2: did you change anything?
    expect(isLine('cook.changes_ask', document.activeElement?.textContent)).toBe(true);
    t.slot.querySelector<HTMLButtonElement>('.note-skip')!.click();
    await t.flush();
    // 3: log it?
    const log = t.slip('meal')!;
    expect(isLine('log.dish_offer', log.querySelector('.slip-readback p')?.textContent)).toBe(true);
    expect(document.activeElement).toBe(log.querySelector('.slip-readback'));
    t.button('Not now', log).click();
    await t.flush();
    expect(document.activeElement?.textContent).toBe('Back to the kitchen');
    t.button('Back to the kitchen').click();
    await t.flush();
    expect(done).toBe(true);
    expect(t.calls).toEqual([]);
    expect(t.recorded).toEqual([]);
  });

  test('"Back to the kitchen" ends it at once, writing nothing', async () => {
    const t = setup();
    const p = t.run();
    await t.flush();
    t.button('Back to the kitchen').click();
    await p;
    expect(t.calls).toEqual([]);
  });

  test('cooked-for: "my flatmate Sam and his sister" → card shows two_to_three + flatmate; the request body has no "Sam"', async () => {
    const t = setup();
    void t.run();
    await t.flush();
    const who = t.slip('cooked_for')!;
    const input = t.slot.querySelector<HTMLInputElement>('#cooked-for-text')!;
    input.value = 'my flatmate Sam and his sister';
    t.button('Read it').click();
    expect(input.value).toBe('');
    const values = [...who.querySelectorAll('.bureau-value')].map((v) => v.textContent);
    expect(values).toEqual(['You and two or three more', 'Flatmate']);
    expect(who.textContent).not.toContain('Sam');
    expect(t.slot.querySelector('[data-value="two_to_three"]')?.getAttribute('aria-pressed')).toBe('true');
    t.button('Stamp it ✔', who).click();
    await t.flush();
    const post = t.calls.find((c) => c.name === 'recordShared')!;
    expect(post.args).toEqual([{ cookedOn: TODAY, recipe: SLUG, frame: null, cookedFor: { count: 'two_to_three', who: 'flatmate' } }, TODAY]);
    expect(JSON.stringify(post.args)).not.toMatch(/sam|sister/i);
    expect([...t.slot.querySelectorAll('.after-cook-line')].some((p) => isLine('cooked_for.shared', p.textContent))).toBe(true);
    expect(t.recorded).toEqual([]); // Cooked for Someone feeds nothing (M-9)
  });

  test('"Just me" gets the alone line, with equal warmth; Undo deletes exactly that row', async () => {
    const t = setup();
    void t.run();
    await t.flush();
    t.slot.querySelector<HTMLButtonElement>('[data-value="just_me"]')!.click();
    expect(t.slot.querySelector('[data-value="partner"]')).toBeNull(); // no "who" for a table for one
    t.button('Stamp it ✔', t.slip('cooked_for')!).click();
    await t.flush();
    expect([...t.slot.querySelectorAll('.after-cook-line')].some((p) => isLine('cooked_for.alone', p.textContent))).toBe(true);
    t.button('Undo').click();
    await t.flush();
    expect(t.calls.filter((c) => c.name === 'deleteShared').map((c) => c.args)).toEqual([['s-1']]);
  });

  test('signed out: cooked-for is skipped silently; margin.needs_account and log.needs_account, no controls, nothing called', async () => {
    const t = setup({ signedIn: false });
    void t.run();
    await t.flush();
    expect(t.slip('cooked_for')).toBeNull();
    const lines = [...t.slot.querySelectorAll('.after-cook-line')].map((p) => p.textContent);
    expect(lines.some((l) => isLine('margin.needs_account', l))).toBe(true);
    expect(lines.some((l) => isLine('log.needs_account', l))).toBe(true);
    expect([...t.slot.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Back to the kitchen']);
    expect(t.calls).toEqual([]);
  });

  test('margin note: "used peanut butter" for a peanut-rule player → margin.blocked before the stamp; stamped → server check ⛔', async () => {
    const t = setup({
      rules: [peanut],
      script: { createNote: (n) => ok({ note: { ...(n as MarginNote), id: 'n-1', check: { status: 'blocked', findings: [{ ingredient: 'peanut butter', status: 'blocked', kind: 'rule' }], severe: true, disclaimer: null } } }, 201) },
    });
    void t.run();
    await t.flush();
    t.button('Skip', t.slip('cooked_for')!).click();
    await t.flush();
    t.slot.querySelector<HTMLTextAreaElement>('.note-text')!.value = 'used peanut butter';
    t.button('Read it back').click();
    await t.flush();
    const card = t.slip('margin_note')!;
    expect(card.dataset.status).toBe('blocked');
    const said = [...card.querySelectorAll('.slip-readback p')].map((p) => p.textContent);
    expect(isLine('margin.readback', said[0])).toBe(true);
    expect(isLine('margin.blocked', said[1])).toBe(true);
    expect(said[1]).toContain('peanut');
    expect(t.calls).toEqual([]); // nothing kept before the tap
    expect(document.activeElement).toBe(card.querySelector('.slip-readback'));
    t.button('Write it in ✔', card).click();
    await t.flush();
    const post = t.calls.find((c) => c.name === 'createNote')!;
    expect(post.args).toEqual([{ recipe: SLUG, ops: [{ op: 'add', name: 'peanut butter' }], text: null, at: TODAY }, TODAY]);
  });

  test('margin note without health_data → the 3-C card first; a decline skips it and keeps nothing', async () => {
    const t = setup({ consent: 'missing' });
    void t.run();
    await t.flush();
    t.button('Skip', t.slip('cooked_for')!).click();
    await t.flush();
    await t.flush();
    expect(t.consentAsks.length).toBeGreaterThanOrEqual(1);
    expect([...t.slot.querySelectorAll('.after-cook-line')].some((p) => isLine('consent.health_first', p.textContent))).toBe(true);
    expect(t.slot.querySelector('.note-form')).toBeNull();
    expect(t.calls).toEqual([]);
  });

  test('margin note after granting health_data opens the note form', async () => {
    const t = setup({ consent: 'missing', grant: true });
    void t.run();
    await t.flush();
    t.button('Skip', t.slip('cooked_for')!).click();
    await t.flush();
    await t.flush();
    expect(t.slot.querySelector('.note-form')).not.toBeNull();
  });

  test('a structured swap chip builds the op from the recipe\'s own line', async () => {
    const t = setup();
    void t.run();
    await t.flush();
    t.button('Skip', t.slip('cooked_for')!).click();
    await t.flush();
    t.slot.querySelector<HTMLButtonElement>('[data-op="swap"]')!.click();
    const from = t.slot.querySelector<HTMLSelectElement>('.note-picker select')!;
    from.value = content.recipes[SLUG].ingredients[0].name;
    t.slot.querySelector<HTMLInputElement>('.note-picker input')!.value = 'red lentils';
    t.button('Swap it').click();
    t.button('Read it back').click();
    await t.flush();
    t.button('Write it in ✔', t.slip('margin_note')!).click();
    await t.flush();
    const post = t.calls.find((c) => c.name === 'createNote')!;
    expect((post.args[0] as MarginNote).ops).toEqual([{ op: 'swap', from: content.recipes[SLUG].ingredients[0].name, to: 'red lentils' }]);
  });

  test('a sacred dish: nothing is offered at all; a frame takes no margin note', async () => {
    const sacredRecipe = { ...content.recipes[SLUG], meta: { ...content.recipes[SLUG].meta, sacred: true } };
    const t = setup();
    await afterCook(t.slot, { slug: SLUG, frame: null, recipe: sacredRecipe, at: TODAY }, t.deps);
    expect(t.slot.childElementCount).toBe(0);
    const f = setup();
    void f.run(null, content.frames[0].id);
    await f.flush();
    f.button('Skip', f.slip('cooked_for')!).click();
    await f.flush();
    expect(f.slot.querySelector('.note-form')).toBeNull();
    expect(f.slip('meal')).not.toBeNull();
  });

  test('one-tap log: Log it → POST /meals with confirmed true, then a meal_logged event with that id; no XP number shown', async () => {
    const t = setup();
    void t.run();
    await t.flush();
    t.button('Skip', t.slip('cooked_for')!).click();
    await t.flush();
    t.slot.querySelector<HTMLButtonElement>('.note-skip')!.click();
    await t.flush();
    const log = t.slip('meal')!;
    log.querySelector<HTMLButtonElement>('[data-value="2"]')!.click();
    t.button('Log it', log).click();
    await t.flush();
    const post = t.calls.find((c) => c.name === 'createMeal')!;
    expect(post.args).toEqual([{ eatenOn: TODAY, slot: 'dinner', item: { kind: 'dish', slug: SLUG, servings: 2 } }, true]);
    expect(t.recorded).toEqual([{ id: expect.any(String), kind: 'meal_logged', at: TODAY, minute: 19 * 60 + 30, mealLogId: 'meal-1' }]);
    expect(t.slot.textContent).not.toMatch(/\bXP\b|\d+\s*(?:xp|points)/i);
    // Undo is DELETE /meals/:id only: the server erases the progress event (Step 5 I1).
    t.button('Undo', log.parentElement!).click();
    await t.flush();
    expect(t.calls.filter((c) => c.name === 'deleteMeal').map((c) => c.args)).toEqual([['meal-1']]);
    expect(t.calls.some((c) => c.name === 'postProgressEvents')).toBe(false);
  });

  test('one-tap log refused for consent (403) → the consent card, nothing recorded', async () => {
    const t = setup({ script: { createMeal: () => fail(403, 'consent_required') } });
    void t.run();
    await t.flush();
    t.button('Skip', t.slip('cooked_for')!).click();
    await t.flush();
    t.slot.querySelector<HTMLButtonElement>('.note-skip')!.click();
    await t.flush();
    t.button('Log it', t.slip('meal')!).click();
    await t.flush();
    expect(t.consentAsks).toHaveLength(1);
    expect(t.recorded).toEqual([]);
  });

  test('Family Table: after cook asks nothing and writes nothing (C31)', async () => {
    const t = setup({ familyTable: true });
    await t.run();
    expect(t.slot.childElementCount).toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.recorded).toEqual([]);
  });
});

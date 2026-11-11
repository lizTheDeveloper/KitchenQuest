// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import type { PantryItem, Rule } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import type { AppContext } from '../shell/app';
import { createStore } from '../state/store';
import { cookable, frameCook, NOTHING_FITS, slotCandidates } from './frame-cook';
import { handOffPick } from '../week/memory';

const TODAY = '2026-11-11';
const fried = content.frames.find((f) => f.id === 'fried-rice')!;
const ctx = (rules: Rule[] = []) => ({ rules, graph, subs: [...content.substitutions], today: TODAY, keeps: content.keeps });
const SPINACH: Rule = { id: 'r-sp', target: { kind: 'ingredient', ids: ['spinach'] }, type: 'avoid', severity: 'allergy' };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('frame cook', () => {
  test('blocked candidates absent; unresolved shows ❓; required empty slot disables Cook', async () => {
    const pantry: PantryItem[] = [
      { name: 'cooked rice', ingredientId: 'cooked_rice' },
      { name: 'spinach', ingredientId: 'spinach' },
      { name: 'onion', ingredientId: 'onion' },
      // The player knows what it is; the engine can't resolve it.
      { name: 'mystery greens', ingredientId: null },
    ];
    const c = slotCandidates(fried, pantry, ctx([SPINACH]));
    expect(c.veg.map((x) => x.item.name)).not.toContain('spinach'); // ⛔ for this player: never listed
    expect(c.veg.find((x) => x.item.name === 'onion')?.status).toBe('ok');
    expect(c.veg.find((x) => x.item.name === 'mystery greens')?.status).toBe('unverified');
    expect(c.oil).toEqual([{ item: { name: 'mystery greens', ingredientId: null }, status: 'unverified' }]);

    // No oil at all except the unresolved name, which is never chosen for the player: Cook stays disabled.
    const store = createStore(null);
    store.update((s) => ({ ...s, localRules: [SPINACH] }));
    const app: AppContext = { store, now: () => new Date(2026, 10, 11, 12), navigate: () => undefined };
    const el = document.createElement('div');
    document.body.append(el);
    const stop = frameCook(el, fried, { ctx: app, pantry: () => Promise.resolve(pantry.filter((p) => p.ingredientId !== null)) });
    await flush();
    const oil = el.querySelector('[data-slot="oil"]')!;
    expect(oil.textContent).toContain(NOTHING_FITS);
    // M4: about the slot, never the cupboard.
    expect(el.textContent).not.toMatch(/cupboard fits|in your cupboard/i);
    expect(content.pan.triggers['frame.slot_empty'].lines.some((l) => oil.textContent.includes(l.slice(l.indexOf('}') + 1, l.indexOf('}') + 12)))).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('.frame-cook')!.disabled).toBe(true);
    expect(el.querySelector('[data-slot="veg"]')!.textContent).not.toContain('spinach');
    stop();
    el.remove();
  });

  test('with every required slot filled by passing items, Cook is enabled; a ❓ pick shows ❓ on the dish', async () => {
    const pantry: PantryItem[] = [{ name: 'cooked rice', ingredientId: 'cooked_rice' }, { name: 'sunflower oil', ingredientId: 'neutral_oil' }, { name: 'mystery greens', ingredientId: null }];
    const store = createStore(null);
    const el = document.createElement('div');
    document.body.append(el);
    const stop = frameCook(el, fried, { ctx: { store, now: () => new Date(2026, 10, 11, 12), navigate: () => undefined }, pantry: () => Promise.resolve(pantry) });
    await flush();
    const cook = el.querySelector<HTMLButtonElement>('.frame-cook')!;
    expect(cook.disabled).toBe(false);
    // The unresolved filler is listed with ❓ and never pre-chosen.
    const mystery = [...el.querySelectorAll<HTMLInputElement>('[data-slot="veg"] input')].find((i) => i.value === 'mystery greens')!;
    expect(mystery.checked).toBe(false);
    mystery.checked = true;
    mystery.dispatchEvent(new Event('change'));
    expect(el.querySelector('.frame-summary [data-status]')!.getAttribute('data-status')).toBe('unverified');
    expect(cookable({ emptyRequired: [], check: { status: 'blocked', findings: [] } } as never)).toBe(false);
    stop();
    el.remove();
  });

  test('M5: "Cook the frame" from a rescue starts the picker on the rescued item', async () => {
    const pantry: PantryItem[] = [{ name: 'cooked rice', ingredientId: 'cooked_rice' }, { name: 'sunflower oil', ingredientId: 'neutral_oil' }, { name: 'onion', ingredientId: 'onion' }, { name: 'spinach', ingredientId: 'spinach' }];
    const checked = async (pick?: Record<string, string>) => {
      if (pick) handOffPick('fried-rice', pick);
      const el = document.createElement('div');
      const stop = frameCook(el, fried, { ctx: { store: createStore(null), now: () => new Date(2026, 10, 11, 12), navigate: () => undefined }, pantry: () => Promise.resolve(pantry) });
      await flush();
      const v = [...el.querySelectorAll<HTMLInputElement>('[data-slot="veg"] input')].find((i) => i.checked)?.value;
      stop();
      return v;
    };
    expect(await checked()).toBe('onion'); // the plain fill
    expect(await checked({ veg: 'spinach' })).toBe('spinach');
    expect(await checked()).toBe('onion'); // handed over once only
  });
});

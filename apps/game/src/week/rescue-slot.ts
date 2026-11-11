import type { PantryItem } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph, techniqueName } from '../content';
import { localDate } from '../recipes/rules';
import type { AppContext } from '../shell/app';
import { statusChip } from '../ui/chips';
import { contentText, h } from '../ui/dom';
import { canonRecipes, rulesOf } from './context';
import { handOffPick, rememberWeek } from './memory';
import { writtenLine } from './plan-view';
import { answerNudge, compost, noteNudge, rescueOffer, type RescueOffer } from './rescue';
import { createWeekSource } from './source';

/**
 * The kitchen's rescue slot (M5 Step 10): loads after first paint, reads the week and the pantry (signed in, from
 * the API: reads only), and shows today's one Use-It-Up offer, if there is one. Nothing is fetched while nudges are
 * off, in Family Table mode, or once today's nudge was answered.
 */
export async function mountRescue(slot: HTMLElement, ctx: AppContext, client: ApiClient, alive: () => boolean): Promise<void> {
  const s = ctx.store.get();
  const today = localDate(ctx.now());
  if (!s.settings.rescueNudges || s.settings.familyTable) return;
  if (s.rescue !== null && s.rescue.on === today && s.rescue.answered) return;
  const rules = rulesOf(s);
  if (rules === null) return; // can't verify: nothing is suggested
  let pantry: (PantryItem & { id: string })[] = s.localPantry;
  if (s.account !== null) {
    const p = await client.getPantry();
    if (!p.ok) return;
    pantry = p.data.items;
  }
  const week = await createWeekSource({ store: ctx.store, client }).current(today);
  if (!alive()) return;
  const plan = week.ok ? week.value.plan : null;
  if (week.ok) rememberWeek(week.value.weekStart, plan, ctx.store.get().account?.email ?? null);
  const offer = rescueOffer(ctx.store.get(), pantry, plan, today, content.frames, content.keeps, { recipes: canonRecipes(), graph, rules, subs: [...content.substitutions] });
  if (offer === null) return;
  noteNudge(ctx.store, offer, today);
  slot.replaceChildren(renderRescue(offer, ctx, client, today));
}

function renderRescue(offer: RescueOffer, ctx: AppContext, client: ApiClient, today: string): HTMLElement {
  const unsure = offer.filled.check.status === 'unverified';
  const item = offer.item.name;
  const text = unsure
    ? writtenLine('rescue.unverified', { item })
    : writtenLine('rescue.offer', { item, technique: techniqueName(offer.frame.technique), dish: offer.frame.title });
  const cook = h('button', { type: 'button', class: 'btn btn-primary rescue-cook' }, 'Cook the frame');
  const bin = h('button', { type: 'button', class: 'btn btn-secondary rescue-compost' }, 'Compost it');
  const later = h('button', { type: 'button', class: 'btn btn-secondary rescue-later' }, 'Not now');
  const note = h('p', { class: 'rescue-note', role: 'status', 'data-content': '' });
  const box = h('section', { class: 'rescue', 'aria-labelledby': 'rescue-title' },
    h('h2', { id: 'rescue-title', tabindex: -1 }, 'Use it up'),
    contentText('p', text, { class: 'rescue-line' }),
    h('p', null, contentText('span', offer.frame.title), ' ', statusChip(offer.filled.check.status)),
    h('div', { class: 'button-row' }, cook, bin, later), note);
  const done = () => { for (const b of [cook, bin, later]) b.remove(); };
  cook.addEventListener('click', () => {
    answerNudge(ctx.store, offer, today);
    // M5: the picker starts from the rescued item in its slot, not whatever else fits first.
    const slots = Object.entries(offer.filled.fills).filter(([, f]) => f?.name === offer.item.name).map(([k]) => k);
    if (slots.length > 0) handOffPick(offer.frame.id, { [slots[0]]: offer.item.name });
    ctx.navigate({ name: 'frame', id: offer.frame.id });
  });
  later.addEventListener('click', () => {
    answerNudge(ctx.store, offer, today);
    const hadFocus = box.contains(document.activeElement);
    box.remove();
    if (hadFocus) document.querySelector<HTMLElement>('.kitchen-actions button')?.focus();
  });
  bin.addEventListener('click', () => {
    bin.disabled = true;
    void compost(ctx.store, client, offer.item).then((ok) => {
      if (!ok) { bin.disabled = false; note.textContent = "That didn't go through, so nothing changed."; return; }
      answerNudge(ctx.store, offer, today);
      done();
      note.textContent = writtenLine('rescue.compost', { item });
      box.querySelector<HTMLElement>('h2')?.focus();
    });
  });
  return box;
}

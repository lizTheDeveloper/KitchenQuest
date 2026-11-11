import {
  check, fillFrame, frameOptions, standInCooks, type CheckStatus, type FilledFrame, type Frame, type FrameContext, type PantryItem, type ParsedRecipe,
  type RecipeIngredient,
} from '@kitchenquest/core/engine';
import { content, graph, techniqueName } from '../content';
import { getMentorServices } from '../mentor';
import { progressService } from '../progress';
import { catalogueOf, questsOf } from '../progress/catalogue';
import { newEventId } from '../progress/log';
import { cookStepEvents } from '../quests/quest-runner';
import { cardInputsKey, localDate } from '../recipes/rules';
import type { AppContext } from '../shell/app';
import { routeHref } from '../shell/router';
import { statusChip } from '../ui/chips';
import { contentText, h } from '../ui/dom';
import { rulesOf } from '../week/context';
import { takePick } from '../week/memory';
import { writtenLine } from '../week/plan-view';
import { runCookMode } from './cook-mode';

/**
 * A Pantry Frame in cook mode (`#/frame/<id>`, M5 Step 10, Ruling 13). First the slot picker: for each slot, the
 * pantry items core `fillFrame` would put there, each checked by the rules engine on its own today. A ⛔ candidate
 * is never listed; a ❓ one (unresolved, or check the label) is listed with the ❓ badge, and is never chosen for the
 * player. A required slot with nothing that fits says `frame.slot_empty` and "nothing I can check fits", and
 * Cook stays disabled until it is filled; so it does while the filled dish is ⛔. Then M3's cook mode runs the
 * frame's steps with the chosen names. Finishing records `frame_cooked`, and only then any quest cook step it
 * completes (Step 9 carry).
 */

/** About the slot, never about the cupboard (audit M-4): true too when items are there but the rules refuse them. */
export const NOTHING_FITS = 'nothing I can check fits';
const NO_RULES = "Your rules couldn't be read just now, so nothing here can be checked. Open Your rules to look them over.";

/** A one-line dish of `name`, as core checks a frame filler alone. */
function oneLine(name: string, frame: Frame): ParsedRecipe {
  const line: RecipeIngredient = { name, displayName: null, quantity: null, unit: null, note: null };
  return {
    meta: { title: frame.title, country: '', region: '', credit: frame.credit, cook: '', difficulty: 1, skills: [frame.technique], servings: 1, license: 'CC-BY-SA-4.0', status: frame.status, sacred: false, contributors: [] },
    ingredients: [line], timers: [], steps: [], source: '',
  };
}

export interface SlotCandidate { item: PantryItem; status: CheckStatus }

/**
 * The candidates for each slot: the pantry items core `fillFrame` puts in that slot when the player picks them, each
 * with its own rules status. ⛔ ones never fill a slot, so they are never here (§2.2).
 */
export function slotCandidates(frame: Frame, pantry: readonly PantryItem[], ctx: FrameContext): Record<string, SlotCandidate[]> {
  const out: Record<string, SlotCandidate[]> = {};
  for (const slot of frame.slots) {
    const list: SlotCandidate[] = [];
    for (const item of pantry) {
      if (list.some((c) => c.item.name === item.name)) continue;
      const filled = fillFrame(frame, [item], ctx, { [slot.key]: item.name });
      if (filled.fills[slot.key]?.name !== item.name) continue;
      const status = check(oneLine(item.name, frame), ctx.rules, ctx.graph, ctx.subs, ctx.today).status;
      if (status !== 'blocked') list.push({ item, status });
    }
    out[slot.key] = list;
  }
  return out;
}

/** Whether the filled frame may be cooked: every required slot filled, and not ⛔ (❓ may, with its badge). */
export const cookable = (f: FilledFrame): boolean => f.emptyRequired.length === 0 && f.check.status !== 'blocked';

export function frameCook(el: HTMLElement, frame: Frame, deps: { ctx: AppContext; pantry?: () => Promise<PantryItem[]> }): () => void {
  const { ctx } = deps;
  let teardown: (() => void) | null = null;
  let gone = false;
  const form = content.bureau.forms.frame;
  const title = contentText('h1', frame.title, { tabindex: -1 });
  const body = h('div', { class: 'frame-body' });
  el.replaceChildren(title, h('p', { class: 'bureau-number' }, `PANTRY BUREAU · FORM ${form.number}`), body);

  const loadPantry = deps.pantry ?? (async (): Promise<PantryItem[]> => {
    if (ctx.store.get().account === null) return ctx.store.get().localPantry;
    const r = await getMentorServices().client.getPantry();
    return r.ok ? r.data.items : [];
  });

  void loadPantry().then((pantry) => {
    if (gone) return;
    const today = localDate(ctx.now());
    const rules = rulesOf(ctx.store.get());
    if (rules === null) {
      body.replaceChildren(h('p', { class: 'rules-error', role: 'note' }, NO_RULES), h('p', null, h('a', { href: routeHref({ name: 'rules' }) }, 'Open Your rules')));
      return;
    }
    const fctx: FrameContext = { rules, graph, subs: [...content.substitutions], today, keeps: content.keeps };
    const candidates = slotCandidates(frame, pantry, fctx);
    const defaults = fillFrame(frame, pantry, fctx);
    const picks: Record<string, string> = {};
    for (const slot of frame.slots) { const f = defaults.fills[slot.key]; if (f) picks[slot.key] = f.name; }
    // M5: a rescue's item starts in its slot when it is one of that slot's candidates (never a ⛔ one: they aren't).
    for (const [key, name] of Object.entries(takePick(frame.id) ?? {})) {
      if (candidates[key]?.some((c) => c.item.name === name)) picks[key] = name;
    }

    const summary = h('div', { class: 'frame-summary', 'aria-live': 'polite' });
    const cook = contentText('button', form.buttons.confirm, { type: 'button', class: 'btn btn-primary frame-cook' });
    const filledNow = () => fillFrame(frame, pantry, fctx, picks);
    const update = () => {
      const filled = filledNow();
      cook.disabled = !cookable(filled);
      summary.replaceChildren(h('p', null, 'Checked against your rules: ', statusChip(filled.check.status)));
      if (filled.check.status === 'unverified') summary.append(h('p', { class: 'unverified-note' }, "Some of this can't be checked against your rules. Check every label before you cook it."));
    };

    const fieldsets = frame.slots.map((slot) => {
      const list = candidates[slot.key];
      const legend = h('legend', null, slot.key.replace(/_/g, ' '), slot.optional ? ' (optional)' : '');
      const fs = h('fieldset', { class: 'frame-slot', 'data-slot': slot.key }, legend);
      if (list.length === 0) {
        if (!slot.optional) {
          fs.append(contentText('p', writtenLine('frame.slot_empty', { slot: slot.key.replace(/_/g, ' ') }), { class: 'frame-empty' }),
            h('p', { class: 'frame-nothing' }, `${slot.key.replace(/_/g, ' ')}: ${NOTHING_FITS}`));
        } else {
          fs.append(h('p', { class: 'frame-nothing' }, NOTHING_FITS));
        }
        return fs;
      }
      list.forEach((c, n) => {
        const id = `frame-${slot.key}-${n}`;
        const radio = h('input', { type: 'radio', name: `frame-${slot.key}`, id, value: c.item.name, checked: picks[slot.key] === c.item.name });
        radio.checked = picks[slot.key] === c.item.name;
        radio.addEventListener('change', () => { if (radio.checked) { picks[slot.key] = c.item.name; update(); } });
        fs.append(h('div', { class: 'field frame-candidate', 'data-status': c.status }, radio, h('label', { for: id }, contentText('span', c.item.name), ' ', statusChip(c.status))));
      });
      return fs;
    });

    cook.addEventListener('click', () => {
      const filled = filledNow();
      if (!cookable(filled)) return;
      start(filled, { ...picks });
    });
    body.replaceChildren(
      h('p', null, 'Technique: ', contentText('span', techniqueName(frame.technique))),
      contentText('p', frame.credit, { class: 'recipe-credit' }),
      ...(frame.status === 'draft' ? [h('span', { class: 'draft-badge' }, 'Draft recipe')] : []),
      h('form', { class: 'frame-form', onsubmit: (ev: Event) => { ev.preventDefault(); } }, ...fieldsets),
      summary,
      h('div', { class: 'button-row' }, cook, h('a', { href: routeHref({ name: 'kitchen' }), class: 'btn btn-secondary' }, form.buttons.decline ?? 'Not now')),
      ...(form.footnotes ?? []).map((f) => contentText('p', f, { class: 'bureau-footnote' })),
    );
    update();

    const start = (filled: FilledFrame, chosen: Record<string, string>) => {
      let current = filled;
      const strip = () => h('section', { class: 'safety-strip', 'aria-label': 'Safety check', 'data-status': current.check.status },
        h('p', { class: 'recipe-status' }, statusChip(current.check.status)));
      teardown = runCookMode(el, ctx, {
        title: frame.title,
        recipe: current.recipe,
        draft: frame.status === 'draft',
        strip,
        swapFor: (ing) => {
          const s = current.check.findings.find((f) => f.ingredient === ing.name && f.swap)?.swap;
          return s ? `swapped: ${s.toName} for ${ing.name}` : null;
        },
        progressKey: null,
        start: { trigger: 'frame.offer', vars: { frame: frame.title, technique: techniqueName(frame.technique) } },
        done: { trigger: 'cook.done', vars: { dish: frame.title, cook: 'the Bureau' } },
        certificate: {
          form: { ...content.bureau.forms.certificate, fields: content.bureau.forms.certificate.fields.map(({ hint: _hint, ...f }) => f) },
          values: { dish: frame.title, taught_by: frame.credit, rewards: `Technique practised: ${techniqueName(frame.technique)}` },
        },
        record: async () => {
          try {
            const svc = await progressService();
            const day = localDate(ctx.now());
            const base = svc.rulesContext(day);
            // The frames as filled from the pantry this frame was cooked from (signed in, the account's pantry).
            const rulesCtx = base === undefined ? undefined : { ...base, frames: frameOptions(content.frames, pantry, { ...fctx, today: day }) };
            const standsIn = rulesCtx === undefined ? [] : standInCooks({ kind: 'frame', id: frame.id }, day, catalogueOf(), rulesCtx);
            // `frame_cooked` first: the quest cook step it completes is advanced only after it is recorded.
            await svc.record([{ id: newEventId(), kind: 'frame_cooked', at: day, frame: frame.id, technique: frame.technique, ...(standsIn.length > 0 ? { standsInFor: standsIn } : {}) }]);
            if (rulesCtx === undefined) return;
            const steps = cookStepEvents(questsOf(), svc.view(), day, { ...rulesCtx, today: day, cat: catalogueOf() });
            if (steps.length > 0) await svc.record(steps);
          } catch (err) {
            console.error(err);
          }
        },
        leave: () => ctx.navigate({ name: 'kitchen' }),
        after: () => ctx.navigate({ name: 'kitchen' }),
        inputsKey: cardInputsKey,
        recheck: () => {
          const r = rulesOf(ctx.store.get());
          const before = current;
          if (r !== null) current = fillFrame(frame, pantry, { ...fctx, rules: r, today: localDate(ctx.now()) }, chosen);
          if (r === null || !cookable(current)) {
            const refused = h('section', { class: 'cook-refusal' }, contentText('h1', frame.title, { tabindex: -1 }),
              h('p', { class: 'not-cookable' }, "This frame isn't cookable with your rules."));
            return { refused, text: "This frame isn't cookable with your rules." };
          }
          const changed = JSON.stringify(before.check) !== JSON.stringify(current.check);
          return { strip: changed, swaps: changed, announce: before.check.status !== current.check.status ? 'Safety check changed.' : null };
        },
      });
    };
  }, (err: unknown) => { console.error(err); });

  return () => { gone = true; teardown?.(); };
}

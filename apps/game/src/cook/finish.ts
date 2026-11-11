import { standInCooks, type Catalogue, type ProgressEvent, type RulesContext } from '@kitchenquest/core/engine';
import { healthConsent } from '../api/client';
import { content, graph } from '../content';
import { copy } from '../content/copy';
import { getMentorServices } from '../mentor';
import { renderConsentCard } from '../mentor/consent-card';
import { progressService } from '../progress';
import { activeRules } from '../recipes/rules';
import type { BureauForm } from '../content/types';
import type { AppContext } from '../shell/app';
import { h } from '../ui/dom';
import { afterCook, type AfterCookInput } from './after-cook';

/**
 * The `cooked` progress event for finishing cook mode (Ruling 7): the slug, the player's local date and whether the
 * dish was on this week's plan. The toolkit is a fold over these events now; nothing writes it directly.
 *
 * `standsInFor` (I3) is filled from core `standInCooks` when the player's rules are known: the cooks whose every dish
 * is ⛔ for them today and to one of which this dish is an alternative. Core checks the claim again (and the server
 * with the rules it holds); a claim that doesn't hold is dropped, never the event.
 */
export function cookedEvent(
  slug: string, today: string, planned: boolean, id: string, cat: Pick<Catalogue, 'recipes'>, ctx: RulesContext | undefined,
): Extract<ProgressEvent, { kind: 'cooked' }> {
  const standsIn = ctx === undefined ? [] : standInCooks({ kind: 'recipe', slug }, today, cat, ctx);
  return { id, kind: 'cooked', at: today, recipe: slug, planned, ...(standsIn.length > 0 ? { standsInFor: standsIn } : {}) };
}

/**
 * Hands a finished cook to the after-cook questions (Step 11), then goes to the kitchen. Family Table goes straight to
 * the kitchen: nothing is asked and nothing is kept (C31). It lives in the cook screen's chunk, never in first paint.
 */
export async function afterCookThenKitchen(el: HTMLElement, ctx: AppContext, input: AfterCookInput): Promise<void> {
  const store = ctx.store;
  if (store.get().settings.familyTable) { ctx.navigate({ name: 'kitchen' }); return; }
  const { client, writer, dialogue } = getMentorServices();
  const signedIn = () => store.get().account !== null;
  let consent: 'granted' | 'reconsent' | 'missing' = 'missing';
  if (signedIn()) {
    const r = await client.consents();
    if (r.ok) consent = healthConsent(r.data);
  }
  await afterCook(el, input, {
    writer, dialogue, now: ctx.now,
    record: async (events) => (await progressService()).record(events),
    signedIn, familyTable: () => store.get().settings.familyTable,
    healthConsent: () => consent,
    rules: () => activeRules(store.get(), graph),
    // One GET /notes, filtered here (C32): no recipe slug is ever in a notes URL.
    notes: async () => { const r = await client.listNotes(); return r.ok ? r.data.notes.filter((n) => n.recipe === input.slug) : []; },
    askConsent: (box) => new Promise<boolean>((resolve) => {
      void client.consents().then((r) => {
        const notice = r.ok ? r.data.notices.health_data : undefined;
        const form = content.bureau.forms.consent_health as BureauForm | undefined;
        if (notice === undefined || form === undefined) { box.append(h('p', { role: 'status' }, copy('ui.rules.consent_unavailable'))); resolve(false); return; }
        const card = renderConsentCard('health_data', {
          form, notice,
          onAgree: async () => {
            const g = await client.grantConsent('health_data', notice.version);
            if (!g.ok) { card.append(h('p', { class: 'pan-card-note', role: 'status' }, copy('ui.rules.consent_failed'))); return; }
            consent = 'granted';
            card.replaceWith(h('p', { role: 'status' }, CONSENT_DONE));
            resolve(true);
          },
          onDecline: () => { card.remove(); resolve(false); },
        });
        box.append(card);
        card.querySelector<HTMLElement>('.consent-notice')?.setAttribute('tabindex', '-1');
        card.querySelector<HTMLElement>('.consent-notice')?.focus();
      });
    }),
  });
  ctx.navigate({ name: 'kitchen' });
}

/** After the grant, the flow carries on by itself: no "tap again" here, unlike Your rules. */
const CONSENT_DONE = 'Permission filed.';

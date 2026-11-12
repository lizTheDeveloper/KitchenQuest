// One stall, `#/stall/<id>` (M6 Step 9, Ruling 15): the keeper's greeting, a short round of their questions, their item
// tips and their FAQ chips. Every question, tip, FAQ answer and keeper line shown is one core kept for the player's
// rules today (`stallBank`, `tipFor`, `faqFor`, `keeperLines`); nothing is shown on a guess, and rules that can't be
// read close the stall (`market.stall_wait`). A round played through, or left with an answer, records one
// `stall_round` (never in Family Table). No timer, no score, no lives; the shopping list never waits on any of it.
import {
  faqFor, keeperLines, nextRound, seasonalQuestions, stallBank, tipFor,
  type AnsweredMap, type MarketCtx, type ProgressView, type StallFile, type StallQuestion,
} from '@kitchenquest/core/engine';
import assets from 'virtual:kq-assets';
import { healthConsent, type ApiClient } from '../api/client';
import { content, graph } from '../content';
import type { ClientStall, MarketContent } from '../content/types';
import { progressService } from '../progress';
import { withMarket } from '../progress/catalogue';
import type { ProgressService } from '../progress/service';
import { activeRules, localDate } from '../recipes/rules';
import type { Screen } from '../shell/app';
import { routeHref, type KeeperStall, type Route } from '../shell/router';
import { contentText, h } from '../ui/dom';
import { askHealthConsent, statusLine } from '../week/screen-kit';
import { loadMarket } from './content';
import { recordRound } from './record';
import { renderRound, type RoundAnswer, type RoundHandle } from './round-view';
import { keeperName, marketCtxFor, noteForHub, profileFor, seasonFor, type MarketProfile } from './stall-context';

const MARKET_OFFLINE = "The market didn't load, so the stall stays shut for now. Nothing you've saved has been touched. Try again when you're back online.";
const CONSENT_NOTE = 'The Protein Counter keeps its rounds with your health details, so it needs your say-so first. Nothing has been kept yet.';

/** 32-bit FNV-1a: a fixed pick among written lines for the same key, so a redraw never changes the words. */
function hashOf(text: string): number {
  let x = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { x ^= text.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
  return x >>> 0;
}
/** One written line for `key`: deterministic, and never a line with a `{var}` this screen didn't fill. */
export function pickLine(lines: readonly string[], key: string): string | null {
  const ready = lines.filter((l) => !/\{\w+\}/.test(l));
  return ready.length === 0 ? null : ready[hashOf(key) % ready.length];
}
/** The Pan's written line for a market trigger (written lines only, M5 Ruling 21), picked the same way. */
export function panLine(trigger: string, key: string): string {
  const t = Object.hasOwn(content.pan.triggers, trigger) ? content.pan.triggers[trigger] : undefined;
  const line = t === undefined ? null : pickLine(t.lines, key);
  if (line === null) throw new Error(`no written line "${trigger}" in pan.yaml`);
  return line;
}

/** An item sprite for an ingredient id (`art/items/<name>.png` → `item.<name>`), when the manifest has one. */
export function itemArt(id: string, manifest: Readonly<Record<string, string>> = assets): string | null {
  const key = `item.${id.toLowerCase().replace(/[_ ]/g, '-')}`;
  return Object.hasOwn(manifest, key) ? manifest[key] : null;
}

const footnotes = (): string[] => content.bureau.forms.stall_round?.footnotes ?? [];
/** Form 14-S's example-price footnote (Ruling 5): under every chalkboard, in every mode. */
export const priceFootnote = (): string => footnotes().find((f) => /example prices/i.test(f)) ?? '*Example prices in no particular currency. Your shop will differ.';

/** What one stall shows the player now: the bank core keeps, the round, and why it may be smaller. Pure. */
export function stallPlan(
  stall: ClientStall, ctx: MarketCtx, profile: MarketProfile, table: MarketContent['seasonality'], answered: AnsweredMap,
): { variant: 'base' | 'protein_counter'; round: StallQuestion[]; dropped: number; bankSize: number; noCalendar: boolean } {
  const file = stall as StallFile;
  const { regionId, month } = seasonFor(profile, table, ctx.date);
  // Wen's seasonal round only for the player's own region (core `seasonRegionFor`): no region, no round, said plainly.
  const seasonal = file.seasonal === undefined ? [] : seasonalQuestions(file, regionId, month, table);
  const bank = stallBank(file, ctx, seasonal);
  return {
    variant: bank.variant, round: nextRound(bank.questions, answered), dropped: bank.dropped, bankSize: bank.questions.length,
    noCalendar: file.seasonal !== undefined && regionId === null,
  };
}

export interface StallScreenDeps {
  client: Pick<ApiClient, 'getProfile' | 'consents'>;
  load?: () => Promise<MarketContent>;
  progress?: () => Promise<Pick<ProgressService, 'record' | 'view'>>;
  /** Opens the Pan's health-data consent card; `onGranted` runs once it is filed. */
  askConsent?: (onGranted: () => void) => void;
}

export function stallScreen(deps: StallScreenDeps): Screen {
  const load = deps.load ?? loadMarket;
  const progress = deps.progress ?? progressService;
  const askConsent = deps.askConsent ?? askHealthConsent;
  let cleanup: (() => void) | null = null;
  let gone = false;
  return {
    title: 'Stall',
    async mount(el, route, appCtx) {
      if (route.name !== 'stall') return;
      const id: KeeperStall = route.id;
      const doc = el.ownerDocument;
      const store = appCtx.store;
      const today = localDate(appCtx.now());
      const familyTable = store.get().settings.familyTable;
      const status = statusLine('stall-status');
      const roundSlot = h('div', { class: 'stall-round-slot' });
      const heading = h('h1', { tabindex: -1 }, content.stallNames[id]);
      el.replaceChildren(heading, status.el, roundSlot);

      const [market, svc, profile] = await Promise.all([
        load().catch((err: unknown) => { console.error(err); return null; }),
        progress().catch((err: unknown) => { console.error(err); return null; }),
        profileFor(store.get(), deps.client),
      ]);
      if (gone) return;
      const back = h('p', { class: 'stall-links' }, h('a', { href: routeHref({ name: 'stalls' }) }, 'Back to the stalls'), ' · ', h('a', { href: routeHref({ name: 'market' }) }, 'The market list'));
      if (market === null) { status.show(MARKET_OFFLINE); el.append(back); return; }
      withMarket(market); // C9: the device catalogue judges this stall's rounds from here on
      const stall = market.stalls[id];
      const rules = activeRules(store.get(), graph);
      const ctx = marketCtxFor(rules.status === 'ready' ? rules.rules : null, profile, today, graph, [...content.substitutions]);
      if (ctx === null) {
        // Fail closed (Ruling 4): no question, tip, FAQ answer or keeper line until the rules can be read.
        status.show(panLine('market.stall_wait', `${id}|${today}`));
        el.append(h('p', null, h('a', { href: routeHref({ name: 'rules' }) }, 'Open Your rules')), back);
        return;
      }
      const name = keeperName(stall, ctx);
      heading.textContent = name;
      doc.title = `${name} · Kitchen Quest`;
      const file = stall as StallFile;
      const view: ProgressView | null = svc?.view() ?? null;
      const answered: AnsweredMap = new Map(Object.entries(view?.marketAnswered ?? {}));
      const plan = stallPlan(stall, ctx, profile, market.seasonality, answered);
      const form = content.bureau.forms.stall_round;

      // The keeper: portrait (decorative), the Protein Counter's own sign, and a greeting core kept for these rules.
      const portrait = stall.art === null ? null : assets[`char.${id}`] ?? null;
      const greet = pickLine(keeperLines(file, 'greet', ctx), `${id}|greet|${today}`);
      const keeper = h('section', { class: 'stall-keeper', 'aria-label': `${name} says` },
        portrait === null ? null : h('img', { class: 'stall-portrait', src: portrait, alt: '' }),
        h('div', { class: 'stall-keeper-text' },
          plan.variant === 'protein_counter' ? h('p', { class: 'stall-sign' }, 'Protein Counter') : null,
          greet === null ? null : contentText('p', greet, { class: 'stall-greeting' })));
      heading.after(...(form ? [h('p', { class: 'bureau-number' }, `PANTRY BUREAU · FORM ${form.number}`)] : []), keeper);

      // Bank states, said plainly and never which: no calendar (once), a smaller bank, an empty one.
      const notes: string[] = [];
      if (plan.noCalendar) notes.push(panLine('market.no_calendar', `${today}`));
      if (plan.dropped > 0) notes.push(panLine('market.bank_small', `${id}|${today}`));
      const note = h('div', { class: 'stall-notes' }, ...notes.map((t) => contentText('p', t, { class: 'stall-note' })));
      keeper.after(note);

      let round: RoundHandle | null = null;
      const record = (answers: RoundAnswer[]) => {
        if (svc === null) return;
        recordRound({ store, record: (events) => svc.record(events) }, id, answers, today);
      };
      const lineFor = (trigger: string) => (questionId: string) => pickLine(keeperLines(file, trigger, ctx), `${id}|${trigger}|${questionId}`);

      const startRound = () => {
        if (plan.round.length === 0) {
          roundSlot.replaceChildren(h('p', null, 'There are no questions for you at this stall today. ', h('a', { href: routeHref({ name: 'stalls' }) }, 'Visit another stall'), '.'));
          if (plan.dropped === 0) note.append(contentText('p', panLine('market.bank_small', `${id}|empty`), { class: 'stall-note' }));
          return;
        }
        round = renderRound(roundSlot, {
          questions: plan.round,
          keeper: name,
          gameName: (game) => (form?.game !== undefined && Object.hasOwn(form.game, game) ? form.game[game] : null),
          keeperLine: (trigger, q) => lineFor(trigger)(q),
          panLine: (trigger) => panLine(trigger, `${id}|${today}|${trigger}`),
          itemArt: (i) => itemArt(i),
          itemName: (i) => (graph.has(i) ? graph.get(i).name : null),
          priceFootnote: priceFootnote(),
          onEnd: (how, answers) => {
            record(answers);
            if (how === 'left') {
              noteForHub(panLine('market.leave_round', `${id}|${today}`));
              appCtx.navigate({ name: 'stalls' });
              return;
            }
            const again = h('button', { type: 'button', class: 'btn btn-primary stall-again' }, 'Another round');
            again.addEventListener('click', () => { appCtx.navigate(route as Route & { name: 'stall' }); });
            const done = contentText('p', panLine('market.round_done', `${id}|${today}`), { class: 'stall-done', tabindex: -1 });
            roundSlot.replaceChildren(done, h('div', { class: 'button-row' }, again, h('a', { class: 'btn btn-secondary', href: routeHref({ name: 'stalls' }) }, 'Back to the stalls')));
            done.focus();
          },
        });
      };

      // A Protein Counter round reveals a meat-excluding rule (Ruling 17): signed in, it needs health_data consent first.
      const needsConsent = plan.variant === 'protein_counter' && !familyTable && store.get().account !== null
        && await deps.client.consents().then((r) => !r.ok || healthConsent(r.data) !== 'granted', () => true);
      if (gone) return;
      if (needsConsent) {
        const ask = h('button', { type: 'button', class: 'btn btn-primary stall-consent' }, 'Read the health-data notice');
        ask.addEventListener('click', () => { askConsent(() => { appCtx.navigate(route as Route & { name: 'stall' }); }); });
        roundSlot.replaceChildren(h('p', null, CONSENT_NOTE), h('div', { class: 'button-row' }, ask));
      } else startRound();

      // Item tips, each rules-checked (core `tipFor`): a tip naming anything ⛔ or ❓ is left out.
      const tipIds = Object.keys(plan.variant === 'protein_counter' ? stall.variants?.protein_counter?.item_tips ?? {} : stall.item_tips);
      const tips = tipIds.flatMap((tid) => {
        const tip = graph.has(tid) ? tipFor(file, tid, ctx) : null;
        return tip === null ? [] : [h('li', { class: 'stall-tip' }, h('strong', null, contentText('span', graph.get(tid).name), ': '),
          contentText('span', tip.pick), ' ', contentText('span', tip.store))];
      });
      const extras: HTMLElement[] = [];
      if (tips.length > 0) {
        extras.push(h('details', { class: 'stall-tips' }, h('summary', null, `${name}'s tips`), h('ul', null, ...tips)));
      }
      // FAQ chips (Ruling 21): tappable written questions with rules-checked written answers. No text box, ever; none in Family Table.
      if (!familyTable) {
        const faq = faqFor(file, ctx);
        if (faq.length > 0) {
          const answer = h('div', { class: 'stall-faq-answer', 'aria-live': 'polite' });
          const chips = faq.map((f) => {
            const b = h('button', { type: 'button', class: 'btn btn-secondary stall-faq-chip' }, contentText('span', f.q));
            b.addEventListener('click', () => {
              answer.replaceChildren(h('p', null, h('span', { class: 'stall-speaker' }, `${name}: `), contentText('span', f.a)));
            });
            return h('li', null, b);
          });
          extras.push(h('section', { class: 'stall-faq', 'aria-labelledby': 'stall-faq-head' },
            h('h2', { id: 'stall-faq-head' }, `Ask ${name}`), h('ul', { class: 'stall-faq-chips' }, ...chips), answer));
        }
      }
      const otherNotes = footnotes().filter((f) => !/example prices/i.test(f));
      el.append(...extras, back, ...otherNotes.map((f) => contentText('p', f, { class: 'bureau-footnote' })));

      cleanup = () => {
        // Leaving by any other way (a link, the back button) records the answers so far, once; none, nothing.
        const r = round as RoundHandle | null;
        if (r !== null && !r.ended() && r.answers().length > 0) record(r.answers());
        round = null;
      };
    },
    unmount() { gone = true; cleanup?.(); cleanup = null; },
  };
}

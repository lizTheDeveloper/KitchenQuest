// One stall, `#/stall/<id>` (M6 Step 9, Ruling 15): the keeper's greeting, a short round of their questions, their item
// tips and their FAQ chips. Every question, tip, FAQ answer and keeper line shown is one core kept for the player's
// rules today (`stallBank`, `tipFor`, `faqFor`, `keeperLines`); nothing is shown on a guess, and rules that can't be
// read close the stall (`market.stall_wait`). A round played through, or left with an answer, records one
// `stall_round` (never in Family Table). No timer, no score, no lives; the shopping list never waits on any of it.
import {
  faqFor, keeperLines, nextRound, questionStatus, questionVariant, seasonalQuestions, stallBank, stallVariant, textMentions, tipFor,
  type AnsweredMap, type MarketCtx, type ProgressView, type StallFile, type StallQuestion,
} from '@kitchenquest/core/engine';
import assets from 'virtual:kq-assets';
import { healthConsent, type ApiClient } from '../api/client';
import { content, graph } from '../content';
import type { BureauForm, ClientStall, MarketContent } from '../content/types';
import { progressService } from '../progress';
import { withMarket } from '../progress/catalogue';
import type { ProgressService } from '../progress/service';
import { activeRules, cardInputsKey, localDate } from '../recipes/rules';
import type { Screen } from '../shell/app';
import { routeHref, type KeeperStall } from '../shell/router';
import { SCREEN_TITLES } from '../shell/titles';
import { partitionKey } from '../state/store';
import { contentText, h } from '../ui/dom';
import { askHealthConsent, statusLine } from '../week/screen-kit';
import { loadMarket } from './content';
import { recordRound } from './record';
import { renderRound, type RoundHandle } from './round-view';
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
/**
 * Whether a shown text names nothing the rules engine calls ⛔ or ❓ for this player (no substitutions), the same
 * check a question gets: every graph food its words name, through core `questionStatus`.
 */
export function safeText(text: string, ctx: MarketCtx): boolean {
  return questionStatus({ id: '', game: '', prompt: text, options: [], explain: '' }, ctx) === 'ok';
}

/**
 * The Pan's written line for a market trigger (written lines only, M5 Ruling 21), picked the same way. With the
 * player's MarketCtx, only a line naming nothing ⛔ or ❓ (fix round 1, I4: "…the strawberries still lie to me" never
 * reaches a strawberry rule); null when no line is safe (the screen then shows none). Without one (the rules can't be
 * read), only a line that names no food at all.
 */
export function panLine(trigger: string, key: string, ctx: MarketCtx | null): string | null {
  const t = Object.hasOwn(content.pan.triggers, trigger) ? content.pan.triggers[trigger] : undefined;
  if (t === undefined) throw new Error(`no written line "${trigger}" in pan.yaml`);
  const ok = t.lines.filter((l) => (ctx === null ? textMentions([l], graph).length === 0 : safeText(l, ctx)));
  return pickLine(ok, key);
}

/** An item sprite for an ingredient id (`art/items/<name>.png` → `item.<name>`), when the manifest has one. */
export function itemArt(id: string, manifest: Readonly<Record<string, string>> = assets): string | null {
  const key = `item.${id.toLowerCase().replace(/[_ ]/g, '-')}`;
  return Object.hasOwn(manifest, key) ? manifest[key] : null;
}

/** Form 14-S (the stall round), when the Bureau file has it. */
export const stallForm = (): BureauForm | undefined => (Object.hasOwn(content.bureau.forms, 'stall_round') ? content.bureau.forms.stall_round : undefined);
const footnotes = (): string[] => stallForm()?.footnotes ?? [];
/** Form 14-S's example-price footnote (Ruling 5): under every chalkboard, in every mode. */
export const priceFootnote = (): string => footnotes().find((f) => /example prices/i.test(f)) ?? '*Example prices in no particular currency. Your shop will differ.';

/**
 * Form 14-S's name for a minigame, shown only when it names nothing the rules engine calls ⛔ or ❓ for this player
 * ("The right tofu for the job" never reaches a soy rule); null otherwise, or when the form has no name for it.
 */
export function gameLabel(game: string, ctx: MarketCtx): string | null {
  const names = stallForm()?.game ?? {};
  const name = Object.hasOwn(names, game) ? names[game] : null;
  return name !== null && safeText(name, ctx) ? name : null;
}

/** What one stall shows the player now: the bank core keeps, the round, and why it may be smaller. Pure. */
export function stallPlan(
  stall: ClientStall, ctx: MarketCtx, profile: MarketProfile, table: MarketContent['seasonality'], answered: AnsweredMap,
): { variant: 'base' | 'protein_counter'; round: StallQuestion[]; dropped: number; bankSize: number; noCalendar: boolean } {
  const file: StallFile = stall;
  const { regionId, month } = seasonFor(profile, table, ctx.date);
  // Wen's seasonal round only for the player's own region (core `seasonRegionFor`): no region, no round, said plainly.
  const seasonal = file.seasonal === undefined ? [] : seasonalQuestions(file, regionId, month, table);
  const bank = stallBank(file, ctx, seasonal);
  return {
    variant: bank.variant, round: nextRound(bank.questions, answered), dropped: bank.dropped, bankSize: bank.questions.length,
    noCalendar: file.seasonal !== undefined && regionId === null,
  };
}


/**
 * Whether an answer may still be kept under the player's rules now (fix round 1, I2): the question is one this stall
 * holds, in the bank the variant uses now, and `questionStatus` calls it ✅ now. Core judges the same on the device
 * and on the server; this keeps a question the rules have just closed from being answered or recorded at all.
 */
export function stillAnswerable(stall: ClientStall, questionId: string, ctx: MarketCtx | null): boolean {
  if (ctx === null) return false;
  const file: StallFile = stall;
  const bank = questionVariant(file, questionId);
  if (bank === null || bank !== stallVariant(file, ctx)) return false;
  const all = [...file.questions, ...(file.variants?.protein_counter?.questions ?? []), ...Object.values(file.seasonal ?? {}).flatMap((m) => Object.values(m).flat())];
  const q = all.find((x) => x.id === questionId);
  return q !== undefined && questionStatus(q, ctx) === 'ok';
}

export interface StallScreenDeps {
  client: Pick<ApiClient, 'getProfile' | 'consents'>;
  load?: () => Promise<MarketContent>;
  progress?: () => Promise<Pick<ProgressService, 'record' | 'view'>>;
  /** Opens the Pan's health-data consent card; `onGranted` runs once it is filed. */
  askConsent?: (onGranted: () => void) => void;
}

const UNKEPT = "Your answers can't be kept just now, so this round earns nothing. The questions and the reasons still work.";

export function stallScreen(deps: StallScreenDeps): Screen {
  const load = deps.load ?? loadMarket;
  const progress = deps.progress ?? progressService;
  const askConsent = deps.askConsent ?? askHealthConsent;
  let cleanup: (() => void) | null = null;
  let gone = false;
  return {
    title: SCREEN_TITLES.stall,
    async mount(el, route, appCtx) {
      if (route.name !== 'stall') return;
      const id: KeeperStall = route.id;
      const doc = el.ownerDocument;
      const win = doc.defaultView;
      const store = appCtx.store;
      const heading = h('h1', { tabindex: -1 }, SCREEN_TITLES.stall);
      const status = statusLine('stall-status');
      el.replaceChildren(heading, status.el);

      const [market, svc] = await Promise.all([
        load().catch((err: unknown) => { console.error(err); return null; }),
        progress().catch((err: unknown) => { console.error(err); return null; }),
      ]);
      if (gone) return;
      const back = () => h('p', { class: 'stall-links' }, h('a', { href: routeHref({ name: 'stalls' }) }, 'Back to the stalls'), ' · ', h('a', { href: routeHref({ name: 'market' }) }, 'The market list'));
      if (market === null) { status.show(MARKET_OFFLINE); el.append(back()); return; }
      withMarket(market); // C9: the device catalogue judges this stall's rounds from here on
      const stall = market.stalls[id];
      const file: StallFile = stall;
      const form = stallForm();

      let profile: MarketProfile = { country: null, region: null };
      let profileFor_: string | null | undefined;
      let round: RoundHandle | null = null;
      /** How many of the round's answers are already recorded (a page hide records them early, M5). */
      let kept = 0;
      /**
       * M6 final I2 and M4: what the round started under. A round begun in Family Table keeps nothing even if Family
       * Table is switched off before it ends (another tab, say), so a child's answers never become the grown-up's and
       * never skip the consent card. A round belongs to the partition live when it started; another account's never
       * takes it (the stall can outlive an account switch, so this is per round, not per mount).
       */
      let roundFamilyTable = false;
      let roundPartition: string | null = null;
      /** A round dropped for an account switch: the next draw says so (M4: never silent). */
      let lost = false;
      let token = 0;

      const today = () => localDate(appCtx.now());
      const ctxNow = (): MarketCtx | null => {
        const rules = activeRules(store.get(), graph);
        return marketCtxFor(rules.status === 'ready' ? rules.rules : null, profile, today(), graph, [...content.substitutions]);
      };
      /**
       * Record the round's answers not yet kept, each re-judged under the rules now (I2); never into another partition
       * (M4), and never from a round that began, or is now, in Family Table (final I2). True when answers were dropped
       * for an account switch.
       */
      const settle = (): boolean => {
        const r = round;
        if (r === null) return false;
        const fresh = r.answers().slice(kept);
        kept = r.answers().length;
        if (fresh.length === 0 || svc === null || roundFamilyTable) return false;
        if (partitionKey(store.get()) !== roundPartition) return true;
        const c = ctxNow();
        const valid = fresh.filter((a) => stillAnswerable(stall, a.q, c));
        recordRound({ store, record: (events) => svc.record(events) }, id, valid, today(), { familyTableAtStart: roundFamilyTable });
        return false;
      };
      const endRound = () => { if (round !== null && !round.ended() && settle()) lost = true; round = null; kept = 0; };

      const draw = async () => {
        const my = ++token;
        endRound();
        // M5: the old round's buttons answer nothing while the redraw waits (profile, consent): they go inert at once.
        for (const b of el.querySelectorAll<HTMLButtonElement>('.stall-round button')) b.disabled = true;
        const account = store.get().account?.email ?? null;
        if (profileFor_ !== account) { profile = await profileFor(store.get(), deps.client); profileFor_ = account; }
        if (my !== token || gone) return;
        const date = today();
        const ctx = ctxNow();
        const familyTable = store.get().settings.familyTable;
        status.show('');
        const body: HTMLElement[] = [];
        if (ctx === null) {
          // Fail closed (Ruling 4): no question, tip, FAQ answer or keeper line until the rules can be read.
          heading.textContent = stall.name;
          status.show(panLine('market.stall_wait', `${id}|${date}`, null) ?? '');
          el.replaceChildren(heading, status.el, h('p', null, h('a', { href: routeHref({ name: 'rules' }) }, 'Open Your rules')), back());
          return;
        }
        const name = keeperName(stall, ctx);
        heading.textContent = name;
        doc.title = `${name} · Kitchen Quest`;
        const view: ProgressView | null = svc?.view() ?? null;
        const answered: AnsweredMap = new Map(Object.entries(view?.marketAnswered ?? {}));
        const plan = stallPlan(stall, ctx, profile, market.seasonality, answered);
        const say = (trigger: string, key: string) => panLine(trigger, key, ctx);

        // The keeper: portrait (decorative), the Protein Counter's own sign, and a greeting core kept for these rules.
        const portrait = stall.art === null ? null : assets[`char.${id}`] ?? null;
        const greet = pickLine(keeperLines(file, 'greet', ctx), `${id}|greet|${date}`);
        body.push(...(form ? [h('p', { class: 'bureau-number' }, `PANTRY BUREAU · FORM ${form.number}`)] : []),
          h('section', { class: 'stall-keeper', 'aria-label': `${name} says` },
            portrait === null ? null : h('img', { class: 'stall-portrait', src: portrait, alt: '' }),
            h('div', { class: 'stall-keeper-text' },
              plan.variant === 'protein_counter' ? h('p', { class: 'stall-sign' }, 'Protein Counter') : null,
              greet === null ? null : contentText('p', greet, { class: 'stall-greeting' }))));

        // Bank states, said plainly and never which: no calendar (once), a smaller bank, an empty one.
        const notes = [plan.noCalendar ? say('market.no_calendar', date) : null, plan.dropped > 0 || plan.round.length === 0 ? say('market.bank_small', `${id}|${date}`) : null];
        if ((svc === null || lost) && !familyTable) notes.push(UNKEPT); // M7, M4: said, never silent
        lost = false;
        body.push(h('div', { class: 'stall-notes' }, ...notes.filter((t): t is string => t !== null).map((t) => contentText('p', t, { class: 'stall-note' }))));
        const roundSlot = h('div', { class: 'stall-round-slot' });
        body.push(status.el, roundSlot);

        const lineFor = (trigger: string, questionId: string) => pickLine(keeperLines(file, trigger, ctx), `${id}|${trigger}|${questionId}`);
        const startRound = () => {
          if (plan.round.length === 0) {
            roundSlot.replaceChildren(h('p', null, 'There are no questions for you at this stall today. ', h('a', { href: routeHref({ name: 'stalls' }) }, 'Visit another stall'), '.'));
            return;
          }
          roundFamilyTable = store.get().settings.familyTable;
          roundPartition = partitionKey(store.get());
          round = renderRound(roundSlot, {
            questions: plan.round,
            keeper: name,
            gameName: (game) => gameLabel(game, ctx),
            keeperLine: (trigger, q) => lineFor(trigger, q),
            panLine: (trigger, q) => say(trigger, `${id}|${q}|${trigger}`),
            // I2: an answer to a question the rules closed since it was shown is refused; the stall redraws without it.
            canAnswer: (q) => {
              const ok = stillAnswerable(stall, q.id, ctxNow());
              if (!ok) void draw();
              return ok;
            },
            itemArt: (i) => itemArt(i),
            itemName: (i) => (graph.has(i) ? graph.get(i).name : null),
            priceFootnote: priceFootnote(),
            onEnd: (how) => {
              const dropped = settle();
              round = null;
              kept = 0;
              if (how === 'left') {
                const line = say('market.leave_round', `${id}|${date}`);
                if (line !== null) noteForHub(line);
                appCtx.navigate({ name: 'stalls' });
                return;
              }
              const again = h('button', { type: 'button', class: 'btn btn-primary stall-again' }, 'Another round');
              again.addEventListener('click', () => { appCtx.navigate(route); });
              const doneLine = say('market.round_done', `${id}|${date}`);
              const done = h('p', { class: 'stall-done', tabindex: -1, ...(doneLine === null ? {} : { 'data-content': '' }) }, doneLine ?? 'That is the round.');
              // The keeper's farewell, rules-checked like every keeper line (none safe → none shown).
              const bye = pickLine(keeperLines(file, 'farewell', ctx), `${id}|farewell|${date}`);
              const farewell = bye === null ? null : h('p', { class: 'stall-said' }, h('span', { class: 'stall-speaker' }, `${name}: `), contentText('span', bye));
              roundSlot.replaceChildren(done, ...(farewell ? [farewell] : []), ...(dropped ? [contentText('p', UNKEPT, { class: 'stall-note' })] : []), h('div', { class: 'button-row' }, again, h('a', { class: 'btn btn-secondary', href: routeHref({ name: 'stalls' }) }, 'Back to the stalls')));
              done.focus();
            },
          });
        };

        // A Protein Counter round reveals a meat-excluding rule (Ruling 17): signed in, it needs health_data consent first.
        const needsConsent = plan.variant === 'protein_counter' && !familyTable && store.get().account !== null
          && await deps.client.consents().then((r) => !r.ok || healthConsent(r.data) !== 'granted', () => true);
        if (my !== token || gone) return;

        // Item tips, each rules-checked (core `tipFor`): a tip naming anything ⛔ or ❓ is left out.
        const tipIds = Object.keys(plan.variant === 'protein_counter' ? stall.variants?.protein_counter?.item_tips ?? {} : stall.item_tips);
        const tips = tipIds.flatMap((tid) => {
          const tip = graph.has(tid) ? tipFor(file, tid, ctx) : null;
          return tip === null ? [] : [h('li', { class: 'stall-tip' }, h('strong', null, contentText('span', graph.get(tid).name), ': '),
            contentText('span', tip.pick), ' ', contentText('span', tip.store))];
        });
        const extras: HTMLElement[] = [];
        if (tips.length > 0) extras.push(h('details', { class: 'stall-tips' }, h('summary', null, `${name}'s tips`), h('ul', null, ...tips)));
        // FAQ chips (Ruling 21): tappable written questions with rules-checked written answers. No text box, ever; none
        // in Family Table. M3: core's fallback safety line is checked here too, so an answer naming ⛔ or ❓ drops its chip.
        if (!familyTable) {
          const faq = faqFor(file, ctx).filter((f) => safeText(f.a, ctx));
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
        el.replaceChildren(heading, ...body, ...extras, back(), ...otherNotes.map((f) => contentText('p', f, { class: 'bureau-footnote' })));
        if (needsConsent) {
          const ask = h('button', { type: 'button', class: 'btn btn-primary stall-consent' }, 'Read the health-data notice');
          ask.addEventListener('click', () => { askConsent(() => { void draw(); }); });
          roundSlot.replaceChildren(h('p', null, CONSENT_NOTE), h('div', { class: 'button-row' }, ask));
        } else startRound();
      };

      // I2: the stall re-filters live. A change to the rules, the account, Family Table or the local date ends the round
      // (its answers so far recorded, each re-judged) and redraws everything from the rules as they are now.
      const inputs = () => JSON.stringify([cardInputsKey(store.get()), store.get().settings.familyTable, today()]);
      let seen = inputs();
      const stop = store.subscribe(() => {
        const next = inputs();
        if (next === seen) return;
        seen = next;
        void draw();
      });
      // M5: closing or reloading the tab mid-round records the answers given so far, once.
      const onHide = () => { settle(); };
      win?.addEventListener('pagehide', onHide);
      cleanup = () => {
        stop();
        win?.removeEventListener('pagehide', onHide);
        token += 1;
        // Leaving by any other way (a link, the back button) records the answers so far, once; none, nothing.
        endRound();
      };
      await draw();
    },
    unmount() { gone = true; cleanup?.(); cleanup = null; },
  };
}

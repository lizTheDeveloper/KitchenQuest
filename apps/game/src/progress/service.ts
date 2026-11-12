import type { ProgressEvent, ProgressView, RewardGrant, RulesContext } from '@kitchenquest/core/engine';
import { healthConsent, type ApiClient } from '../api/client';
import { graph } from '../content';
import { getMentor } from '../mentor';
import { activeRules, localDate } from '../recipes/rules';
import { partitionKey, partitionOf, type PlayerState, type PlayerStore } from '../state/store';
import { announce } from '../ui/announce';
import { askHealthConsent } from '../week/screen-kit';
import { announceGrants, showToast } from './announce';
import { loadMarket } from '../market/content';
import { catalogueOf, rulesContextOf, withMarket } from './catalogue';
import { createProgressSync, type ProgressSync } from './sync';
import { currentProgress } from './view';

export interface ProgressService {
  /** Record events from the game's flow; the grants they earned become the Pan's lines (announce.ts). */
  record(events: ProgressEvent[]): Promise<RewardGrant[]>;
  /** What the game shows now (view.ts `currentProgress`). */
  view(): ProgressView;
  /** Called on any change to what `view()` shows. */
  subscribe(fn: () => void): () => void;
  /** The player's rules context today, or undefined while their rules can't be read (then no claim is made). */
  rulesContext(today?: string): RulesContext | undefined;
  signedIn(): void;
  readonly sync: ProgressSync;
}

/** The player's rules and content for core, or undefined while the rules can't be read ("can't verify" is never safe). */
function rulesContextFor(state: PlayerState, today: string): RulesContext | undefined {
  const r = activeRules(state, graph);
  if (r.status !== 'ready') return undefined;
  return rulesContextOf(r.rules, state.account === null ? state.localPantry : [], today);
}

export function createProgressService(deps: { client: ApiClient; store: PlayerStore; win: Window }): ProgressService {
  const { client, store, win } = deps;
  const doc = win.document;
  const cat = catalogueOf();
  const listeners = new Set<() => void>();
  const notify = () => { for (const fn of [...listeners]) fn(); };
  const today = () => localDate(new Date());

  const sync = createProgressSync({
    store, client,
    online: () => win.navigator.onLine !== false,
    context: () => rulesContextFor(store.get(), today()),
    // Fix round 1 (I1): a guest Protein Counter round joins an account only with its health_data consent; the add asks.
    healthConsent: async () => { const r = await client.consents(); return r.ok && healthConsent(r.data) === 'granted'; },
    onHeldForConsent: (retry) => { askHealthConsent(retry); },
    onWarnings: (w) => {
      // Surfaced, never fatal: a dropped stand-in claim keeps the cook's own grants (concern-3 ruling).
      console.warn('progress: set aside', w.map((x) => x.warnings.join(',')).join('; '));
    },
  });
  store.subscribe(notify);
  // C9 (M6 Step 9): the device catalogue gains `market` once the lazy market content loads. The stall screens load it
  // before they record a round; here it is fetched only when the live log already holds a stall round, so its view
  // (`marketAnswered`) is scored from the stall files. The fetch is after first paint, and the shopping list never waits on it.
  const holdsRound = (key: string | null) => partitionOf(store.get(), key).events.some((e) => e.kind === 'stall_round');
  // The guest's log too (fix round 1, I1): the add judges which of its rounds reveal a rule from the stall files.
  if (cat.market === undefined && (holdsRound(partitionKey(store.get())) || holdsRound(null))) {
    void loadMarket().then((m) => { withMarket(m); notify(); }, (err: unknown) => { console.warn('progress: the market content could not load', err); });
  }

  return {
    sync,
    async record(events) {
      const grants = await sync.record(events);
      announceGrants(grants, events, {
        say: (trigger, vars) => getMentor().say(trigger, vars).text,
        toast: (text) => showToast(doc, text, (m) => announce(doc.getElementById('announcer'), m)),
      });
      return grants;
    },
    view: () => currentProgress(store.get(), cat),
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    rulesContext: (day) => rulesContextFor(store.get(), day ?? today()),
    signedIn() { void sync.uploadDeviceLog().then(() => sync.refreshAccountView()); },
  };
}

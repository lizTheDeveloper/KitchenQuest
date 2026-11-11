import type { TurnRequest } from '@kitchenquest/core/engine';
import { createApiClient, type ApiClient } from '../api/client';
import { content, graph } from '../content';
import type { PlayerState, PlayerStore } from '../state/store';
import type { LineBank } from '../content/types';
import { reducedMotion } from '../shell/motion';
import { parseRoute } from '../shell/router';
import { createScriptedBackend, type MentorBackend } from './backend';
import { lazyBackend } from './lazy-backend';
import { localSafetyReply, scriptedWhenUnavailable } from './outage';
import { createDialogue, type Dialogue } from './dialogue';
import { createIntake, type Intake } from './intake';
import { mountMentorPanel, type MentorPanel } from './panel';
import type { PanReply } from './reply';
import { createScriptedEngine, type ScriptedEngine } from './scripted';
import { createCardWriter, type CardWriter } from './writer';

export { createDialogue } from './dialogue';
export type { MentorPanel } from './panel';

let mentor: MentorPanel | null = null;

/** What the panel's own pieces are, for the screens that share them (the rules screen writes through the same writer). */
export interface MentorServices { client: ApiClient; dialogue: Dialogue; engine: ScriptedEngine; writer: CardWriter; intake: Intake | null }
let services: MentorServices | null = null;

/** The panel's client, dialogue, engine and writer. Throws before `mountMentor`. */
export function getMentorServices(): MentorServices {
  if (!services) throw new Error('The mentor panel is not mounted yet');
  return services;
}

/** The app's single panel. Throws before `mountApp` has mounted it. */
export function getMentor(): MentorPanel {
  if (!mentor) throw new Error('The mentor panel is not mounted yet');
  return mentor;
}

/**
 * Where the line history lives. Standard mode keeps it in the player store. Family Table mode keeps nothing
 * (§19): history stays in this page's memory only and is never written.
 */
export function historyOptions(store: PlayerStore): { history: Record<string, number[]>; onHistory?: (h: Record<string, number[]>) => void } {
  const { dialogueHistory, settings } = store.get();
  if (settings.familyTable) return { history: dialogueHistory };
  return { history: dialogueHistory, onHistory: (h) => { store.update((s) => ({ ...s, dialogueHistory: h })); } };
}

/** Which backend a player gets: Family Table → scripted (§19); signed in with the AI mentor on → AI; otherwise scripted. */
export function backendKind(s: Pick<PlayerState, 'account' | 'settings'>): 'scripted' | 'ai' {
  if (s.settings.familyTable) return 'scripted';
  return s.account !== null && s.settings.aiMentor ? 'ai' : 'scripted';
}

/** What the player is looking at, for the turn request: the route name and, on a dish, its slug. */
export function screenOf(hash: string): TurnRequest['screen'] {
  const r = parseRoute(hash);
  if (r.name === 'notFound') return null;
  return r.name === 'recipe' || r.name === 'cook' ? { route: r.name, slug: r.slug } : { route: r.name };
}

/**
 * One backend the panel holds, rebuilt from the store when the account, the AI setting or Family Table changes. A
 * new AI backend starts a new conversation; a reply still on its way from the old one is shown as it arrives.
 */
export function switchingBackend(store: PlayerStore, build: (kind: 'scripted' | 'ai') => MentorBackend): MentorBackend {
  const listeners = new Set<(r: PanReply) => void>();
  const make = () => {
    const b = build(backendKind(store.get()));
    b.onLate?.((r) => { if (current === b) for (const fn of listeners) fn(r); });
    return b;
  };
  let key = '';
  const keyOf = (s: PlayerState) => `${backendKind(s)}|${s.account?.email ?? ''}`;
  let current: MentorBackend = make();
  key = keyOf(store.get());
  const stop = store.subscribe((s) => {
    const k = keyOf(s);
    if (k === key) return;
    key = k;
    // The old backend's queued retry never sends once the player turned the AI off, Family Table on, or switched account.
    current.dispose?.();
    current = make();
  });
  return {
    get kind() { return current.kind; },
    reply: (input, ctx) => current.reply(input, ctx),
    onLate(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    dispose() {
      stop();
      current.dispose?.();
      listeners.clear();
    },
  };
}

/**
 * The app's panel as one stable object: every call goes to the panel mounted now. When Family Table is turned on
 * or off (here or in another tab), the panel and everything under it is rebuilt in that mode (fix round 1, M6),
 * so a Family Table panel never has a text box and a standard one never keeps Family Table's history rules.
 */
function stablePanel(cur: () => MentorPanel): MentorPanel {
  return {
    get mode() { return cur().mode; },
    get turn() { return cur().turn; },
    open: () => { cur().open(); },
    close: () => { cur().close(); },
    isOpen: () => cur().isOpen(),
    say: (id, vars) => cur().say(id, vars),
    show: (r) => { cur().show(r); },
    onOpen: (fn) => cur().onOpen(fn),
    onCardDone: (fn) => cur().onCardDone(fn),
    setAside: (el) => { cur().setAside(el); },
    interceptText: (fn) => { cur().interceptText(fn); },
    destroy: () => { cur().destroy(); },
    clearConversation: () => { cur().clearConversation(); },
  };
}

/** Mount the panel once, with its line history kept in the player store and the backend chosen from the store. */
export function mountMentor(doc: Document, store: PlayerStore, bank: LineBank, client: ApiClient = createApiClient()): MentorPanel {
  if (mentor) return mentor;
  const win = doc.defaultView!;
  const mql = win.matchMedia('(prefers-reduced-motion: reduce)');
  const now = () => new Date();
  const root = doc.createElement('div');
  root.id = 'pan-root';
  doc.body.append(root);

  let current: { panel: MentorPanel; backend: MentorBackend; familyTable: boolean } | null = null;
  const build = () => {
    const familyTable = store.get().settings.familyTable;
    const dialogue: Dialogue = createDialogue(bank, historyOptions(store));
    const recipes = Object.entries(content.recipes).map(([slug, r]) => ({ slug, title: r.meta.title }));
    const engine: ScriptedEngine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes, now });
    const writer = createCardWriter({ client, store, dialogue, graph, ruleTerms: content.ruleTerms, now });
    const backend = switchingBackend(store, (kind) => (kind === 'ai'
      ? lazyBackend('ai', { fallback: scriptedWhenUnavailable(engine, dialogue), local: localSafetyReply(engine) }, async () => (await import('./ai-backend')).createAiBackend({
        client, engine, dialogue, store, graph, ruleTerms: content.ruleTerms, now, events: win,
        screen: () => screenOf(win.location.hash),
        intakeStep: () => { const step = store.get().intake.step; return step === 'done' ? null : step; },
      }))
      : createScriptedBackend(engine, dialogue)));
    const panel = mountMentorPanel(root, {
      mode: familyTable ? 'familyTable' : 'standard',
      backend, dialogue, writer, engine, client, forms: content.bureau.forms, store, now,
      reducedMotion: () => reducedMotion(store.get().settings.reducedMotion, mql),
      disclosure: content.bureau.disclaimers.ai_characters,
    });
    // Form 1-A starts the first time the panel opens in standard mode (§19: Family Table never starts it).
    const intake = panel.mode === 'standard'
      ? createIntake({
        panel, engine, ai: backend, store, client, dialogue, signedIn: () => store.get().account !== null,
        graph, ruleTerms: content.ruleTerms, form: content.bureau.forms.intake,
      })
      : null;
    if (intake) panel.onOpen(() => { intake.start(); });
    services = { client, dialogue, engine, writer, intake };
    current = { panel, backend, familyTable };
  };
  build();
  store.subscribe((s) => {
    if (current === null || s.settings.familyTable === current.familyTable) return;
    const wasOpen = current.panel.isOpen();
    current.panel.destroy();
    current.backend.dispose?.();
    build();
    if (wasOpen) current.panel.open();
  });
  mentor = stablePanel(() => current!.panel);
  return mentor;
}

import type { TurnRequest } from '@kitchenquest/core/engine';
import { createApiClient, type ApiClient } from '../api/client';
import { content, graph } from '../content';
import type { PlayerState, PlayerStore } from '../state/store';
import type { LineBank } from '../content/types';
import { reducedMotion } from '../shell/motion';
import { parseRoute } from '../shell/router';
import { createScriptedBackend, type MentorBackend } from './backend';
import { createChildFlag } from './child-flag';
import { lazyBackend } from './lazy-backend';
import { createLocalSafety, newConversation, scriptedWhenUnavailable, type ConversationRef } from './outage';
import { createDialogue, type Dialogue } from './dialogue';
import type { createIntake, Intake } from './intake';

/** What the lazy Form 1-A module gives (M6 Step 10): its one factory. */
export interface IntakeModule { createIntake: typeof createIntake }
import { mountMentorPanel, type MentorPanel } from './panel';
import type { PanReply } from './reply';
import { createScriptedEngine, type ScriptedEngine } from './scripted';
import { savedRules } from './saved-rules';
import { createCardWriter, type CardWriter } from './writer';
import type { WeekTurn } from './week-turn';

export { createDialogue } from './dialogue';
export type { CookVoicePort, MentorPanel } from './panel';

let mentor: MentorPanel | null = null;

/** What the panel's own pieces are, for the screens that share them (the rules screen writes through the same writer). */
/** `intake`: Form 1-A once its code has loaded (the panel's first open in standard mode), else null. */
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
export function historyOptions(store: PlayerStore): {
  history: Record<string, number[]>; onHistory?: (h: Record<string, number[]>) => void; session: () => string;
} {
  const { dialogueHistory, settings } = store.get();
  // The history is the signed-in session's: a sign-out, another account, a 401 or another tab's change starts it afresh (N4).
  const session = () => store.get().account?.email ?? '';
  if (settings.familyTable) return { history: dialogueHistory, session };
  return { history: dialogueHistory, onHistory: (h) => { store.update((s) => ({ ...s, dialogueHistory: h })); }, session };
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
function stablePanel(cur: () => MentorPanel, onClear: () => void): MentorPanel {
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
    clearConversation: () => { onClear(); cur().clearConversation(); },
    cookVoice: () => cur().cookVoice(),
  };
}

/** Mount the panel once, with its line history kept in the player store and the backend chosen from the store. */
/**
 * M6 Step 10 (coordinator ruling 1): Form 1-A's code loads when the panel first opens in standard mode, never at first
 * paint. Nothing safety-related waits on it: an emergency, medical or child text goes to the backend's own device
 * answer before any await (the panel never hands a safety text to the intake). A failed load says `intake.unavailable`
 * and the scripted Pan answers as usual; the next open tries again. `importIntake` is a test seam.
 */
export function mountMentor(
  doc: Document, store: PlayerStore, bank: LineBank, client: ApiClient = createApiClient(),
  importIntake: () => Promise<IntakeModule> = () => import('./intake'),
): MentorPanel {
  if (mentor) return mentor;
  const win = doc.defaultView!;
  const mql = win.matchMedia('(prefers-reduced-motion: reduce)');
  const now = () => new Date();
  const root = doc.createElement('div');
  root.id = 'pan-root';
  doc.body.append(root);

  let current: { panel: MentorPanel; backend: MentorBackend; familyTable: boolean; resetChild: () => void } | null = null;
  const build = () => {
    const familyTable = store.get().settings.familyTable;
    let conversation: ConversationRef | null = null;
    // m-4: ONE child flag for the panel's conversation, read by the local safety check, the scripted engine, the
    // intake and the panel. A backend switch keeps it (the conversation on screen is the same); clearing forgets it.
    const child = createChildFlag();
    const dialogue: Dialogue = createDialogue(bank, historyOptions(store));
    const recipes = Object.entries(content.recipes).map(([slug, r]) => ({ slug, title: r.meta.title }));
    // M5 Step 10 (Ruling 1): the week's turn code (plan cards, chips, the plan card's body and write) loads on first
    // use, never before first paint; the panel starts loading it when it opens.
    let weekTurn: Promise<WeekTurn> | null = null;
    const week = (): Promise<WeekTurn> => {
      weekTurn ??= import('./week-turn').then((m) => m.createWeekTurn({
        store, client, now, dialogue, recipes, cooks: Object.fromEntries(Object.entries(content.cooks).map(([id, c]) => [id, c.name])),
      }), (err: unknown) => { weekTurn = null; throw err; });
      return weekTurn;
    };
    const engine: ScriptedEngine = createScriptedEngine({
      dialogue, graph, ruleTerms: content.ruleTerms, recipes, now, savedRules: () => savedRules(store.get()), child, week,
    });
    const writer = createCardWriter({ client, store, dialogue, graph, ruleTerms: content.ruleTerms, now, conversationId: () => conversation?.id, week });
    const backend = switchingBackend(store, (kind) => {
      if (kind !== 'ai') return createScriptedBackend(engine);
      // A new AI backend is a new server conversation: its own server id. The child flag is the panel's (m-4).
      const ref: ConversationRef = { id: null };
      const intakeStep = () => { const step = store.get().intake.step; return step === 'done' ? null : step; };
      const screen = () => screenOf(win.location.hash);
      const mine = createLocalSafety({ dialogue, graph, child });
      conversation = ref;
      return lazyBackend('ai', { fallback: scriptedWhenUnavailable(engine, dialogue), local: (i, c) => mine.reply(i, c) }, async () => (await import('./ai-backend')).createAiBackend({
        client, engine, dialogue, store, graph, ruleTerms: content.ruleTerms, now, events: win, screen, intakeStep, conversation: ref,
      }));
    });
    const panel = mountMentorPanel(root, {
      week, conversationId: () => conversation?.id ?? null,
      mode: familyTable ? 'familyTable' : 'standard',
      backend, dialogue, writer, engine, client, forms: content.bureau.forms, store, now, child,
      reducedMotion: () => reducedMotion(store.get().settings.reducedMotion, mql),
      disclosure: content.bureau.disclaimers.ai_characters,
    });
    // Form 1-A starts the first time the panel opens in standard mode (§19: Family Table never starts it), its code
    // loaded then (lazy). Its `start()` is a no-op once begun or done, so a later open just shows it again.
    let intake: Promise<Intake> | null = null;
    if (panel.mode === 'standard') {
      panel.onOpen(() => {
        const startedFor = current?.panel;
        // Form 1-A never cuts into a conversation already under way: if the player spoke while its code was loading,
        // it waits for the next open (its lines never land after the Pan's answer to what they said).
        const turnAtOpen = panel.turn;
        intake ??= importIntake().then((m) => {
          const made = m.createIntake({
            panel, engine, ai: backend, store, client, dialogue, signedIn: () => store.get().account !== null,
            graph, ruleTerms: content.ruleTerms, form: content.bureau.forms.intake, child,
          });
          if (services) services.intake = made;
          return made;
        });
        // Fix round 1 (I1, m-4/C-1): a conversation a child has spoken in gets no interview and no failure line,
        // only the grown-up line it already had; the flag is read when the code lands, never when the open began.
        intake.then((i) => { if (current?.panel === startedFor && panel.turn === turnAtOpen && !child.on) i.start(); }, (err: unknown) => {
          console.error(err);
          intake = null;
          // Only a player the interview would have met hears it (it starts only until Form 1-A is done).
          if (current?.panel === startedFor && store.get().intake.step !== 'done' && !child.on) panel.say('intake.unavailable');
        });
      });
    }
    // Preload the week's code when the panel opens, and read the signed-in week once (M3), so a plan turn rarely waits.
    panel.onOpen(() => { void week().then((w) => w.prefetch()).catch((err: unknown) => { console.error(err); }); });
    services = { client, dialogue, engine, writer, intake: null };
    // Clearing is a new conversation on both sides: no server id, no child flag (fix round 4, G4).
    current = { panel, backend, familyTable, resetChild: () => { child.reset(); if (conversation) newConversation(conversation); } };
  };
  build();
  // Ruling 17's report (family-report.ts) loads lazily, off first paint; the device refuses the microphone in Family
  // Table on its own meanwhile, so nothing waits on it.
  void import('./family-report').then((m) => { m.reportFamilyTable(store, client); }).catch((err: unknown) => { console.error(err); });
  store.subscribe((s) => {
    if (current === null || s.settings.familyTable === current.familyTable) return;
    const wasOpen = current.panel.isOpen();
    current.panel.destroy();
    current.backend.dispose?.();
    build();
    if (wasOpen) current.panel.open();
  });
  mentor = stablePanel(() => current!.panel, () => { current?.resetChild(); });
  return mentor;
}

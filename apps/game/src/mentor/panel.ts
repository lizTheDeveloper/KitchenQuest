import { classifyTurn, stripPageEvents, type CardAction, type ProposalCard, type Severity, type TrailEntry } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { BureauForm } from '../content/types';
import { routeHref } from '../shell/router';
import type { PlayerStore } from '../state/store';
import { typeInto } from '../ui/dialogue-box';
import { h } from '../ui/dom';
import type { MentorBackend, MentorInput } from './backend';
import { CLOSED_TEXT, closeCard, renderCard, renderTrail, setCardNote } from './cards-view';
import { renderConsentCard } from './consent-card';
import type { Dialogue, Said, Vars } from './dialogue';
import type { CardView, ConsentAnswer, LocalIntent, PanItem, PanReply, TurnContext } from './reply';
import type { ScriptedEngine } from './scripted';
import type { CardWriter, UndoOutcome, WriteOutcome } from './writer';

/** The panel keeps the last this-many bubbles; older ones are removed so a long session can't grow without end. */
export const MAX_BUBBLES = 50;
export const THINKING_TEXT = 'The Pan is thinking…';
export const NOT_SAVED_TEXT = "That didn't go through, so nothing was saved. Tap the button again to try again.";
export const REJECT_FAILED_TEXT = "That didn't go through, so the card is still open. Tap 'Not quite' again to turn it down.";
const UNDO_FAILED_TEXT = "That didn't go through, so nothing was undone. Tap Undo to try again.";
const CONSENT_UNAVAILABLE_TEXT = "The permission form couldn't load just now. Nothing has changed.";
const CONSENT_FAILED_TEXT = "That didn't go through. Nothing has changed. Tap 'I agree' to try again.";
const CONSENT_DONE_TEXT = 'Permission filed. Thank you.';
/** The footnote on a rule card a signed-out player would stamp: it is written to this device only (Step 11). */
export const DEVICE_ONLY_FOOTNOTE = '*Kept on this device only.';
const DISCLOSURE_OK = 'Got it';
/**
 * Text the Pan answers on the device at once, whatever else is going on (outage.ts createLocalSafety): it is sent even
 * while another turn is still waiting, so an emergency can never be held up by a slow or stuck turn (fix round 5, H1).
 */
const SAFETY_INTENTS: ReadonlySet<string> = new Set(['emergency', 'medical', 'child']);
export const isSafetyText = (text: string): boolean => SAFETY_INTENTS.has(classifyTurn(stripPageEvents(text).text.trim()));
/** How long the stamp lands before a card turns into its trail entry (motion on). */
const STAMP_MS = 650;

export type MentorMode = 'standard' | 'familyTable';
export interface MentorPanel {
  readonly mode: MentorMode;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Add a scripted Pan bubble. Scenes call this in every mode. */
  say(id: string, vars?: Vars): Said;
  /** Show a reply that didn't come from a typed turn (the intake interview, Step 11). Family Table: never cards (§19). */
  show(reply: PanReply): void;
  /** The current Pan turn number. */
  readonly turn: number;
  /** Called each time the panel opens, after the AI disclosure (Step 11 starts the intake here). Returns the unsubscribe. */
  onOpen(fn: () => void): () => void;
  /** Called when a card in the panel is stamped or turned down (the intake follows its own cards this way). */
  onCardDone(fn: (view: CardView, result: 'confirmed' | 'rejected') => void): () => void;
  /** A standing element above the conversation (the Form 1-A checklist), or null to remove it. */
  setAside(el: HTMLElement | null): void;
  /** Typed text goes to `fn` first; when it returns null the backend answers as usual. Null removes it. */
  interceptText(fn: ((text: string, ctx: TurnContext) => Promise<PanReply> | null) | null): void;
  /** Takes the panel out of the page and drops every listener it added (a remount when Family Table changes). */
  destroy(): void;
  /**
   * Remove everything shown in the conversation: bubbles, cards, trail entries (Step 11 fix round 2: after the player's
   * health details are deleted, none of them stays on screen). The pinned disclosure stays until acknowledged.
   */
  clearConversation(): void;
}

interface OpenCard { view: CardView; el: HTMLElement; li: HTMLElement }
interface Trail { entry: TrailEntry; card: ProposalCard; li: HTMLElement }

const keyOf = (c: CardView) => (c.origin === 'server' ? `server:${c.proposalId}` : `local:${c.localId}`);

export function mountMentorPanel(root: HTMLElement, opts: {
  mode: MentorMode; backend: MentorBackend; dialogue: Dialogue; writer: CardWriter; engine: ScriptedEngine; client: ApiClient;
  forms: Record<string, BureauForm>; store: PlayerStore; reducedMotion: () => boolean; now: () => Date;
  /** C-16, verbatim: shown once as a notice the first time the panel opens in standard mode (`aiDisclosureSeen`). */
  disclosure?: string;
}): MentorPanel {
  // Spec §19: in Family Table mode children never reach the AI. Refuse before touching the DOM.
  if (opts.mode === 'familyTable' && opts.backend.kind !== 'scripted') {
    throw new Error('Family Table mode requires the scripted backend');
  }
  const { mode, backend, dialogue, writer, engine, client, forms, store } = opts;
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const opener = doc.getElementById('pan-button');
  const standard = mode === 'standard';

  // Focusable and named so a keyboard can scroll a long conversation (axe: scrollable-region-focusable).
  const bubbles = h('ol', { class: 'bubbles', 'aria-live': 'polite', tabindex: 0, 'aria-label': 'Conversation with the Pan' });
  const status = h('p', { class: 'pan-status', role: 'status' });
  const closeBtn = h('button', { type: 'button', class: 'btn btn-secondary pan-close' }, 'Close');
  const panel = h('aside', { id: 'pan-panel', class: 'pan-panel', role: 'dialog', 'aria-labelledby': 'pan-title', hidden: true },
    h('div', { class: 'pan-head' },
      h('span', { class: 'pan-portrait', 'aria-hidden': 'true' }, '🍳'),
      h('h2', { id: 'pan-title' }, 'The Pan'),
      closeBtn),
    bubbles,
    status,
  );
  const asideSlot = h('div', { class: 'pan-aside' });
  asideSlot.hidden = true;
  bubbles.before(asideSlot);
  const openListeners = new Set<() => void>();
  const doneListeners = new Set<(view: CardView, result: 'confirmed' | 'rejected') => void>();
  const cardDone = (view: CardView, result: 'confirmed' | 'rejected') => { for (const fn of [...doneListeners]) fn(view, result); };
  let intercept: ((text: string, ctx: TurnContext) => Promise<PanReply> | null) | null = null;

  let talkBtn: HTMLButtonElement | null = null;
  let textBox: HTMLTextAreaElement | null = null;
  let open = false;
  let turn = 0;
  /** Turns still waiting for their reply (more than one only when a safety text was sent meanwhile). */
  let pendingTurns = 0;
  let pending = false;
  /**
   * Moves on with every clearConversation: a reply, a card write or an undo that started before the clear is dropped
   * when it lands, so nothing of the cleared conversation comes back on screen (fix round 5, H2).
   */
  let epoch = 0;
  /** Set by `destroy()`: a reply (scripted or AI) that lands later is dropped, never drawn into a detached panel. */
  let destroyed = false;
  const cards = new Map<string, OpenCard>();
  /** Cards whose write or turn-down is in flight: a typed yes or no meanwhile is ignored (the tap answers). */
  const busyCards = new Set<string>();
  const trail: Trail[] = [];

  const scrollDown = () => { bubbles.scrollTop = bubbles.scrollHeight; };
  /** Removes the oldest items past MAX_BUBBLES; a card or trail entry that goes with them is no longer open. */
  const trim = () => {
    // The pinned C-16 disclosure (fix round 1, M5) is not one of the bubbles: it stays until "Got it".
    const pinned = () => (bubbles.firstElementChild?.classList.contains('pan-disclosure-item') ? 1 : 0);
    while (bubbles.children.length - pinned() > MAX_BUBBLES) {
      const gone = bubbles.children[pinned()];
      gone.remove();
      for (const [k, c] of cards) if (c.li === gone) cards.delete(k);
      for (let i = trail.length - 1; i >= 0; i--) if (trail[i].li === gone) trail.splice(i, 1);
    }
  };
  const addLi = (cls: string, ...children: Node[]): HTMLElement => {
    const li = h('li', { class: cls }, ...children);
    bubbles.append(li);
    trim();
    scrollDown();
    return li;
  };

  const typers = new WeakMap<Element, { finish(): void }>();
  const addBubble = (who: 'pan' | 'you', text: string): void => {
    const body = h('span', { class: 'bubble-text' });
    addLi(`bubble ${who}`, body);
    if (who === 'pan') {
      body.setAttribute('data-content', '');
      typers.set(body, typeInto(body, text, opts.reducedMotion()));
    } else {
      body.textContent = text;
    }
    scrollDown();
  };
  // Click a typing bubble to show the rest of it.
  bubbles.addEventListener('click', (ev) => {
    const body = (ev.target as Element).closest('.bubble-text');
    if (body) typers.get(body)?.finish();
  });
  const sayLine = (id: string, vars?: Vars): Said => {
    const said = dialogue.say(id, vars);
    addBubble('pan', said.text);
    return said;
  };

  const liveTrail = () => trail.filter((t) => opts.now().getTime() <= Date.parse(t.entry.undoUntil));
  const context = (): TurnContext => {
    const s = store.get();
    const step = s.intake.step;
    return {
      turn, openCards: [...cards.values()].map((c) => c.view), intakeStep: step === 'done' ? null : step,
      signedIn: s.account !== null, trail: liveTrail().map((t) => t.entry),
    };
  };

  // --- Cards ---------------------------------------------------------------------------------------------------

  function addCard(view: CardView): void {
    const deviceOnly = view.origin === 'local' && view.card.kind === 'rule' && store.get().account === null;
    let el: HTMLElement;
    try {
      el = renderCard(view, {
        forms, now: opts.now, ...(deviceOnly ? { footnote: DEVICE_ONLY_FOOTNOTE } : {}),
        onConfirm: (edits) => confirm(view, 'tap', edits),
        onReject: () => reject(view),
      });
    } catch (err) {
      // A card that can't be drawn is never half-shown: it is dropped, and the Pan says it didn't follow.
      console.error(err);
      sayLine('didnt_understand');
      return;
    }
    const li = addLi('pan-item pan-card-item', el);
    cards.set(keyOf(view), { view, el, li });
  }

  /** A card that was written becomes its trail entry, after the stamp lands (skipped with reduced motion). */
  async function toTrail(key: string, entry: TrailEntry): Promise<void> {
    const c = cards.get(key);
    if (c === undefined) return;
    cards.delete(key);
    if (!opts.reducedMotion()) {
      c.el.classList.add('is-stamping');
      await new Promise((r) => setTimeout(r, STAMP_MS));
    }
    const hadFocus = c.li.contains(doc.activeElement);
    addTrail(entry, c.view.card, c.li);
    // The pressed button is gone: focus stays in the same place in the panel, on the entry text that replaced it.
    if (hadFocus) (c.li.querySelector<HTMLElement>('.trail-text') ?? textBox ?? closeBtn).focus();
  }

  /** A card element that leaves the panel takes no focus with it. */
  const removeLi = (li: HTMLElement) => {
    const hadFocus = li.contains(doc.activeElement);
    li.remove();
    if (hadFocus) (textBox ?? closeBtn).focus();
  };

  function addTrail(entry: TrailEntry, card: ProposalCard, li: HTMLElement): void {
    const t: Trail = { entry, card, li };
    const el = renderTrail(entry, { now: opts.now, onUndo: async () => { await undo(t); }, onEdit: () => edit(t) });
    li.className = 'pan-item pan-trail-item';
    li.replaceChildren(el);
    trail.push(t);
  }

  function dropTrail(t: Trail): void {
    const i = trail.indexOf(t);
    if (i >= 0) trail.splice(i, 1);
    removeLi(t.li);
  }

  async function confirm(view: CardView, via: 'tap' | 'typed_yes', edits?: { severity?: Severity }): Promise<void> {
    const key = keyOf(view);
    const c = cards.get(key);
    if (c === undefined || busyCards.has(key)) return;
    let out: WriteOutcome;
    busyCards.add(key);
    try {
      out = await writer.confirm(view, via, edits);
    } catch (err) {
      console.error(err);
      out = { ok: false, reason: 'network', items: [] };
    } finally {
      busyCards.delete(key);
    }
    if (cards.get(key) !== c) return; // cleared meanwhile
    // Another confirm of this card is answering (fix round 1, I1): nothing to show here.
    if (!out.ok && out.reason === 'busy') return;
    if (out.ok) {
      await toTrail(key, out.trail);
      renderItems(out.items, []);
      // Carry from Step 2: the intake follow-up only after a confirmed write.
      if (view.card.kind === 'rule' && store.get().intake.step === 'allergies') sayLine('intake.allergies.followup');
      cardDone(view, 'confirmed');
      return;
    }
    // A failed write is never silent (Step 9 carry): a scripted line, and a way to try again.
    const said = out.items.length > 0 ? out.items : [{ kind: 'said', said: dialogue.say('write.not_done') } satisfies PanItem];
    switch (out.reason) {
      case 'busy':
        return;
      case 'tap_required':
      case 'consent_required':
        renderItems(out.items, []);
        return;
      case 'network':
        setCardNote(c.el, NOT_SAVED_TEXT);
        renderItems(said, []);
        return;
      case 'closed':
      case 'invalid':
      case 'needs_account':
        cards.delete(key);
        closeCard(c.el, CLOSED_TEXT);
        renderItems(said, []);
        return;
    }
  }

  async function reject(view: CardView): Promise<void> {
    const key = keyOf(view);
    const c = cards.get(key);
    if (c === undefined || busyCards.has(key)) return;
    busyCards.add(key);
    let items: PanItem[];
    try {
      items = await writer.reject(view);
    } catch (err) {
      console.error(err);
      items = [];
    } finally {
      busyCards.delete(key);
    }
    if (cards.get(key) !== c) return; // cleared meanwhile
    if (items.length === 0) { setCardNote(c.el, REJECT_FAILED_TEXT); return; }
    cards.delete(key);
    removeLi(c.li);
    renderItems(items, []);
    cardDone(view, 'rejected');
  }

  async function undo(t: Trail): Promise<UndoOutcome> {
    let out: UndoOutcome;
    const startedIn = epoch;
    try {
      out = await writer.undo(t.entry);
    } catch (err) {
      console.error(err);
      out = { status: 'failed', items: [] };
    }
    if (out.status === 'busy' || startedIn !== epoch) return out;
    // Carry from Step 8 fix round 1: drop the entry only when it was undone, or there is nothing left to undo.
    if (out.status === 'undone' || out.status === 'nothing') dropTrail(t);
    const note = t.li.querySelector<HTMLElement>('.trail-entry');
    if (out.status === 'failed' && note) setCardNote(note, UNDO_FAILED_TEXT);
    renderItems(out.items, []);
    return out;
  }

  /** §7.0 "tap it to edit or undo" (pre-flight C24). */
  async function edit(t: Trail): Promise<void> {
    if (t.entry.kind === 'rule') { if (win) win.location.hash = routeHref({ name: 'rules' }); return; }
    if (opts.now().getTime() > Date.parse(t.entry.undoUntil)) {
      if (t.entry.kind === 'profile' && win) win.location.hash = routeHref({ name: 'settings' });
      return;
    }
    const out = await undo(t);
    if (out.status !== 'undone') return;
    // The same card again, built from the confirmed values, as a new local card (a server card's row ids are stale now).
    const card: ProposalCard = t.card.kind === 'pantry' ? { kind: 'pantry', add: t.card.add, remove: t.card.remove, summary: t.card.summary, readback: t.card.readback } : t.card;
    const view: CardView = { origin: 'local', localId: crypto.randomUUID(), card, issuedTurn: turn };
    render({ items: card.readback.map((l) => ({ kind: 'said', said: dialogue.say(l.trigger, l.vars) })), cards: [view], intents: [], actions: [], notice: null });
  }

  function applyAction(a: CardAction): void {
    switch (a.kind) {
      case 'confirmed': {
        const c = cards.get(`server:${a.proposalId}`);
        void toTrail(`server:${a.proposalId}`, a.trail);
        if (c) cardDone(c.view, 'confirmed');
        return;
      }
      case 'rejected': {
        const c = cards.get(`server:${a.proposalId}`);
        if (c) { cards.delete(`server:${a.proposalId}`); removeLi(c.li); cardDone(c.view, 'rejected'); }
        return;
      }
      case 'undone': {
        const t = trail.find((x) => x.entry.origin === 'server' && x.entry.id === a.id);
        if (t) dropTrail(t);
        return;
      }
    }
  }

  async function runIntent(i: LocalIntent): Promise<void> {
    if (i.kind === 'undo') {
      const newest = liveTrail().at(-1);
      if (newest === undefined) { sayLine('undo.nothing'); return; }
      await undo(newest);
      return;
    }
    const c = cards.get(`local:${i.localId}`);
    // A typed yes or no while this card's tap is in flight is ignored: the tap answers (fix round 1, I1).
    if (c === undefined || busyCards.has(`local:${i.localId}`)) return;
    if (i.kind === 'confirm') await confirm(c.view, 'typed_yes');
    else await reject(c.view);
  }

  // --- Items ---------------------------------------------------------------------------------------------------

  function renderConsent(purpose: 'health_data' | 'ai_health', onAnswer?: (answer: ConsentAnswer) => void): void {
    const li = addLi('pan-item pan-consent-item');
    void client.consents().then((r) => {
      if (destroyed) return; // nobody saw this card: it is not "offered" (aiHealthOffered stays false)
      const notice = r.ok ? r.data.notices[purpose] : undefined;
      const form = forms[purpose === 'ai_health' ? 'consent_ai' : 'consent_health'] as BureauForm | undefined;
      if (notice === undefined || form === undefined) {
        li.replaceChildren(h('p', { class: 'pan-note', role: 'status' }, CONSENT_UNAVAILABLE_TEXT));
        // Couldn't load is not a no (fix round 1, I1): whoever asked keeps the question open.
        onAnswer?.('unavailable');
        return;
      }
      const el = renderConsentCard(purpose, {
        form, notice,
        onAgree: async () => {
          const g = await client.grantConsent(purpose, notice.version);
          if (g.ok) {
            li.replaceChildren(h('p', { class: 'pan-note', role: 'status' }, CONSENT_DONE_TEXT));
            if (doc.activeElement === doc.body) (textBox ?? closeBtn).focus();
            onAnswer?.('granted');
          } else setCardNote(el, CONSENT_FAILED_TEXT);
        },
        // Saying no costs nothing: play goes on.
        onDecline: () => { removeLi(li); onAnswer?.('declined'); },
      });
      li.replaceChildren(el);
      // The ai_health card is offered once ever, counted only when it is actually on screen (fix round 1, M5).
      if (purpose === 'ai_health' && !store.get().aiHealthOffered) store.update((s) => ({ ...s, aiHealthOffered: true }));
    });
  }

  function renderQuick(item: Extract<PanItem, { kind: 'quick' }>): void {
    const buttons = item.options.map((o) => h('button', { type: 'button', class: 'btn btn-secondary pan-quick' }, o.label));
    const li = addLi('pan-item pan-quick-item', h('div', { class: 'button-row', role: 'group', 'aria-label': item.label }, ...buttons));
    buttons.forEach((b, n) => b.addEventListener('click', () => {
      if (pending) return;
      for (const x of buttons) x.disabled = true;
      const hadFocus = li.contains(doc.activeElement);
      const o = item.options[n];
      addBubble('you', o.label);
      void turnWith((ctx) => item.onPick(o.value, ctx)).then(() => { if (hadFocus) (textBox ?? closeBtn).focus(); });
    }));
  }

  function renderChoices(item: Extract<PanItem, { kind: 'choices' }>): void {
    const buttons = item.options.map((o) => h('button', { type: 'button', class: 'btn btn-secondary' }, o.name));
    addLi('pan-item pan-choices', h('div', { class: 'button-row', role: 'group', 'aria-label': 'Which one do you mean?' }, ...buttons));
    buttons.forEach((b, n) => b.addEventListener('click', () => {
      for (const x of buttons) x.disabled = true;
      const view = engine.cardFromChoice(item.options[n].id, item.severity, turn);
      render({ items: view.card.readback.map((l) => ({ kind: 'said', said: dialogue.say(l.trigger, l.vars) })), cards: [view], intents: [], actions: [], notice: null });
    }));
  }

  function renderItems(items: readonly PanItem[], replyCards: readonly CardView[]): void {
    for (const item of items) {
      switch (item.kind) {
        case 'said': {
          addBubble('pan', item.said.text);
          // Carry from Step 2: a severe read-back that asks "Is that right?" is followed by the tap line, so a typed
          // yes is never invited for it (and the engine never accepts one).
          if (item.said.trigger === 'rule.readback' && /\?\s*$/.test(item.said.text)) {
            const severe = replyCards.flatMap((c) => (c.card.kind === 'rule' && c.card.severe ? [c.card] : []));
            const card = severe.find((c) => item.said.text.includes(c.display.spelled)) ?? severe.at(0);
            if (card) sayLine('rule.tap_needed', { ingredient: card.display.ingredient });
          }
          break;
        }
        case 'choices': renderChoices(item); break;
        case 'consent': renderConsent(item.purpose, item.onAnswer); break;
        case 'quick': renderQuick(item); break;
        case 'rules_error':
          addLi('pan-item pan-rules-error', h('div', { class: 'rules-error', role: 'note' },
            h('p', null, item.message), h('p', null, h('a', { href: item.href, class: 'rules-error-link' }, 'Open Your rules'))));
          break;
        case 'retry': {
          const btn = h('button', { type: 'button', class: 'btn btn-secondary pan-retry' }, 'Try again');
          const li = addLi('pan-item pan-retry-item', btn);
          const text = item.text;
          btn.addEventListener('click', () => {
            if (pending) return;
            li.remove();
            addBubble('you', text);
            void reply({ kind: 'text', text });
          });
          break;
        }
      }
    }
  }

  function render(r: PanReply): void {
    if (destroyed) return;
    let { items, cards: replyCards, intents, actions } = r;
    if (!standard) {
      // §19: Family Table is scripted lines only. Nothing is written, offered or kept.
      if (replyCards.length > 0) {
        if (!import.meta.env.PROD) throw new Error('Family Table mode shows no cards (§19)');
        replyCards = [];
      }
      items = items.filter((i) => i.kind === 'said');
      intents = [];
      actions = [];
    }
    renderItems(items, replyCards);
    for (const c of replyCards) addCard(c);
    for (const a of actions) applyAction(a);
    for (const i of intents) void runIntent(i);
  }

  const setPending = (on: boolean) => {
    pendingTurns += on ? 1 : -1;
    pending = pendingTurns > 0;
    // Send stays enabled: a safety text can always go (the submit holds back anything else while a turn waits).
    if (pending) bubbles.setAttribute('aria-busy', 'true'); else bubbles.removeAttribute('aria-busy');
    status.textContent = pending ? THINKING_TEXT : '';
  };

  /** One Pan turn: bump the turn, show that the Pan is thinking, render the reply (never silent on a throw). */
  const turnWith = async (get: (ctx: TurnContext) => Promise<PanReply>): Promise<void> => {
    turn++;
    setPending(true);
    const startedIn = epoch;
    let r: PanReply;
    try {
      r = await get(context());
    } catch (err) {
      console.error(err);
      r = { items: [{ kind: 'said', said: dialogue.say('mentor.ai_unavailable') }], cards: [], intents: [], actions: [], notice: null };
    } finally {
      setPending(false);
    }
    if (startedIn !== epoch) return; // the conversation was cleared while this turn was on its way
    render(r);
  };
  const reply = (input: MentorInput): Promise<void> => turnWith((ctx) => {
    const intercepted = input.kind === 'text' && intercept ? intercept(input.text, ctx) : null;
    return intercepted ?? backend.reply(input, ctx);
  });

  /** C-16: the AI disclosure, once ever, the first time the panel opens in standard mode. A plain notice, not a Pan line. */
  let disclosureShown = false;
  const showDisclosure = () => {
    if (!standard || disclosureShown || opts.disclosure === undefined || store.get().aiDisclosureSeen) return;
    disclosureShown = true;
    const ok = h('button', { type: 'button', class: 'btn btn-secondary pan-disclosure-ok' }, DISCLOSURE_OK);
    const box = h('div', { class: 'pan-disclosure', role: 'note' }, h('p', { 'data-content': '' }, opts.disclosure), ok);
    // Pinned first in the conversation; MAX_BUBBLES never trims it before "Got it".
    const li = h('li', { class: 'pan-item pan-disclosure-item' }, box);
    bubbles.prepend(li);
    ok.addEventListener('click', () => {
      store.update((s) => ({ ...s, aiDisclosureSeen: true }));
      const hadFocus = li.contains(doc.activeElement);
      li.remove(); // Settings → The Pan shows the same words, always
      if (hadFocus) (textBox ?? closeBtn).focus();
    });
  };
  const stopLate = backend.onLate?.((r) => { render(r); });

  if (standard) {
    textBox = h('textarea', { id: 'pan-text', rows: 2, maxlength: 500, class: 'pan-text' });
    const sendBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send');
    const form = h('form', { class: 'pan-form' },
      h('label', { for: 'pan-text' }, 'Say something to the Pan'),
      textBox,
      sendBtn,
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = textBox!.value.trim();
      if (!text) return;
      // While a turn is waiting, only a safety text goes ahead (answered at once, on the device); anything else stays in the box.
      if (pending && !isSafetyText(text)) return;
      textBox!.value = '';
      addBubble('you', text);
      void reply({ kind: 'text', text });
    });
    // Enter sends the message; it never reaches a card button (they are outside this form, type="button").
    textBox.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); form.requestSubmit(); }
    });

    talkBtn = h('button', { id: 'pan-talk', type: 'button', class: 'btn btn-secondary', 'aria-pressed': 'false' }, 'Hold to talk');
    const talk = talkBtn;
    const press = () => {
      if (talk.getAttribute('aria-pressed') === 'true') return;
      talk.setAttribute('aria-pressed', 'true');
      talk.textContent = 'Listening…';
    };
    const release = () => {
      if (talk.getAttribute('aria-pressed') !== 'true') return;
      talk.setAttribute('aria-pressed', 'false');
      talk.textContent = 'Hold to talk';
      void reply({ kind: 'voice' });
    };
    talk.addEventListener('pointerdown', press);
    talk.addEventListener('pointerup', release);
    talk.addEventListener('pointerleave', release);
    talk.addEventListener('pointercancel', release);
    talk.addEventListener('blur', release);
    talk.addEventListener('keydown', (ev) => {
      if (ev.key !== ' ' && ev.key !== 'Enter') return;
      ev.preventDefault();
      if (!ev.repeat) press();
    });
    talk.addEventListener('keyup', (ev) => {
      if (ev.key !== ' ' && ev.key !== 'Enter') return;
      ev.preventDefault();
      release();
    });
    panel.append(form, h('div', { class: 'pan-talk-row' }, talkBtn));
  }

  const onDocKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') api.close(); };
  const api: MentorPanel = {
    mode,
    get turn() { return turn; },
    open() {
      if (open) return;
      open = true;
      panel.hidden = false;
      opener?.setAttribute('aria-expanded', 'true');
      doc.addEventListener('keydown', onDocKey);
      (textBox ?? closeBtn).focus();
      showDisclosure();
      for (const fn of [...openListeners]) fn();
    },
    close() {
      if (!open) return;
      open = false;
      panel.hidden = true;
      opener?.setAttribute('aria-expanded', 'false');
      doc.removeEventListener('keydown', onDocKey);
      opener?.focus();
    },
    isOpen: () => open,
    say: sayLine,
    show: render,
    onOpen(fn) { openListeners.add(fn); return () => { openListeners.delete(fn); }; },
    onCardDone(fn) { doneListeners.add(fn); return () => { doneListeners.delete(fn); }; },
    setAside(el) {
      asideSlot.replaceChildren(...(el ? [el] : []));
      asideSlot.hidden = el === null;
    },
    interceptText(fn) { intercept = standard ? fn : null; },
    clearConversation() {
      epoch++;
      const hadFocus = bubbles.contains(doc.activeElement);
      for (const li of [...bubbles.children]) if (!li.classList.contains('pan-disclosure-item')) li.remove();
      cards.clear();
      busyCards.clear();
      trail.splice(0, trail.length);
      if (hadFocus && open) (textBox ?? closeBtn).focus();
    },
    destroy() {
      destroyed = true;
      doc.removeEventListener('keydown', onDocKey);
      opener?.removeEventListener('click', onOpener);
      stopLate?.();
      openListeners.clear();
      doneListeners.clear();
      intercept = null;
      panel.remove();
    },
  };

  closeBtn.addEventListener('click', () => api.close());
  const onOpener = () => { if (open) api.close(); else api.open(); };
  if (opener) {
    opener.setAttribute('aria-expanded', 'false');
    opener.setAttribute('aria-controls', 'pan-panel');
    opener.addEventListener('click', onOpener);
  }
  root.append(panel);
  return api;
}

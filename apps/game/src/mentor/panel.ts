import type { CardAction, ProposalCard, Severity, TrailEntry } from '@kitchenquest/core/engine';
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
import type { CardView, LocalIntent, PanItem, PanReply, TurnContext } from './reply';
import type { ScriptedEngine } from './scripted';
import type { CardWriter, UndoOutcome, WriteOutcome } from './writer';

/** The panel keeps the last this-many bubbles; older ones are removed so a long session can't grow without end. */
export const MAX_BUBBLES = 50;
export const THINKING_TEXT = 'The Pan is thinking…';
export const NOT_SAVED_TEXT = "That didn't go through, so nothing was saved. Tap the button again to try again.";
const UNDO_FAILED_TEXT = "That didn't go through, so nothing was undone. Tap Undo to try again.";
const CONSENT_UNAVAILABLE_TEXT = "The permission form couldn't load just now. Nothing has changed.";
const CONSENT_FAILED_TEXT = "That didn't go through. Nothing has changed. Tap 'I agree' to try again.";
const CONSENT_DONE_TEXT = 'Permission filed. Thank you.';
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
}

interface OpenCard { view: CardView; el: HTMLElement; li: HTMLElement }
interface Trail { entry: TrailEntry; card: ProposalCard; li: HTMLElement }

const keyOf = (c: CardView) => (c.origin === 'server' ? `server:${c.proposalId}` : `local:${c.localId}`);

export function mountMentorPanel(root: HTMLElement, opts: {
  mode: MentorMode; backend: MentorBackend; dialogue: Dialogue; writer: CardWriter; engine: ScriptedEngine; client: ApiClient;
  forms: Record<string, BureauForm>; store: PlayerStore; reducedMotion: () => boolean; now: () => Date;
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

  const bubbles = h('ol', { class: 'bubbles', 'aria-live': 'polite' });
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

  let talkBtn: HTMLButtonElement | null = null;
  let textBox: HTMLTextAreaElement | null = null;
  let sendBtn: HTMLButtonElement | null = null;
  let open = false;
  let turn = 0;
  let pending = false;
  const cards = new Map<string, OpenCard>();
  const trail: Trail[] = [];

  const scrollDown = () => { bubbles.scrollTop = bubbles.scrollHeight; };
  /** Removes the oldest items past MAX_BUBBLES; a card or trail entry that goes with them is no longer open. */
  const trim = () => {
    while (bubbles.children.length > MAX_BUBBLES) {
      const gone = bubbles.firstElementChild!;
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
    const el = renderCard(view, {
      forms, now: opts.now,
      onConfirm: (edits) => confirm(view, 'tap', edits),
      onReject: () => reject(view),
    });
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
    // The pressed button is gone: focus stays in the same place in the panel, on the entry that replaced it.
    if (hadFocus) (c.li.querySelector('button') ?? textBox ?? closeBtn).focus();
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
    if (c === undefined) return;
    let out: WriteOutcome;
    try {
      out = await writer.confirm(view, via, edits);
    } catch (err) {
      console.error(err);
      out = { ok: false, reason: 'network', items: [] };
    }
    if (out.ok) {
      await toTrail(key, out.trail);
      renderItems(out.items, []);
      // Carry from Step 2: the intake follow-up only after a confirmed write.
      if (view.card.kind === 'rule' && store.get().intake.step === 'allergies') sayLine('intake.allergies.followup');
      return;
    }
    // A failed write is never silent (Step 9 carry): a scripted line, and a way to try again.
    const said = out.items.length > 0 ? out.items : [{ kind: 'said', said: dialogue.say('write.not_done') } satisfies PanItem];
    switch (out.reason) {
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
    if (c === undefined) return;
    const items = await writer.reject(view);
    if (items.length === 0) { setCardNote(c.el, NOT_SAVED_TEXT); return; }
    cards.delete(key);
    removeLi(c.li);
    renderItems(items, []);
  }

  async function undo(t: Trail): Promise<UndoOutcome> {
    let out: UndoOutcome;
    try {
      out = await writer.undo(t.entry);
    } catch (err) {
      console.error(err);
      out = { status: 'failed', items: [] };
    }
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
      case 'confirmed': void toTrail(`server:${a.proposalId}`, a.trail); return;
      case 'rejected': {
        const c = cards.get(`server:${a.proposalId}`);
        if (c) { cards.delete(`server:${a.proposalId}`); removeLi(c.li); }
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
    if (c === undefined) return;
    if (i.kind === 'confirm') await confirm(c.view, 'typed_yes');
    else await reject(c.view);
  }

  // --- Items ---------------------------------------------------------------------------------------------------

  function renderConsent(purpose: 'health_data' | 'ai_health'): void {
    const li = addLi('pan-item pan-consent-item');
    void client.consents().then((r) => {
      const notice = r.ok ? r.data.notices[purpose] : undefined;
      const form = forms[purpose === 'ai_health' ? 'consent_ai' : 'consent_health'] as BureauForm | undefined;
      if (notice === undefined || form === undefined) { li.replaceChildren(h('p', { class: 'pan-note', role: 'status' }, CONSENT_UNAVAILABLE_TEXT)); return; }
      const el = renderConsentCard(purpose, {
        form, notice,
        onAgree: async () => {
          const g = await client.grantConsent(purpose, notice.version);
          if (g.ok) li.replaceChildren(h('p', { class: 'pan-note', role: 'status' }, CONSENT_DONE_TEXT));
          else setCardNote(el, CONSENT_FAILED_TEXT);
        },
        // Saying no costs nothing: play goes on.
        onDecline: () => { removeLi(li); },
      });
      li.replaceChildren(el);
    });
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
        case 'consent': renderConsent(item.purpose); break;
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
    pending = on;
    if (on) bubbles.setAttribute('aria-busy', 'true'); else bubbles.removeAttribute('aria-busy');
    status.textContent = on ? THINKING_TEXT : '';
    if (sendBtn) sendBtn.disabled = on;
  };

  const reply = async (input: MentorInput): Promise<void> => {
    turn++;
    setPending(true);
    let r: PanReply;
    try {
      r = await backend.reply(input, context());
    } catch (err) {
      console.error(err);
      r = { items: [{ kind: 'said', said: dialogue.say('mentor.ai_unavailable') }], cards: [], intents: [], actions: [], notice: null };
    } finally {
      setPending(false);
    }
    render(r);
  };
  backend.onLate?.((r) => { render(r); });

  if (standard) {
    textBox = h('textarea', { id: 'pan-text', rows: 2, maxlength: 500, class: 'pan-text' });
    sendBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send');
    const form = h('form', { class: 'pan-form' },
      h('label', { for: 'pan-text' }, 'Say something to the Pan'),
      textBox,
      sendBtn,
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (pending) return;
      const text = textBox!.value.trim();
      if (!text) return;
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
  };

  closeBtn.addEventListener('click', () => api.close());
  if (opener) {
    opener.setAttribute('aria-expanded', 'false');
    opener.setAttribute('aria-controls', 'pan-panel');
    opener.addEventListener('click', () => (open ? api.close() : api.open()));
  }
  root.append(panel);
  return api;
}

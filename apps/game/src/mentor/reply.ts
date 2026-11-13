import type { CardAction, HeardCheck, IntakeStep, NavTarget, ProposalCard, Severity, TrailEntry, TurnNotice } from '@kitchenquest/core/engine';
import type { Said } from './dialogue';

/**
 * What a mentor backend gives the panel for one turn (M4 Step 9). Types only. Everything the player sees
 * is a scripted line or a card built by code; the model's free text is never one of these (ruling R9).
 */

/** A card the client's scripted engine built. Nothing is written until the writer runs it. */
export interface LocalCardView { origin: 'local'; localId: string; card: ProposalCard; issuedTurn: number }
/** A card the server issued (a sealed proposal row). */
export interface ServerCardView {
  origin: 'server'; proposalId: string; expiresAt: string; card: ProposalCard; issuedTurn: number;
  /** The server conversation the card was issued in (M-6: a tap after a new conversation says why it closed). */
  conversationId?: string | null;
}
export type CardView = LocalCardView | ServerCardView;

/** How a consent card ended. `unavailable` (the notice couldn't load) is not a no: the question stays open. */
export type ConsentAnswer = 'granted' | 'declined' | 'unavailable';

export type PanItem =
  | { kind: 'said'; said: Said }
  /** An ambiguous term: the panel shows the options and builds a local rule card from the one tapped. */
  | { kind: 'choices'; options: { id: string; name: string }[]; severity: Severity | null }
  /** Show that consent card. `onAnswer` hears the outcome: the grant filed, Not now, or the notice couldn't load. */
  | { kind: 'consent'; purpose: 'health_data' | 'ai_health'; onAnswer?: (answer: ConsentAnswer) => void }
  /**
   * Quick answers to the question just asked (the intake's weekday, 1–7 and Skip chips, Step 11). A tap is a new turn:
   * the panel shows the label as the player's bubble and renders what `onPick` returns.
   */
  | { kind: 'quick'; label: string; options: { label: string; value: string }[]; onPick(value: string, ctx: TurnContext): Promise<PanReply> }
  /** The saved rules need review (API 409 `rules_need_review`): code-owned player copy and a link to Your rules. */
  | { kind: 'rules_error'; message: string; href: string }
  /** A navigation chip (Ruling 15): a button carrying its `nav.offer` line. Only a tap navigates; nothing else does. */
  | { kind: 'go'; target: NavTarget; said: Said }
  /**
   * The AI failed twice on this turn: a "Try again" button that sends the same input again, unchanged (M7 Step 6 fix
   * round 1, I2: a transcript stays a transcript, with its heard words, so it meets the server's heard gate again and is
   * stored as spoken). It lives in memory only (N-4).
   */
  | { kind: 'retry'; input: MentorInput }
  /**
   * M7 Step 9 (Ruling 4): the heard card. The words a transcript named, as heard and spelled, with their sound-alikes;
   * nothing in it has been acted on. Only a tap on its buttons goes on: `onPick(choice, ctx)` is the confirmed turn
   * (`choice[i]`: an index into `check.terms[i].alternatives`, or null for the words as heard). From the device's own
   * heard check or a server `heard` part (P7). `utteranceId`: the utterance it was heard in, so its spoken half is the
   * API's own (a `heard` speak item, P8); null when there is none (a retried turn).
   */
  | { kind: 'heard'; check: HeardCheck; utteranceId: number | null; onPick(choice: (number | null)[], ctx: TurnContext): Promise<PanReply> };

/**
 * What the player said. M7 Step 6 (P9): typed text, or a speech-to-text transcript (untrusted user text, §7.6) with,
 * after a tap on its heard card, the words that tap confirmed (Ruling 4). Step 9's `transcriptTurn` runs the device's
 * heard check before any backend sees a transcript. A transcript is the spoken kind: the server stores it `spoken`.
 */
export type MentorInput =
  | { kind: 'text'; text: string }
  /** `utteranceId` (M7 Step 9): the voice utterance it came from, on the device only (never sent: the turn names none). */
  | { kind: 'transcript'; text: string; heard?: { words: string[] }; utteranceId?: number };

/** A request from the engine to the panel's writer (pre-flight C10). CardAction stays the record of a write the SERVER completed. */
export type LocalIntent = { kind: 'confirm' | 'reject'; localId: string } | { kind: 'undo' };

/** `replyId` (M7 Step 9): the server reply's id (`TurnResponse.replyId`), so its line parts are spoken by id (Ruling 15). */
export interface PanReply { items: PanItem[]; cards: CardView[]; intents: LocalIntent[]; actions: CardAction[]; notice: TurnNotice; replyId?: string | null }

/**
 * What the panel knows when it asks for a reply: the Pan turn number, the cards still open, the intake step, and
 * the trail entries whose undo window is still open (oldest first), so a typed undo goes by the newest one.
 */
export interface TurnContext { turn: number; openCards: CardView[]; intakeStep: IntakeStep | null; signedIn: boolean; trail: readonly TrailEntry[] }

/** A write in the panel's trail: its entry, the card it came from, and its place (`co`: a check-off card's, M6 Step 10). */
export interface PanelTrail { entry: TrailEntry; card: ProposalCard; li: HTMLElement; co?: CheckOffSlot }
/**
 * A check-off card's place in the panel (M6 Step 10), drawn by check-off-card.ts. `applied`: done, with its Undo
 * (`trail`); `new`: not drawn yet (a local grammar card is ticking, any other waits for its tap).
 */
export interface CheckOffSlot {
  state: 'new' | 'applying' | 'pending' | 'applied' | 'undone'; trail?: PanelTrail | null; draw(): void;
  /** The row keys a local write actually ticked (fix round 1, m2); absent for a server card (the API ticked it). */
  ticked?: string[];
  /** M6 final: the row keys that were already ticked before the card's write ("(already ticked)"). */
  already?: string[] | undefined;
}

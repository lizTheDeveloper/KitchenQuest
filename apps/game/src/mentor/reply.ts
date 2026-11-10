import type { CardAction, IntakeStep, ProposalCard, Severity, TrailEntry, TurnNotice } from '@kitchenquest/core/engine';
import type { Said } from './dialogue';

/**
 * What a mentor backend gives the panel for one turn (M4 Step 9). Types only. Everything the player sees
 * is a scripted line or a card built by code; the model's free text is never one of these (ruling R9).
 */

/** A card the client's scripted engine built. Nothing is written until the writer runs it. */
export interface LocalCardView { origin: 'local'; localId: string; card: ProposalCard; issuedTurn: number }
/** A card the server issued (a sealed proposal row). */
export interface ServerCardView { origin: 'server'; proposalId: string; expiresAt: string; card: ProposalCard; issuedTurn: number }
export type CardView = LocalCardView | ServerCardView;

export type PanItem =
  | { kind: 'said'; said: Said }
  /** An ambiguous term: the panel shows the options and builds a local rule card from the one tapped. */
  | { kind: 'choices'; options: { id: string; name: string }[]; severity: Severity | null }
  /** Show that consent card. `onAnswer` hears the tap: true once the grant is filed, false on Not now (or no notice). */
  | { kind: 'consent'; purpose: 'health_data' | 'ai_health'; onAnswer?: (granted: boolean) => void }
  /**
   * Quick answers to the question just asked (the intake's weekday, 1–7 and Skip chips, Step 11). A tap is a new turn:
   * the panel shows the label as the player's bubble and renders what `onPick` returns.
   */
  | { kind: 'quick'; label: string; options: { label: string; value: string }[]; onPick(value: string, ctx: TurnContext): Promise<PanReply> }
  /** The saved rules need review (API 409 `rules_need_review`): code-owned player copy and a link to Your rules. */
  | { kind: 'rules_error'; message: string; href: string }
  /** The AI failed twice on this text: a "Try again" button that sends it again. The text lives in memory only (N-4). */
  | { kind: 'retry'; text: string };

/** A request from the engine to the panel's writer (pre-flight C10). CardAction stays the record of a write the SERVER completed. */
export type LocalIntent = { kind: 'confirm' | 'reject'; localId: string } | { kind: 'undo' };

export interface PanReply { items: PanItem[]; cards: CardView[]; intents: LocalIntent[]; actions: CardAction[]; notice: TurnNotice }

/**
 * What the panel knows when it asks for a reply: the Pan turn number, the cards still open, the intake step, and
 * the trail entries whose undo window is still open (oldest first), so a typed undo goes by the newest one.
 */
export interface TurnContext { turn: number; openCards: CardView[]; intakeStep: IntakeStep | null; signedIn: boolean; trail: readonly TrailEntry[] }

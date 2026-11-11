import type { Severity } from '../rules/types';
import type { LineRef, ProposalCard, ProposalKind } from './cards';

/**
 * The mentor wire protocol (types only). The API and the game both import these, so they never
 * drift.
 */

export type IntakeStep = 'market_day' | 'meals_per_week' | 'region' | 'allergies' | 'pantry';

export interface TurnRequest {
  conversationId: string | null;
  input: { kind: 'text'; text: string }; // M7 adds { kind: 'transcript'; text: string }
  localDate: string; // the player's YYYY-MM-DD
  localTime: string; // the player's HH:MM
  screen: { route: string; slug?: string } | null;
  intakeStep: IntakeStep | null;
}

export type ReplyPart =
  | { kind: 'line'; line: LineRef }
  /** Model text that passed the Step 7 filter. */
  | { kind: 'text'; text: string }
  /** An ambiguous term: the client builds a local rule card from the tapped option. */
  | { kind: 'choices'; options: { id: string; name: string }[]; severity: Severity | null }
  /** Show that consent card. */
  | { kind: 'consent'; purpose: 'health_data' | 'ai_health' };

export interface ServerCard {
  proposalId: string;
  expiresAt: string;
  card: ProposalCard;
}

/** server: id = proposal id. local: id = the written row id (rule, meal) or a local id (profile, pantry, device writes). */
export interface TrailEntry {
  id: string;
  origin: 'server' | 'local';
  kind: ProposalKind;
  summary: string;
  undoUntil: string;
}

/**
 * A write the SERVER completed. The client's own requests to its writer are LocalIntent
 * (Step 9), never CardAction.
 */
export type CardAction =
  | { kind: 'confirmed'; proposalId: string; trail: TrailEntry }
  | { kind: 'rejected'; proposalId: string }
  | { kind: 'undone'; id: string };

export type TurnNotice = 'ai_unavailable' | 'rate_limited' | 'needs_ai_health' | 'ai_off' | null;

export interface TurnResponse {
  conversationId: string | null;
  /** scripted = the server did not handle it; run the client's scripted engine. */
  route: 'ai' | 'deterministic' | 'scripted';
  parts: ReplyPart[];
  cards: ServerCard[];
  actions: CardAction[];
  notice: TurnNotice;
  /** For M7's filler line. */
  toolTurn: boolean;
}

export interface ConfirmRequest {
  channel: 'tap';
  edits?: { severity?: Severity };
  /**
   * The conversation the player is in now. When sent, a proposal from any other conversation (an earlier one, one
   * since forgotten, or none) is closed, never written (409 `proposal_closed`).
   */
  conversationId?: string | null;
}

export interface ConfirmResponse {
  trail: TrailEntry;
  parts: ReplyPart[];
}

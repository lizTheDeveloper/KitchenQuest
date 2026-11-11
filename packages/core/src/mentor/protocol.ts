import type { Severity } from '../rules/types';
import type { LineRef, ProposalCard, ProposalKind } from './cards';

/**
 * The mentor wire protocol (types only). The API and the game both import these, so they never
 * drift.
 */

export type IntakeStep = 'market_day' | 'meals_per_week' | 'region' | 'allergies' | 'pantry';

/**
 * How long the game waits for a mentor turn before it counts as unreachable (status 0, the outage path), and the
 * server's own deadline for answering one, model call and retry included (M4 final J2). The deadline is well below
 * the client's wait, so the server always answers (with `ai_unavailable` at worst) before the client gives up on a
 * turn it then retries; the retry carries the same `turnKey`, so a turn is never processed twice either way.
 */
export const MENTOR_CLIENT_TIMEOUT_MS = 20_000;
export const MENTOR_TURN_DEADLINE_MS = 15_000;

export interface TurnRequest {
  conversationId: string | null;
  input: { kind: 'text'; text: string }; // M7 adds { kind: 'transcript'; text: string }
  localDate: string; // the player's YYYY-MM-DD
  localTime: string; // the player's HH:MM
  screen: { route: string; slug?: string } | null;
  intakeStep: IntakeStep | null;
  /**
   * M4 final I-1: the one card a plain "yes" or "no" answers, by proposal id. The client sets it only when exactly
   * one recent server card is on screen; the server confirms or turns down only that proposal, and only while it is
   * open in this conversation. Without it (or with another id) a plain yes or no writes nothing.
   */
  answering?: string;
  /**
   * M4 final J2: one id per player turn (a UUID), the same on its automatic retry. The server keeps the last one
   * per conversation and answers a repeat with nothing (no model call, no card), so a turn is processed once.
   */
  turnKey?: string;
}

/**
 * Where a navigation chip goes (Ruling 15): a closed set, checked by code. `visit` names a cook id and `recipe` a
 * canon slug; anything else is never a target.
 */
export type NavTarget =
  | { to: 'kitchen' | 'map' | 'plan' | 'market' | 'book' }
  | { to: 'visit'; cook: string }
  | { to: 'recipe'; slug: string };

export type ReplyPart =
  | { kind: 'line'; line: LineRef }
  /** Model text that passed the Step 7 filter. */
  | { kind: 'text'; text: string }
  /** An ambiguous term: the client builds a local rule card from the tapped option. */
  | { kind: 'choices'; options: { id: string; name: string }[]; severity: Severity | null }
  /** Show that consent card. */
  | { kind: 'consent'; purpose: 'health_data' | 'ai_health' }
  /** A navigation chip (Ruling 15): shown with its `nav.offer` line; nothing moves until the player taps it. */
  | { kind: 'go'; target: NavTarget; line: LineRef };

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

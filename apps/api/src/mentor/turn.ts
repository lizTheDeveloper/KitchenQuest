import { randomUUID } from 'node:crypto';
import {
  buildMealCard,
  buildPantryCard,
  buildProfileCard,
  buildRuleCard,
  classifyTurn,
  isSuitabilityQuestion,
  matchDish,
  normalizeTurn,
  parseRuleStatement,
  preRoute,
  severityFromText,
  slotForTime,
  stripPageEvents,
  SUITABILITY_PATTERN,
  weekdayNumbers,
  type ProfilePatchInput,
  type ProposalCard,
  type ReplyPart,
  type ServerCard,
  type TurnNotice,
  type TurnRequest,
  type TurnResponse,
} from '@kitchenquest/core';
import { and, eq } from 'drizzle-orm';
import type { AiProvider, AiResult, AiTool } from '../ai/provider.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { Catalog } from '../catalog.js';
import { consentHeldIn, hasConsent, type Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { canonRecipes, conversations } from '../db/schema.js';
import { addDays } from '../meals/service.js';
import type { Db } from '../types.js';
import { recordUsage } from '../usage/usage.js';
import { aiTurnsLeft, recordAiCost, type BudgetGuard } from './allowance.js';
import { appendMessages, bumpTurn, openConversation, recentMessages, type StoredMessage } from './conversations.js';
import { isHealthText } from './health.js';
import { line, type PanBank } from './lines.js';
import type { MemoryFlags, MemoryHistory } from './memory.js';
import { applyPostChecks, severeTermsLeftOut, statesSevere } from './postchecks.js';
import { buildPromptContext, minimiseHistory, renderMessages, type PanPrompt } from './prompt.js';
import { createProposal, hasOpenHealthProposal } from './proposals.js';
import { isWriteRequest } from './requests.js';
import { MENTOR_TOOLS, parseToolCall, type ToolArgs } from './tools.js';

export interface TurnDeps {
  db: Db;
  keyring: Keyring;
  /** The rule terms are `catalog.ruleTerms`. */
  catalog: Catalog;
  ai: AiProvider | null;
  budget: BudgetGuard | null;
  memory: MemoryHistory;
  bank: PanBank;
  prompt: PanPrompt;
  /** Conversations where a child spoke (§19), in memory only. */
  childFlags: MemoryFlags;
  now: () => Date;
}

type Opened = { conversationId: string; turnSeq: number; healthData: boolean; aiHealth: boolean; openHealthCard: boolean };

/**
 * How much of the model a turn may use. `full`: every propose tool (with
 * `ai_health`) or `propose_profile` only (without, fix round 1 R4).
 * `rule_help`: the C6 exemption let a capped turn through, so only
 * `propose_rule` is offered (R3).
 */
type Mode = 'full' | 'rule_help';

const respond = (
  conversationId: string,
  route: TurnResponse['route'],
  parts: ReplyPart[],
  notice: TurnNotice = null,
  extra: { cards?: ServerCard[]; toolTurn?: boolean } = {},
): TurnResponse => ({ conversationId, route, parts, cards: extra.cards ?? [], actions: [], notice, toolTurn: extra.toolTurn ?? false });

/** Stage 1: open the conversation and bump its turn (live user → conversation row), and read what the gates need. */
async function openTurn(deps: TurnDeps, userId: string, req: TurnRequest, now: Date): Promise<Opened> {
  return deps.db.transaction(async (tx) => {
    await lockLiveUser(tx, userId);
    const conv = await openConversation(tx, userId, req.conversationId, now);
    const turnSeq = await bumpTurn(tx, conv.id, now);
    const healthData = await hasConsent(tx, userId, 'health_data', now);
    const aiHealth = healthData && (await hasConsent(tx, userId, 'ai_health', now));
    const openHealthCard = await hasOpenHealthProposal(tx, userId, conv.id, now);
    return { conversationId: conv.id, turnSeq, healthData, aiHealth, openHealthCard };
  });
}

/** Stage 4: the health gate (pre-flight C1, fix round 1 R1). Over-catches on purpose. */
function isHealthTurn(deps: TurnDeps, stripped: string, req: TurnRequest, opened: Opened): boolean {
  return req.intakeStep === 'allergies' || opened.openHealthCard || isHealthText(stripped, deps.catalog);
}

/**
 * Stage 5: why the model can't be used now, or the mode it may be used in.
 * Rule help is never capped (pre-flight C6, §16): it skips the daily
 * allowance, never the AI-off or budget checks, and then runs as `rule_help`.
 */
async function availability(deps: TurnDeps, userId: string, health: boolean, stripped: string, now: Date): Promise<{ notice: TurnNotice } | { mode: Mode }> {
  if (deps.ai === null) return { notice: 'ai_off' };
  if (deps.budget !== null && !(await deps.budget.ok(now))) return { notice: 'ai_unavailable' };
  const { left } = await aiTurnsLeft(deps.db, userId, now);
  if (left > 0) return { mode: 'full' };
  const graph = deps.catalog.graph;
  const ruleHelp = health && (parseRuleStatement(stripped, graph) !== null || severityFromText(stripped, graph) !== null);
  return ruleHelp ? { mode: 'rule_help' } : { notice: 'rate_limited' };
}

/** The tools a turn offers (R3, R4). */
function toolsFor(mode: Mode, aiHealth: boolean): AiTool[] {
  if (mode === 'rule_help') return MENTOR_TOOLS.filter((t) => t.name === 'propose_rule');
  return aiHealth ? MENTOR_TOOLS : MENTOR_TOOLS.filter((t) => t.name === 'propose_profile');
}

/**
 * Stage 6: context and history, minimised (C-13), read in one transaction that
 * re-reads `ai_health` (fix round 1, P2): a withdrawal since stage 1 counts.
 */
async function promptInputs(deps: TurnDeps, userId: string, req: TurnRequest, opened: Opened, now: Date) {
  const turnsLeft = (await aiTurnsLeft(deps.db, userId, now)).left;
  const { ctx, aiHealth } = await deps.db.transaction(async (tx) => {
    const fresh = (await hasConsent(tx, userId, 'health_data', now)) && (await hasConsent(tx, userId, 'ai_health', now));
    const built = await buildPromptContext(tx, deps, userId, { ...req, conversationId: opened.conversationId }, fresh, turnsLeft, now);
    return { ctx: built, aiHealth: fresh };
  });
  const history = await recentMessages(deps.db, deps.keyring, deps.memory, userId, opened.conversationId, opened.healthData, now);
  const sent = aiHealth ? history : minimiseHistory(history, deps.bank, deps.catalog);
  return { ctx, sent, aiHealth };
}

interface Reply {
  parts: ReplyPart[];
  cards: ProposalCard[];
  toolTurn: boolean;
}

/** Stage 7: each validated, post-checked call becomes a card or a refusal line. The model's text is never used (R9). */
function cardsFromCalls(
  deps: TurnDeps,
  calls: ToolArgs[],
  req: TurnRequest,
  healthData: boolean,
  recipes: readonly { slug: string; title: string }[],
): Reply {
  const parts: ReplyPart[] = [];
  const cards: ProposalCard[] = [];
  let askedConsent = false;
  const needsConsent = () => {
    if (askedConsent) return;
    askedConsent = true;
    parts.push(line('consent.health_first'), { kind: 'consent', purpose: 'health_data' });
  };
  const add = (card: ProposalCard) => {
    cards.push(card);
    for (const l of card.readback) parts.push({ kind: 'line', line: l });
  };
  for (const call of calls) {
    switch (call.name) {
      case 'propose_rule': {
        if (!healthData) {
          needsConsent();
          break;
        }
        const r = buildRuleCard(call.args, deps.catalog.graph, deps.catalog.ruleTerms);
        if (r.ok) add(r.card);
        else if (r.reason === 'unknown_term') parts.push({ kind: 'line', line: r.line });
        else parts.push({ kind: 'line', line: r.line }, { kind: 'choices', options: r.options, severity: call.args.severity });
        break;
      }
      case 'propose_meal_log': {
        if (!healthData) {
          needsConsent();
          break;
        }
        const a = call.args;
        const dish = a.dish === null ? null : matchDish(a.dish, recipes);
        const description = (a.description ?? a.dish ?? '').trim();
        if (dish === null && description === '') break;
        add(
          buildMealCard({
            eatenOn: a.when === 'yesterday' ? addDays(req.localDate, -1) : req.localDate,
            slot: a.slot ?? slotForTime(req.localTime),
            ...(dish ? { dish: { ...dish, servings: a.servings ?? 1 } } : { description }),
          }),
        );
        break;
      }
      case 'propose_profile': {
        const a = call.args;
        const patch: ProfilePatchInput = {};
        if (a.market_days !== null) patch.marketDays = weekdayNumbers(a.market_days);
        if (a.meals_per_week !== null) patch.mealsPerWeek = a.meals_per_week;
        if (a.region !== null) patch.region = a.region;
        if (a.country !== null) patch.country = a.country;
        if (a.meal_windows !== null && a.meal_windows.length > 0) patch.mealWindows = a.meal_windows;
        if (Object.keys(patch).length > 0) add(buildProfileCard(patch));
        break;
      }
      case 'propose_pantry_change':
        if (call.args.add.length > 0 || call.args.remove.length > 0) add(buildPantryCard(call.args, deps.catalog.graph));
        break;
    }
  }
  return { parts, cards, toolTurn: true };
}

/**
 * Stage 8: no card came out. Ruling R9 (fix round 4): the model's free text is
 * never shown to any player on any turn, so the reply is a scripted line read
 * from the player's own words: `write.not_done` when they asked for a record to
 * change, `mentor.check_card` when a dish is on screen or named, else
 * `didnt_understand`. The health asks are added after.
 */
function scriptedReply(stripped: string, dishNamed: boolean, writeRequest: boolean): Reply {
  // Fix round 5: a write request that also asks whether the dish suits the player gets both lines.
  const triggers =
    writeRequest && dishNamed && isSuitabilityQuestion(stripped)
      ? ['mentor.check_card', 'write.not_done']
      : [writeRequest ? 'write.not_done' : dishNamed ? 'mentor.check_card' : 'didnt_understand'];
  return { parts: triggers.map((t) => line(t)), cards: [], toolTurn: false };
}

/** Locks the caller's conversation row (FOR UPDATE); false when it is gone (forgotten mid-turn). */
async function lockConversation(tx: Tx, userId: string, conversationId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .for('update');
  return rows.length > 0;
}

const RULE_OUTCOME_LINES = new Set(['rule.unknown_term', 'rule.which_one', 'consent.health_first', 'rule.ask_what_else', 'rule.ask_keep_off']);
const hasRuleOutcome = (reply: Reply) =>
  reply.cards.some((c) => c.kind === 'rule') || reply.parts.some((p) => p.kind === 'line' && RULE_OUTCOME_LINES.has(p.line.trigger));

interface FinishInput {
  opened: Opened;
  req: TurnRequest;
  raw: string;
  stripped: string;
  result: Extract<AiResult, { ok: true }>;
  dishOnScreen: boolean;
  health: boolean;
  mode: Mode;
  offered: readonly AiTool[];
}

/**
 * Stages 7–9 in one transaction, in the README lock order: live user (usage
 * is recorded here, so a turn racing an account delete is a 401, P5; the
 * global cost was already counted on its own, N6) → consent row (share-locked; `persist` and the health cards are
 * decided from it, never from an earlier read) → conversation row → messages
 * → mentor_proposals. A concurrent withdraw-with-delete either waits and then
 * deletes what this stored, or commits first and this stores nothing health.
 */
async function finishTurn(deps: TurnDeps, userId: string, f: FinishInput, now: Date): Promise<TurnResponse> {
  const graph = deps.catalog.graph;
  const offered = new Set(f.offered.map((t) => t.name));
  const calls = applyPostChecks(
    f.result.toolCalls
      .filter((c) => offered.has(c.name))
      .map(parseToolCall)
      .filter((c): c is ToolArgs => c !== null),
    f.raw,
    graph,
    deps.catalog.ruleTerms,
  );
  return deps.db.transaction(async (tx) => {
    await lockLiveUser(tx, userId);
    await recordUsage(tx, userId, 'mentor_text', 1, f.result.usage.costMicroUsd, now);
    const persist = await consentHeldIn(tx, userId, 'health_data', now);
    const recipes = await tx.select({ slug: canonRecipes.slug, title: canonRecipes.title }).from(canonRecipes);
    const dishNamed = f.dishOnScreen || matchDish(f.stripped, recipes) !== null;
    const writeRequest = isWriteRequest(f.stripped, graph);
    let reply: Reply;
    if (calls.length > 0) reply = cardsFromCalls(deps, calls, f.req, persist, recipes);
    else if (f.mode === 'rule_help') reply = { parts: [], cards: [], toolTurn: false }; // R3: rule help only
    else reply = scriptedReply(f.stripped, dishNamed, writeRequest);
    // A bare "didn't understand" gives way to any ask that follows.
    const dropBareFallback = () => {
      if (reply.parts.length === 1 && reply.parts[0].kind === 'line' && reply.parts[0].line.trigger === 'didnt_understand') reply.parts = [];
    };

    // I5: a severe statement always ends with a rule outcome, naming the missed ingredient when code knows it.
    const keptRuleTerms = calls.flatMap((c) => (c.name === 'propose_rule' ? [c.args.term] : []));
    const missed = severeTermsLeftOut(f.raw, keptRuleTerms, graph);
    if (missed !== null || (statesSevere(f.raw, graph) && !hasRuleOutcome(reply))) {
      dropBareFallback();
      reply.parts.push(line('rule.ask_what_else', missed === null ? {} : { term: missed }));
    }
    // A health statement is never silently lost (fix round 1 ruling on call 3): a health turn
    // that made no card at all, or whose model rule was dropped (C4), with no rule outcome,
    // asks plainly.
    // A question whether a dish suits the player, with no rule statement and no severity cue, is
    // answered by the dish card alone: it is a question, not a health statement (controller ruling).
    // Fix round 3 (A): only when nothing else in the message is health, and only for a dish on
    // screen or named; a bare "can I eat this?" with no dish still gets the plain ask.
    const rest = normalizeTurn(f.stripped).replace(new RegExp(SUITABILITY_PATTERN.source, 'g'), ' ');
    const suitabilityOnly =
      isSuitabilityQuestion(f.stripped) &&
      parseRuleStatement(f.stripped, graph) === null &&
      severityFromText(f.stripped, graph) === null &&
      !isHealthText(rest, deps.catalog) &&
      dishNamed;
    if (suitabilityOnly && reply.cards.length === 0) reply.parts = [line('mentor.check_card'), ...(writeRequest ? [line('write.not_done')] : [])];
    const proposedRule = f.result.toolCalls.some((c) => c.name === 'propose_rule' && offered.has(c.name));
    const droppedRule = proposedRule && keptRuleTerms.length === 0;
    if (f.health && !suitabilityOnly && !hasRuleOutcome(reply) && (reply.cards.length === 0 || droppedRule)) {
      dropBareFallback();
      reply.parts.push(line('rule.ask_keep_off'));
    }
    if (f.mode === 'rule_help' && !hasRuleOutcome(reply)) reply = { parts: [line('rate_limited')], cards: [], toolTurn: false };
    if (reply.parts.length === 0) reply.parts.push(line('didnt_understand'));

    if (!(await lockConversation(tx, userId, f.opened.conversationId))) {
      // Forgotten while the model ran: nothing is stored and no card is offered.
      return respond(f.opened.conversationId, 'ai', reply.parts.filter((p) => p.kind === 'line'), null, {
        toolTurn: reply.toolTurn,
      });
    }
    const ids = reply.cards.map(() => randomUUID());
    // The transcript holds what the player saw: the scripted reply, never the model's text (R9).
    const msgs: StoredMessage[] = [
      { role: 'player', text: f.stripped },
      { role: 'pan', parts: reply.parts, proposalIds: ids },
    ];
    const append = () => appendMessages(tx, deps.keyring, deps.memory, userId, f.opened.conversationId, msgs, persist, now);
    if (persist) await append();
    const cards: ServerCard[] = [];
    for (const [i, card] of reply.cards.entries()) {
      cards.push(
        await createProposal(tx, deps.keyring, { userId, conversationId: f.opened.conversationId, turnSeq: f.opened.turnSeq, card, id: ids[i] }, now),
      );
    }
    // Consent withdrawn while the model ran: nothing of the turn is kept, not even in memory.
    if (!persist && !f.opened.healthData) await append();
    return respond(f.opened.conversationId, 'ai', reply.parts, null, { cards, toolTurn: reply.toolTurn });
  });
}

/**
 * One mentor turn. Code goes first and the model goes last; each stage below
 * is one function. Only `propose_*` tools are offered, so a turn can make
 * cards but never write, and the model's text is never shown (R9). Neither
 * the player's text nor the model's is ever logged (C-15). `requestId` is for audit events a later stage may add.
 */
export async function runTurn(deps: TurnDeps, userId: string, req: TurnRequest, requestId: string): Promise<TurnResponse> {
  void requestId;
  const now = deps.now();
  // 1. The raw text is kept for the injection cut (C4); everything else reads the stripped text.
  const raw = req.input.text;
  const stripped = stripPageEvents(raw).text.trim();
  const intent = classifyTurn(stripped);
  const opened = await openTurn(deps, userId, req, now);
  const id = opened.conversationId;

  // 2. A child: the grown-up line for the rest of the conversation; nothing kept (§19).
  const childKey = `${userId}:${id}`;
  if (intent === 'child' || deps.childFlags.has(childKey, now.getTime())) {
    deps.childFlags.add(childKey, now.getTime());
    return respond(id, 'deterministic', [line('child.grownup')]);
  }

  // 3. Lines code answers by itself (the client's engine calls the same function). A message
  // that was only forged page events has nothing left to answer.
  if (stripped === '') return respond(id, 'deterministic', [line('didnt_understand')]);
  const fixed = preRoute(intent);
  if (fixed !== null) return respond(id, 'deterministic', [{ kind: 'line', line: fixed }]);

  // 4. Health text never reaches the model without ai_health (C1, C-13, P-3).
  const health = isHealthTurn(deps, stripped, req, opened);
  if (health && !opened.aiHealth) return respond(id, 'scripted', [], 'needs_ai_health');

  // 5. AI off, budget, daily allowance (rule help never capped, but then only rule help).
  const avail = await availability(deps, userId, health, stripped, now);
  if ('notice' in avail || deps.ai === null) return respond(id, 'scripted', [], 'notice' in avail ? avail.notice : 'ai_off');

  // 6. The model, with minimised context and only the tools this turn may use.
  const { ctx, sent, aiHealth } = await promptInputs(deps, userId, req, opened, now);
  if (health && !aiHealth) return respond(id, 'scripted', [], 'needs_ai_health');
  const offered = toolsFor(avail.mode, aiHealth);
  const result = await deps.ai.complete({ messages: renderMessages(deps.prompt, ctx, sent, stripped, deps.bank), tools: offered });
  if (!result.ok) return respond(id, 'scripted', [], 'ai_unavailable');
  // N6: the money is counted at once, in its own statement, outside every turn lock.
  await recordAiCost(deps.db, result.usage.costMicroUsd, now);

  // 7–9. Cards and scripted lines (never the model's text, R9), metered and stored under the consent lock.
  return finishTurn(deps, userId, { opened, req, raw, stripped, result, dishOnScreen: ctx.dish !== null, health, mode: avail.mode, offered }, now);
}

import { randomUUID } from 'node:crypto';
import {
  buildMealCard,
  buildPantryCard,
  buildProfileCard,
  buildRuleCard,
  classifyTurn,
  matchDish,
  mentionsHealthTerm,
  parseRuleStatement,
  preRoute,
  severityFromText,
  slotForTime,
  stripPageEvents,
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
import type { AiProvider, AiResult } from '../ai/provider.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { Catalog } from '../catalog.js';
import { consentHeldIn, hasConsent, type Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { canonRecipes, conversations } from '../db/schema.js';
import { addDays } from '../meals/service.js';
import type { Db } from '../types.js';
import { recordUsage } from '../usage/usage.js';
import { aiTurnsLeft, type BudgetGuard } from './allowance.js';
import { appendMessages, bumpTurn, openConversation, recentMessages, type StoredMessage } from './conversations.js';
import { filterReply, REPLACEMENT, type FilterFail } from './filter.js';
import { line, type PanBank } from './lines.js';
import type { MemoryFlags, MemoryHistory } from './memory.js';
import { applyPostChecks, severeTermsLeftOut } from './postchecks.js';
import { buildPromptContext, minimiseHistory, renderMessages, renderPanParts, type PanPrompt, type PromptContext } from './prompt.js';
import { createProposal, hasOpenHealthProposal } from './proposals.js';
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

/** Stage 4: the health gate (pre-flight C1). Over-catches on purpose. */
function isHealthTurn(deps: TurnDeps, intent: string, stripped: string, req: TurnRequest, opened: Opened): boolean {
  return (
    intent === 'health' ||
    req.intakeStep === 'allergies' ||
    mentionsHealthTerm(stripped, deps.catalog.graph, deps.catalog.ruleTerms) ||
    opened.openHealthCard
  );
}

/**
 * Stage 5: why the model can't be used now, or null. Rule help is never
 * capped (pre-flight C6, §16): it skips the daily allowance, never the
 * AI-off or budget checks.
 */
async function unavailable(deps: TurnDeps, userId: string, health: boolean, stripped: string, now: Date): Promise<TurnNotice> {
  if (deps.ai === null) return 'ai_off';
  if (deps.budget !== null && !(await deps.budget.ok(now))) return 'ai_unavailable';
  const graph = deps.catalog.graph;
  const ruleHelp = health && (parseRuleStatement(stripped, graph) !== null || severityFromText(stripped, graph) !== null);
  if (ruleHelp) return null;
  const { left } = await aiTurnsLeft(deps.db, userId, now);
  return left <= 0 ? 'rate_limited' : null;
}

/** Stage 6: context and history, minimised (C-13), read in their own transaction. */
async function promptInputs(deps: TurnDeps, userId: string, req: TurnRequest, opened: Opened, now: Date) {
  const turnsLeft = (await aiTurnsLeft(deps.db, userId, now)).left;
  const ctx = await deps.db.transaction((tx) =>
    buildPromptContext(tx, deps, userId, { ...req, conversationId: opened.conversationId }, opened.aiHealth, turnsLeft, now),
  );
  const history = await recentMessages(deps.db, deps.keyring, deps.memory, userId, opened.conversationId, opened.healthData, now);
  const sent = opened.aiHealth ? history : minimiseHistory(history, deps.bank, deps.catalog.graph, deps.catalog.ruleTerms);
  return { ctx, history, sent };
}

interface Reply {
  parts: ReplyPart[];
  cards: ProposalCard[];
  toolTurn: boolean;
}

/** Stage 7: each validated, post-checked call becomes a card or a refusal line. The model's text is dropped. */
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

/** Stage 8: no tool call. The filtered text, or the written line that replaces it. */
function textReply(result: Extract<AiResult, { ok: true }>, ctx: PromptContext, previousPanText: string | null): Reply {
  const filtered = filterReply(result.text, { finish: result.finish, previousPanText });
  if (filtered.ok) return { parts: [{ kind: 'text', text: filtered.text }], cards: [], toolTurn: false };
  return { parts: [line(replacementFor(filtered.reason, ctx))], cards: [], toolTurn: false };
}

/** The written line for a filter failure; a safety claim gets the label reminder only when there is a dish or a rule (pre-flight C34). */
function replacementFor(reason: FilterFail, ctx: Pick<PromptContext, 'dish' | 'rules'>): string {
  if (reason === 'safety_claim' && ctx.dish === null && (ctx.rules?.length ?? 0) === 0) return 'didnt_understand';
  return REPLACEMENT[reason];
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

/**
 * Stages 7–9 in one transaction, in the README lock order: live user →
 * consent row (share-locked; `persist` and the health cards are decided from
 * it, never from an earlier read) → conversation row → messages →
 * mentor_proposals. A concurrent withdraw-with-delete either waits and then
 * deletes what this stored, or commits first and this stores nothing health.
 */
async function finishTurn(
  deps: TurnDeps,
  userId: string,
  opened: Opened,
  req: TurnRequest,
  raw: string,
  stripped: string,
  result: Extract<AiResult, { ok: true }>,
  ctx: PromptContext,
  previousPanText: string | null,
  now: Date,
): Promise<TurnResponse> {
  const graph = deps.catalog.graph;
  const calls = applyPostChecks(
    result.toolCalls.map(parseToolCall).filter((c): c is ToolArgs => c !== null),
    raw,
    graph,
  );
  return deps.db.transaction(async (tx) => {
    await lockLiveUser(tx, userId);
    const persist = await consentHeldIn(tx, userId, 'health_data', now);
    const recipes = calls.some((c) => c.name === 'propose_meal_log')
      ? await tx.select({ slug: canonRecipes.slug, title: canonRecipes.title }).from(canonRecipes)
      : [];
    const reply = calls.length > 0 ? cardsFromCalls(deps, calls, req, persist, recipes) : textReply(result, ctx, previousPanText);
    const keptRuleTerms = calls.flatMap((c) => (c.name === 'propose_rule' ? [c.args.term] : []));
    if (severeTermsLeftOut(raw, keptRuleTerms, graph)) reply.parts.push(line('rule.ask_what_else'));
    if (reply.parts.length === 0) reply.parts.push(line('didnt_understand'));

    if (!(await lockConversation(tx, userId, opened.conversationId))) {
      // Forgotten while the model ran: nothing is stored and no card is offered.
      return respond(opened.conversationId, 'ai', reply.parts.filter((p) => p.kind === 'text' || p.kind === 'line'), null, {
        toolTurn: reply.toolTurn,
      });
    }
    const ids = reply.cards.map(() => randomUUID());
    const msgs: StoredMessage[] = [
      { role: 'player', text: stripped },
      { role: 'pan', parts: reply.parts, proposalIds: ids },
    ];
    const append = () => appendMessages(tx, deps.keyring, deps.memory, userId, opened.conversationId, msgs, persist, now);
    if (persist) await append();
    const cards: ServerCard[] = [];
    for (const [i, card] of reply.cards.entries()) {
      cards.push(await createProposal(tx, deps.keyring, { userId, conversationId: opened.conversationId, turnSeq: opened.turnSeq, card, id: ids[i] }, now));
    }
    // Consent withdrawn while the model ran: nothing of the turn is kept, not even in memory.
    if (!persist && !opened.healthData) await append();
    return respond(opened.conversationId, 'ai', reply.parts, null, { cards, toolTurn: reply.toolTurn });
  });
}

/**
 * One mentor turn. Code goes first and the model goes last; each stage below
 * is one function. Only `propose_*` tools are offered, so a turn can make
 * cards but never write. Neither the player's text nor the model's is ever
 * logged (C-15). `requestId` is for audit events a later stage may add.
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
  const health = isHealthTurn(deps, intent, stripped, req, opened);
  if (health && !opened.aiHealth) return respond(id, 'scripted', [], 'needs_ai_health');

  // 5. AI off, budget, daily allowance (rule help never capped).
  const notice = await unavailable(deps, userId, health, stripped, now);
  if (notice !== null || deps.ai === null) return respond(id, 'scripted', [], notice ?? 'ai_off');

  // 6. The model, with minimised context.
  const { ctx, history, sent } = await promptInputs(deps, userId, req, opened, now);
  const result = await deps.ai.complete({ messages: renderMessages(deps.prompt, ctx, sent, stripped, deps.bank), tools: MENTOR_TOOLS });
  if (!result.ok) return respond(id, 'scripted', [], 'ai_unavailable');
  await recordUsage(deps.db, userId, 'mentor_text', 1, result.usage.costMicroUsd, now);

  // 7–9. Cards or filtered text, stored under the consent lock.
  const lastPan = [...history].reverse().find((m) => m.role === 'pan');
  const previousPanText = lastPan ? renderPanParts(lastPan.parts, deps.bank) : null;
  return finishTurn(deps, userId, opened, req, raw, stripped, result, ctx, previousPanText, now);
}

import { randomUUID } from 'node:crypto';
import {
  alreadySavedLine,
  askForDroppedTerms,
  emergencyRuleAsks,
  emergencyStatesRule,
  buildMealCard,
  buildPantryCard,
  buildProfileCard,
  buildRuleCard,
  classifyTurn,
  isSevereCard,
  isSuitabilityQuestion,
  broadKindsAsked,
  leftoverNamedIngredients,
  matchDish,
  MENTOR_TURN_DEADLINE_MS,
  navIntent,
  nonAllergenNamedIds,
  normalizeTurn,
  parseRuleStatement,
  planIntent,
  planWordsIn,
  playerOwnWords,
  preRoute,
  ruleTermsInPlayerWords,
  severityFromText,
  shortReplyTarget,
  statesSevere,
  slotForTime,
  stripPageEvents,
  SUITABILITY_PATTERN,
  weekdayNumbers,
  type CardAction,
  type IngredientGraph,
  type NavTarget,
  type OpenCardRef,
  type PlanRequest,
  type ProfilePatchInput,
  type Rule,
  type ProposalCard,
  type ReplyPart,
  type ServerCard,
  type TurnNotice,
  type TurnRequest,
  type TurnIntent,
  type TurnResponse,
} from '@kitchenquest/core';
import { and, eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { AiProvider, AiResult, AiTool } from '../ai/provider.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { Catalog } from '../catalog.js';
import { consentHeldIn, hasConsent, type Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { canonRecipes, conversations } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { addDays } from '../meals/service.js';
import { pantryMatcher } from '../pantry/service.js';
import { loadPantry } from '../pantry/store.js';
import { loadRules } from '../rules/store.js';
import type { Db } from '../types.js';
import { completeUsage, recordSent } from '../usage/usage.js';
import { aiTurnsLeft, recordAiCost, type BudgetGuard } from './allowance.js';
import { appendMessages, bumpTurn, openConversation, recentMessages, type StoredMessage } from './conversations.js';
import { isHealthText } from './health.js';
import { line, listWords, type PanBank } from './lines.js';
import type { MemoryFlags, MemoryHistory } from './memory.js';
import { applyPostChecks } from './postchecks.js';
import { buildPromptContext, minimiseHistory, renderMessages, type PanPrompt } from './prompt.js';
import { createProposal, hasOpenHealthProposal, openProposalsOfConversation } from './proposals.js';
import { isWriteRequest } from './requests.js';
import { goPart, planCardContext, planReply, type PlanCardContext } from './plan-turn.js';
import { MENTOR_TOOLS, parseToolCall, type ToolArgs } from './tools.js';
import { confirmProposal, latestUndoable, rejectProposalIn, undoWriteIn, type WeekSource } from './writes.js';
import type { RecipeIndex } from '../recipes/recipe-index.js';

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
  /** The week's content and the app's recipe index (M5 Step 8: plan cards and navigation chips). */
  week: WeekSource;
  now: () => Date;
}

type Opened = { conversationId: string; turnSeq: number; healthData: boolean; aiHealth: boolean; openHealthCard: boolean };
/** A repeat of a turn already started (its `turnKey` is the conversation's last one, J2): answered with nothing. */
type Repeat = { conversationId: string; repeat: true };

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
  extra: { cards?: ServerCard[]; toolTurn?: boolean; actions?: CardAction[] } = {},
): TurnResponse => ({ conversationId, route, parts, cards: extra.cards ?? [], actions: extra.actions ?? [], notice, toolTurn: extra.toolTurn ?? false });

/**
 * Stage 1: open the conversation and bump its turn (live user → conversation row), and read what the gates need.
 * A turn whose `turnKey` was already started (J2: the client's retry of a turn it timed out on) is a `Repeat`,
 * found by the key even when the retry carries no conversation id (the first copy opened the conversation).
 */
async function openTurn(deps: TurnDeps, userId: string, req: TurnRequest, now: Date): Promise<Opened | Repeat> {
  return deps.db.transaction(async (tx) => {
    await lockLiveUser(tx, userId);
    if (req.turnKey !== undefined) {
      const seen = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.userId, userId), eq(conversations.lastTurnKey, req.turnKey)));
      const hit = seen.at(0);
      if (hit !== undefined) return { conversationId: hit.id, repeat: true };
    }
    const conv = await openConversation(tx, userId, req.conversationId, now);
    const turnSeq = await bumpTurn(tx, conv.id, now, req.turnKey);
    if (turnSeq === null) return { conversationId: conv.id, repeat: true };
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

/**
 * Without `ai_health`, the tools whose cards carry no health text (R4). M5 Step 8: a plan or a navigation reaches
 * the model too; a turn whose text the health gate catches never does (stage 4), so it carries no health text.
 */
const NON_HEALTH_TOOLS: ReadonlySet<string> = new Set(['propose_profile', 'propose_plan', 'propose_navigation']);

/** The tools a turn offers (R3, R4). */
function toolsFor(mode: Mode, aiHealth: boolean): AiTool[] {
  if (mode === 'rule_help') return MENTOR_TOOLS.filter((t) => t.name === 'propose_rule');
  return aiHealth ? MENTOR_TOOLS : MENTOR_TOOLS.filter((t) => NON_HEALTH_TOOLS.has(t.name));
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
  /** Ingredient ids a saved rule already covers at a stricter level (their card was dropped, Step 12 S13 ruling). */
  onFile?: string[];
}

/** Stage 7: each validated, post-checked call becomes a card or a refusal line. The model's text is never used (R9). */
function cardsFromCalls(
  deps: TurnDeps,
  calls: ToolArgs[],
  req: TurnRequest,
  healthData: boolean,
  recipes: readonly { slug: string; title: string }[],
  pantry: readonly { id: string; name: string; ingredientId: string | null }[],
  saved: readonly Rule[] = [],
  week: { planCtx: PlanCardContext | null; recipes: RecipeIndex } = { planCtx: null, recipes: new Map() },
): Reply {
  const parts: ReplyPart[] = [];
  const cards: ProposalCard[] = [];
  const onFile: string[] = [];
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
        // S13 (core, shared with the client's engine and intake): already on file at a stricter level → say so, offer nothing.
        const onFileLine = r.ok ? alreadySavedLine(r.card, saved, deps.catalog.graph, deps.catalog.ruleTerms) : null;
        if (r.ok && onFileLine !== null) {
          onFile.push(...r.card.rule.target.ids);
          parts.push({ kind: 'line', line: onFileLine });
        } else if (r.ok) add(r.card);
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
      case 'propose_pantry_change': {
        // Step 5 carry: each removal is resolved to the player's own pantry rows now. The card reads
        // back exactly those rows and the confirm removes exactly their ids; a name that matches
        // nothing is said plainly and is on no card.
        const removeIds: string[] = [];
        const removeNames: string[] = [];
        const missing: string[] = [];
        for (const name of call.args.remove) {
          const matches = pantry.filter(pantryMatcher([name], [], deps.catalog.graph));
          if (matches.length === 0 && name.trim() !== '') missing.push(name.trim());
          for (const m of matches) {
            if (removeIds.includes(m.id)) continue;
            removeIds.push(m.id);
            if (!removeNames.includes(m.name)) removeNames.push(m.name);
          }
        }
        if (call.args.add.length > 0 || removeNames.length > 0) {
          add({ ...buildPantryCard({ add: call.args.add, remove: removeNames }, deps.catalog.graph), removeIds });
        }
        if (missing.length > 0) parts.push(line('pantry.not_found', { items: listWords(missing) }));
        break;
      }
      case 'propose_plan': {
        // Plans are health data (Step 6 ruling): without health_data, the consent card, never a card.
        if (!healthData || week.planCtx === null) {
          needsConsent();
          break;
        }
        const a = call.args;
        const request: PlanRequest = { days: a.days, pick: a.pick, hard: a.hard_week, after: a.after };
        const built = planReply(request, week.planCtx);
        if (built.card !== null) cards.push(built.card);
        parts.push(...built.parts);
        break;
      }
      case 'propose_navigation': {
        const a = call.args;
        const target: NavTarget = a.to === 'visit' ? { to: a.to, cook: a.id! } : a.to === 'recipe' ? { to: a.to, slug: a.id! } : { to: a.to };
        parts.push(goPart(target, deps, week.recipes));
        break;
      }
    }
  }
  return { parts, cards, toolTurn: true, onFile };
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

/**
 * Ingredient ids the turn accounts for: rule-card targets, ambiguous-term options, and the
 * non-allergen names a meal or pantry card carries. A meal or pantry card never covers a major
 * allergen (fix round 1, C1): "peanut butter toast … allergic to peanuts" still asks about peanut.
 */
export function coveredIds(reply: Reply, graph: IngredientGraph): string[] {
  const ids: string[] = [...(reply.onFile ?? [])];
  for (const c of reply.cards) if (c.kind === 'rule') ids.push(...c.rule.target.ids);
  // C1 over-ask (M4 final): what a meal or pantry card names is accounted for, except a major allergen (never covered by one).
  for (const c of reply.cards) {
    if (c.kind === 'meal') ids.push(...nonAllergenNamedIds(c.meal.item.kind === 'free' ? c.meal.item.description : c.summary, graph));
    if (c.kind === 'pantry') ids.push(...nonAllergenNamedIds([...c.add.map((a) => a.name), ...c.remove].join(', '), graph));
  }
  ids.push(...reply.parts.flatMap((p) => (p.kind === 'choices' ? p.options.map((o) => o.id) : [])));
  // A which-kind ask ("herbs", C1) accounts for its broad category too: the ask is its answer, never a second ask.
  // Only a which-kind ask's own choices (N2): a which-one ask's hits ("curry" → curry leaf) never cover "herbs".
  const kindChoices = reply.parts.flatMap((p, i) => {
    const before = i > 0 ? reply.parts[i - 1] : undefined;
    return p.kind === 'choices' && before?.kind === 'line' && before.line.trigger === 'rule.which_kind' ? p.options.map((o) => o.id) : [];
  });
  ids.push(...broadKindsAsked(kindChoices, graph));
  return ids;
}

/**
 * Step 12 carry of the Step 11 structural ruling, "every named allergen gets a card or an ask", with the
 * client's intake rule (core `leftoverNamedIngredients`): on a turn whose player words state a rule (or
 * answer the allergies step), each ledger name no card covers gets `rule.ask_what_else` naming it, and a
 * name said as fine ("but not tree nuts") is never a card and gets `rule.exclusion_not_kept`. Replaces
 * the single ask of `askForDroppedTerms`. Edits `reply` in place.
 */
function askForLeftoverNames(reply: Reply, raw: string, intakeStep: TurnRequest['intakeStep'], graph: IngredientGraph): void {
  const own = stripPageEvents(playerOwnWords(raw)).text;
  const statesRule = intakeStep === 'allergies' || ruleTermsInPlayerWords(raw).length > 0 || statesSevere(raw, graph) || severityFromText(own, graph) !== null;
  // Without health_data nothing can be filed: the consent card asks the player to say it again.
  if (!statesRule || reply.parts.some((p) => p.kind === 'consent')) return;
  const { left, excluded } = leftoverNamedIngredients(raw, coveredIds(reply, graph), graph);
  if (left.length === 0 && excluded.length === 0) return;
  // A named ask already there (askForDroppedTerms' severe ask) is never removed (C1); only its unnamed
  // form and a bare "didn't understand" give way to the named asks, and no name is asked twice.
  const isAsk = (p: ReplyPart) => p.kind === 'line' && p.line.trigger === 'rule.ask_what_else';
  const askedAlready = new Set(reply.parts.flatMap((p) => (isAsk(p) && p.kind === 'line' && p.line.vars.term ? [p.line.vars.term] : [])));
  // A name the player said is fine ("but not sesame") is the one exception: asking about it would contradict exclusion_not_kept.
  reply.parts = reply.parts.filter(
    (p) =>
      !(
        p.kind === 'line' &&
        (p.line.trigger === 'didnt_understand' ||
          (p.line.trigger === 'rule.ask_what_else' && (!p.line.vars.term || excluded.includes(p.line.vars.term))))
      ),
  );
  for (const term of left) if (!askedAlready.has(term)) reply.parts.push(line('rule.ask_what_else', { term }));
  for (const term of excluded) reply.parts.push(line('rule.exclusion_not_kept', { term }));
}

/** A dish called fine or safe in the player's words (M5 Step 8, P02): the Pan points at the dish card instead. */
const FIT_CLAIM = /\b(safe|unsafe|fine (for|with|to eat)|ok(ay)? (for|with)|alright (for|with)|[a-z]+-free|in the clear|no problem)\b/;

const RULE_OUTCOME_LINES = new Set([
  'rule.unknown_term',
  'rule.which_one',
  'rule.which_kind',
  'consent.health_first',
  'rule.ask_what_else',
  'rule.ask_keep_off',
  'rule.exclusion_not_kept',
  'rule.already_saved',
]);
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
 * Stages 7–9 in one transaction, in the README lock order: live user (a turn
 * racing an account delete is a 401, P5; the global cost and the player's usage
 * were already counted on their own, N6 and M-7) → consent row (share-locked; `persist` and the health cards are
 * decided from it, never from an earlier read) → conversation row → messages
 * → mentor_proposals. A concurrent withdraw-with-delete either waits and then
 * deletes what this stored, or commits first and this stores nothing health.
 */
async function finishTurn(deps: TurnDeps, userId: string, f: FinishInput, now: Date): Promise<TurnResponse> {
  const graph = deps.catalog.graph;
  const offered = new Set(f.offered.map((t) => t.name));
  // A name the player said is fine ("peanuts but not sesame", "PECAN not peanut") is never a card (Step 11 ruling).
  const fine = new Set(leftoverNamedIngredients(f.raw, [], graph).excluded.flatMap((n) => graph.resolve(n) ?? []));
  const index = await deps.week.recipes.current(deps.db);
  const calls = applyPostChecks(
    f.result.toolCalls
      .filter((c) => offered.has(c.name))
      .map(parseToolCall)
      .filter((c): c is ToolArgs => c !== null),
    f.raw,
    graph,
    deps.catalog.ruleTerms,
    { cooks: deps.week.loop.cooks, slugs: new Set(index.keys()) },
  ).filter((c) => !(c.name === 'propose_rule' && fine.has(graph.resolve(c.args.term) ?? '')));
  // M5 Step 8: a plan clause code reads in the player's own words ("put the frijoles on Saturday's plan", "pick 3")
  // is proposed when the model made no plan call, as a removal the player said is (M4 post-checks): code wins where
  // it can read the player's words. Only when the plan tool is offered this turn.
  const words = offered.has('propose_plan') && !calls.some((c) => c.name === 'propose_plan') ? planWordsIn(f.raw) : null;
  if (words !== null) calls.push({ name: 'propose_plan', args: { days: words.days, pick: words.pick, hard_week: words.hard, after: words.after } });
  return deps.db.transaction(async (tx) => {
    await lockLiveUser(tx, userId);
    const persist = await consentHeldIn(tx, userId, 'health_data', now);
    const recipes = await tx.select({ slug: canonRecipes.slug, title: canonRecipes.title }).from(canonRecipes);
    const dishNamed = f.dishOnScreen || matchDish(f.stripped, recipes) !== null;
    const writeRequest = isWriteRequest(f.stripped, graph);
    let reply: Reply;
    // Read only when a removal needs resolving (no lock: the confirm locks the pantry and removes by id).
    const removes = calls.some((c) => c.name === 'propose_pantry_change' && c.args.remove.length > 0);
    const pantry = removes ? await loadPantry(tx, deps.keyring, userId) : [];
    // The saved rules, only when a rule card might be made (S13 ruling: never a card below one of them).
    const saved = persist && calls.some((c) => c.name === 'propose_rule') ? await loadRules(tx, deps.keyring, userId) : [];
    // M5 Step 8: the plan week's context, only for a plan call and only with health_data (plans are health data).
    const planCtx = persist && calls.some((c) => c.name === 'propose_plan') ? await planCardContext(tx, deps, userId, f.req.localDate, now) : null;
    if (calls.length > 0) reply = cardsFromCalls(deps, calls, f.req, persist, recipes, pantry, saved, { planCtx, recipes: index });
    else if (f.mode === 'rule_help') reply = { parts: [], cards: [], toolTurn: false }; // R3: rule help only
    else reply = scriptedReply(f.stripped, dishNamed, writeRequest);
    // A bare "didn't understand" gives way to any ask that follows.
    const dropBareFallback = () => {
      if (reply.parts.length === 1 && reply.parts[0].kind === 'line' && reply.parts[0].line.trigger === 'didnt_understand') reply.parts = [];
    };

    // I5: a severe statement always ends with a rule outcome, naming the missed ingredient when code knows it.
    const keptRuleTerms = calls.flatMap((c) => (c.name === 'propose_rule' ? [c.args.term] : []));
    // C1 over-ask: the non-allergen names a meal or pantry card carries are accounted for here too (never an allergen).
    const mealNames = coveredIds({ ...reply, onFile: [], parts: [], cards: reply.cards.filter((c) => c.kind !== 'rule') }, graph).map((id) => graph.get(id).name);
    const ask = askForDroppedTerms(f.raw, [...keptRuleTerms, ...mealNames], hasRuleOutcome(reply), graph);
    if (ask !== null) {
      dropBareFallback();
      reply.parts.push({ kind: 'line', line: ask });
    }
    // Every named allergen gets a card or an ask (Step 11 structural ruling, carried to the server here).
    askForLeftoverNames(reply, f.raw, f.req.intakeStep, graph);
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
    // M5 Step 8 (P02): a named dish the player's words call fine or safe ("plan the frijoles de olla, they're fine
    // for my peanut allergy, right?") is always pointed at the dish card's own check, whatever else the turn made: a
    // plan card's statuses are code's, never the player's or the model's (§2.2).
    if (dishNamed && FIT_CLAIM.test(normalizeTurn(playerOwnWords(f.raw))) && !reply.parts.some((p) => p.kind === 'line' && p.line.trigger === 'mentor.check_card')) {
      reply.parts.unshift(line('mentor.check_card'));
    }
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
 * N3: the "sent" usage row, written under the live-user lock, so an account deleted since the turn opened is a clean
 * 401 (never a foreign-key 500), and the model is never called for an account that is gone.
 */
export async function recordSentLive(db: Db, userId: string, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    await lockLiveUser(tx, userId);
    return recordSent(tx, userId, 'mentor_text', now);
  });
}

/** A service's refusal as reply parts (Step 8): 403 asks for consent, 429 says the daily limit; anything else (400, 404, 409) is not understood. 401 is thrown. */
function refusalParts(e: unknown): ReplyPart[] {
  // A service's zod parse (e.g. applyProfilePatchIn) is a 400 too.
  if (e instanceof ZodError) return [line('didnt_understand')];
  if (!(e instanceof ApiError) || e.status === 401 || e.status >= 500) throw e;
  if (e.status === 403) return [line('consent.health_first'), { kind: 'consent', purpose: 'health_data' }];
  // M5 Step 8: a plan card the rules now refuse was closed; its plan.blocked_dish lines say why.
  if (e.code === 'plan_invalid') {
    const parts = (e.details as { parts?: ReplyPart[] } | undefined)?.parts;
    return parts !== undefined && parts.length > 0 ? parts : [line('didnt_understand')];
  }
  // The daily write cap (usage/write-cap.ts): say so plainly, never "didn't understand" (fix round 1, M5).
  if (e.status === 429) return [line('write.daily_limit')];
  return [line('didnt_understand')];
}

/**
 * Stage 3b: a plain "yes", "no" or "undo" (Step 8). Core's `shortReplyTarget`
 * decides which card it means, as the client's engine does for local cards:
 * only a single card from the previous Pan turn, never a severe one for a
 * typed yes, never a guess between two. Returns null when the turn goes on
 * (no card to answer: the model, which has no write tools, takes it). Each
 * write is its own transaction through the write guard, which never locks a
 * conversation row (Step 6 carry); nothing of these turns is stored.
 */
async function shortReply(
  deps: TurnDeps,
  userId: string,
  intent: TurnIntent,
  opened: Opened,
  req: TurnRequest,
  now: Date,
  requestId: string,
): Promise<TurnResponse | null> {
  const answering = req.answering;
  if (intent !== 'yes' && intent !== 'no' && intent !== 'undo') return null;
  const id = opened.conversationId;
  const done = (parts: ReplyPart[], actions: CardAction[] = []) => respond(id, 'deterministic', parts, null, { actions });
  if (intent === 'undo') {
    try {
      const undone = await deps.db.transaction(async (tx) => {
        const proposalId = await latestUndoable(tx, userId, now);
        if (proposalId === null) return null;
        return { proposalId, ...(await undoWriteIn(tx, deps, userId, proposalId, now, requestId)) };
      });
      if (undone === null) return done([line('undo.nothing')]);
      return done(undone.parts, undone.undone ? [{ kind: 'undone', id: undone.proposalId }] : []);
    } catch (e) {
      // Decided or past its window since it was picked: nothing left to undo. Any other
      // refusal (a 400 from the service) is a part like confirm's, never an HTTP error.
      if (e instanceof ApiError && e.status === 409) return done([line('undo.nothing')]);
      return done(refusalParts(e));
    }
  }
  const open = await deps.db.transaction((tx) => openProposalsOfConversation(tx, deps.keyring, userId, id, now));
  // M4 final I-1: a plain yes or no answers only the card the client names (the one recent server card it shows),
  // and only while that card is open in this conversation. No id, or another one, and nothing is written: the
  // server's turn count can't line up with the panel's (client-only turns, retries), so it never picks a card itself.
  // The lines that write nothing ("tap the card", "that one needs a tap") still come from every open card.
  const refs: OpenCardRef[] = open
    .filter((p) => answering === undefined || p.id === answering)
    .map((p) => ({
      ref: p.id,
      severe: p.severe || isSevereCard(p.card),
      ingredient: p.card.kind === 'rule' ? p.card.display.ingredient : null,
      issuedTurn: p.turnSeq ?? -1,
    }));
  if (answering !== undefined && refs.length === 0) return null;
  const target = shortReplyTarget(intent, refs, opened.turnSeq);
  if ((target.kind === 'confirm' || target.kind === 'reject') && target.ref !== answering) return null;
  switch (target.kind) {
    case 'none':
    case 'undo':
      return null;
    case 'line':
      return done([{ kind: 'line', line: target.line }]);
    case 'confirm':
      try {
        // A plan card's week window reads the player's local date (Step 6 I2); a plan the rules now refuse is closed.
        const r = await confirmProposal(deps.db, deps, userId, target.ref, 'typed_yes', undefined, now, requestId, undefined, req.localDate);
        return done(r.parts, [{ kind: 'confirmed', proposalId: target.ref, trail: r.trail }]);
      } catch (e) {
        return done(refusalParts(e));
      }
    case 'reject':
      try {
        const r = await deps.db.transaction((tx) => rejectProposalIn(tx, deps, userId, target.ref, now, requestId));
        return done(r.parts, [{ kind: 'rejected', proposalId: target.ref }]);
      } catch (e) {
        return done(refusalParts(e));
      }
  }
}

/**
 * Stage 5b (M5 Step 8): `planIntent` / `navIntent` on the player's own words. A navigation is one `go` part (a chip;
 * nothing is stored). A plan is a card from core `buildPlanCard`, made under the finishing turn's locks (live user
 * → health_data share lock → conversation row → messages → mentor_proposals), stored like a model card so a tap or a
 * typed yes can confirm it; without health_data (plans are health data) it is the consent card and no card. Null
 * when code reads neither.
 */
async function codeRoute(deps: TurnDeps, userId: string, raw: string, req: TurnRequest, opened: Opened, now: Date): Promise<TurnResponse | null> {
  const id = opened.conversationId;
  const plan = planIntent(raw);
  const index = await deps.week.recipes.current(deps.db);
  const nav = plan === null ? navIntent(raw, { cooks: deps.week.loop.cooks, slugs: new Set(index.keys()) }) : null;
  if (nav !== null) return respond(id, 'deterministic', [goPart(nav, deps, index)]);
  if (plan === null) return null;
  return deps.db.transaction(async (tx) => {
    await lockLiveUser(tx, userId);
    const persist = await consentHeldIn(tx, userId, 'health_data', now);
    if (!persist) return respond(id, 'deterministic', [line('consent.health_first'), { kind: 'consent', purpose: 'health_data' }]);
    const built = planReply(plan, await planCardContext(tx, deps, userId, req.localDate, now));
    if (!(await lockConversation(tx, userId, id))) return respond(id, 'deterministic', built.parts);
    const ids = built.card === null ? [] : [randomUUID()];
    const stripped = stripPageEvents(raw).text.trim();
    await appendMessages(tx, deps.keyring, deps.memory, userId, id, [{ role: 'player', text: stripped }, { role: 'pan', parts: built.parts, proposalIds: ids }], true, now);
    const cards: ServerCard[] = [];
    if (built.card !== null) cards.push(await createProposal(tx, deps.keyring, { userId, conversationId: id, turnSeq: opened.turnSeq, card: built.card, id: ids[0] }, now));
    return respond(id, 'deterministic', built.parts, null, { cards });
  });
}

/**
 * One mentor turn. Code goes first and the model goes last; each stage below
 * is one function. Only `propose_*` tools are offered, so a turn can make
 * cards but never write, and the model's text is never shown (R9). Neither
 * the player's text nor the model's is ever logged (C-15). `requestId` goes on the audit events of a typed yes, no or undo.
 */
export async function runTurn(deps: TurnDeps, userId: string, req: TurnRequest, requestId: string): Promise<TurnResponse> {
  const now = deps.now();
  // 1. The raw text is kept for the injection cut (C4); everything else reads the stripped text.
  const deadline = AbortSignal.timeout(MENTOR_TURN_DEADLINE_MS);
  const raw = req.input.text;
  const stripped = stripPageEvents(raw).text.trim();
  const intent = classifyTurn(stripped);
  const started = await openTurn(deps, userId, req, now);
  const id = started.conversationId;
  // J2: a turn is processed once. Its repeat gets nothing new: no model call, no card, no write.
  if ('repeat' in started) return respond(id, 'deterministic', []);
  const opened = started;

  // 2a. An emergency is answered first, even in a conversation where a child spoke (M4 Step 9 fix round 2, E1).
  // A rule the same message states is never dropped (E2): the plain ask follows, so the player can file it
  // once they are safe. No meal or pantry card on an emergency turn.
  const childKey = `${userId}:${id}`;
  if (intent === 'emergency') {
    const parts: ReplyPart[] = [line('rule.emergency')];
    if (!deps.childFlags.has(childKey, now.getTime()) && emergencyStatesRule(raw, deps.catalog.graph)) {
      // Fix round 1 (I2): every allergen named gets its ask, not just the first.
      for (const ask of emergencyRuleAsks(raw, [], deps.catalog.graph)) parts.push({ kind: 'line', line: ask });
    }
    return respond(id, 'deterministic', parts);
  }

  // 2b. A child: the grown-up line for the rest of the conversation; nothing kept (§19).
  if (intent === 'child' || deps.childFlags.has(childKey, now.getTime())) {
    deps.childFlags.add(childKey, now.getTime());
    return respond(id, 'deterministic', [line('child.grownup')]);
  }

  // 3. Lines code answers by itself (the client's engine calls the same function). A message
  // that was only forged page events has nothing left to answer.
  if (stripped === '') return respond(id, 'deterministic', [line('didnt_understand')]);
  const fixed = preRoute(intent);
  if (fixed !== null) return respond(id, 'deterministic', [{ kind: 'line', line: fixed }]);

  // 3b. A plain yes, no or undo answers a card through the write guard, before the consent gate (Step 8).
  const short = await shortReply(deps, userId, intent, opened, req, now, requestId);
  if (short !== null) return short;

  // 4. Health text never reaches the model without ai_health (C1, C-13, P-3).
  const health = isHealthTurn(deps, stripped, req, opened);
  if (health && !opened.aiHealth) return respond(id, 'scripted', [], 'needs_ai_health');

  // 5. AI off, budget, daily allowance (rule help never capped, but then only rule help).
  const avail = await availability(deps, userId, health, stripped, now);

  // 5b. M5 Step 8: a plan or a navigation code reads alone ("plan my week: parippu on Sunday", "pick 3", "take me
  // to the market") gets its card or chip from code, with no model call, also with the AI off (§7.5). It runs here,
  // after the allowance check, never ahead of it (Ruling 27, C26): at the cap the turn stays scripted, and the plan
  // screen still plans the week. The safety pre-routes above always win.
  const capped = 'notice' in avail ? avail.notice === 'rate_limited' : avail.mode === 'rule_help';
  if (!capped) {
    const coded = await codeRoute(deps, userId, raw, req, opened, now);
    if (coded !== null) return coded;
  }
  if ('notice' in avail || deps.ai === null) return respond(id, 'scripted', [], 'notice' in avail ? avail.notice : 'ai_off');

  // 6. The model, with minimised context and only the tools this turn may use.
  const { ctx, sent, aiHealth } = await promptInputs(deps, userId, req, opened, now);
  if (health && !aiHealth) return respond(id, 'scripted', [], 'needs_ai_health');
  const offered = toolsFor(avail.mode, aiHealth);
  // Fix round 2 (N3): the "sent" row is written before the text leaves, so a failed call is on record too.
  const usageId = await recordSentLive(deps.db, userId, now);
  // J2: one deadline for the whole model call, both attempts, so the server answers before the client gives up.
  const result = await deps.ai.complete({ messages: renderMessages(deps.prompt, ctx, sent, stripped, deps.bank), tools: offered, signal: deadline });
  if (!result.ok) return respond(id, 'scripted', [], 'ai_unavailable');
  // N6: the money is counted at once, in its own statement, outside every turn lock.
  await recordAiCost(deps.db, result.usage.costMicroUsd, now);
  // M-7: the player's allowance is charged at once too, so a turn that fails after the model answered still counts.
  await completeUsage(deps.db, usageId, 1, result.usage.costMicroUsd);

  // 7–9. Cards and scripted lines (never the model's text, R9), metered and stored under the consent lock.
  return finishTurn(deps, userId, { opened, req, raw, stripped, result, dishOnScreen: ctx.dish !== null, health, mode: avail.mode, offered }, now);
}

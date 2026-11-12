// A quest errand's stall question (M6 Step 10, spec §3.5): before an errand step completes, its stall plays one of its
// own questions about the item, and the step passes whatever is answered. The question comes from the stall's bank as
// core keeps it for the player's rules today (`stallBank`, Step 1), and it must declare a `contains` id that is the
// errand's item or one of its `isA` ancestors (Marisol's black_bean errand matches an Okafor-Sato `bean` question;
// Leela's shallot errand matches none, since Wen has no shallot question). No question passes → nothing is shown.
// The answer is kept as a one-answer `stall_round` (never in Family Table); the step's completion never depends on it.
import {
  keeperLines, nextRound, seasonalQuestions, stallBank,
  type AnsweredMap, type IngredientGraph, type MarketCtx, type StallFile, type StallQuestion,
} from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph as appGraph } from '../content';
import type { ClientStall, MarketContent } from '../content/types';
import { loadMarket } from '../market/content';
import { recordRound } from '../market/record';
import type { RoundDeps } from '../market/round-view';
import { keeperName, marketCtxFor, profileFor, seasonFor } from '../market/stall-context';
import { gameLabel, itemArt, panLine, pickLine, priceFootnote, stillAnswerable } from '../market/stall-screen';
import { withMarket } from '../progress/catalogue';
import type { ProgressService } from '../progress/service';
import { activeRules } from '../recipes/rules';
import { KEEPER_STALLS, type KeeperStall } from '../shell/router';
import { partitionKey, type PlayerStore } from '../state/store';
import { LOOKUP_TIMEOUT_MS, within } from '../shell/within';

/** What the quest runner plays for an errand: the one question, its keeper and the round's lines; `record` keeps it. */
export interface ErrandQuestion {
  question: StallQuestion;
  keeper: string;
  round: Omit<RoundDeps, 'questions' | 'keeper' | 'onEnd'>;
  /** Keeps the answers as one `stall_round` (each re-judged under the rules now); a no-op in Family Table. */
  record(answers: { q: string; pick: number }[]): void;
}

/**
 * The errand's question, or null: the first (core `nextRound` order) of the stall's kept questions that declares the
 * item or one of its `isA` ancestors in `contains`. The Protein Counter is never used here (its rounds need
 * health_data consent, Ruling 17), so a meat-free player's errand at Bram's shows none.
 */
export function errandQuestionFor(
  item: string, stall: StallFile, ctx: MarketCtx, regionId: string | null, month: number, table: MarketContent['seasonality'],
  answered: AnsweredMap, graph: IngredientGraph,
): StallQuestion | null {
  const ids = new Set([item, ...(graph.has(item) ? graph.ancestors(item) : [])]);
  const seasonal = stall.seasonal === undefined ? [] : seasonalQuestions(stall, regionId, month, table);
  const bank = stallBank(stall, ctx, seasonal);
  if (bank.variant !== 'base') return null;
  const matching = bank.questions.filter((q) => (q.contains ?? []).some((id) => ids.has(id)));
  return nextRound(matching, answered).at(0) ?? null;
}

const isKeeper = (id: string): id is KeeperStall => (KEEPER_STALLS as readonly string[]).includes(id);

/**
 * The visit screen's `errandQuestion` dep: loads the market (lazily), builds the player's MarketCtx and picks the
 * question. Null on anything it can't read (the market offline, the rules unreadable, no such stall): the errand then
 * goes on exactly as in M5.
 */
export function errandQuestions(deps: {
  store: PlayerStore; client: Pick<ApiClient, 'getProfile'>; service: Pick<ProgressService, 'record' | 'view'>; today: () => string;
  load?: () => Promise<MarketContent>;
  /** Fix round 1 (I2): the most the market load and the profile read may take (≤ 3 s); then no question. */
  timeoutMs?: number;
}): (step: { stall: string; item: string }) => Promise<ErrandQuestion | null> {
  const load = deps.load ?? loadMarket;
  return async (step) => {
    if (!isKeeper(step.stall)) return null;
    const stallId = step.stall;
    const partition = partitionKey(deps.store.get());
    const wait = deps.timeoutMs ?? LOOKUP_TIMEOUT_MS;
    // I2: a slow or stalled market chunk never holds the errand: no question, and the step goes on as in M5.
    const market = await within(load(), wait, null);
    if (market === null) return null;
    withMarket(market);
    const stall: ClientStall = market.stalls[stallId];
    const profile = await within(profileFor(deps.store.get(), deps.client), wait, null);
    if (profile === null) return null;
    const ctxNow = (): MarketCtx | null => {
      const rules = activeRules(deps.store.get(), appGraph);
      return marketCtxFor(rules.status === 'ready' ? rules.rules : null, profile, deps.today(), appGraph, [...content.substitutions]);
    };
    const ctx = ctxNow();
    if (ctx === null) return null;
    const { regionId, month } = seasonFor(profile, market.seasonality, ctx.date);
    const answered: AnsweredMap = new Map(Object.entries(deps.service.view().marketAnswered));
    const question = errandQuestionFor(step.item, stall, ctx, regionId, month, market.seasonality, answered, appGraph);
    if (question === null) return null;
    const lineFor = (trigger: string, q: string) => pickLine(keeperLines(stall, trigger, ctx), `${stallId}|${trigger}|${q}`);
    return {
      question,
      keeper: keeperName(stall, ctx),
      round: {
        gameName: (game) => gameLabel(game, ctx),
        keeperLine: (trigger, q) => lineFor(trigger, q),
        panLine: (trigger, q) => panLine(trigger, `${stallId}|${q}|${trigger}`, ctx),
        canAnswer: (q) => stillAnswerable(stall, q.id, ctxNow()),
        itemArt: (i) => itemArt(i),
        itemName: (i) => (appGraph.has(i) ? appGraph.get(i).name : null),
        priceFootnote: priceFootnote(),
      },
      record: (answers) => {
        // Never into another account's partition (Step 9 M4), and each answer re-judged under the rules now (I2).
        if (partitionKey(deps.store.get()) !== partition) return;
        const kept = answers.filter((a) => stillAnswerable(stall, a.q, ctxNow()));
        recordRound({ store: deps.store, record: (events) => deps.service.record(events) }, stallId, kept, deps.today());
      },
    };
  };
}

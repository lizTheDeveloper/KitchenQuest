import {
  alreadySavedLine, askForDroppedTerms, buildMealCard, buildPlanCard, navIntent, navPlace, planIntent, type NavTarget, type PlanCard, type PlanContext,
  type PlanRequest, type WeeklySlotInput, emergencyRuleAsks, emergencyStatesRule, isHealthText, buildPantryCard, buildProfileCard, buildRuleCard, classifyTurn, dropMealsMatchingRemovals,
  matchDish, MEAL_SLOTS, MEAL_VERB_PATTERN, normalizeName, normalizeTurn, PANTRY_ADD_PATTERN, PANTRY_REMOVAL_PATTERNS,
  parseClock, parseMealStatement, parsePantryAdds, parsePantryRemovals, parseRuleStatement, parseWeekdays, preRoute,
  shortReplyTarget, slotClause, slotForTime, stripPageEvents,
  type IngredientGraph, type LineRef, type MealSlot, type OpenCardRef, type ProposalCard, type Rule, type RuleTerm, type Severity,
} from '@kitchenquest/core/engine';
import { localDate } from '../recipes/rules';
import type { ChildFlag } from './child-flag';
import type { Dialogue } from './dialogue';
import type { CardView, LocalCardView, LocalIntent, PanItem, PanReply, TurnContext } from './reply';

/**
 * The scripted mentor: no AI, no network, no account. Every decision the server agent also makes comes from
 * the same core functions (pre-flight C14): `preRoute`, `shortReplyTarget`, the parsers, the card builders,
 * `matchDish`, `dropMealsMatchingRemovals`, the meal-window clock and the ask-for-dropped-terms rule. The engine
 * builds cards and says their read-backs through the dialogue; it never builds safety text itself, and it never
 * writes: confirming is the writer's job, on a tap or a typed yes it hands over as a LocalIntent.
 */
export interface ScriptedEngine {
  reply(text: string, ctx: TurnContext): PanReply;
  /** A local rule card for the option the player tapped in a `choices` item. */
  cardFromChoice(id: string, severity: Severity | null, turn: number): LocalCardView;
}

/** Weekday words, and the day words that name no single day (the Pan asks which day: `plan.which_day`). */
const WD = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat)s?';
const LOOSE_LEAD = /^(?:plan|sort) (?:my|the|this) week\s*(?::|,|-|$)\s*/;
const LOOSE_PICK_AFTER = /^(?:pick|choose) (?:\d|one|two|three|four|five|six|seven)(?: (?:dishes|dinners|meals|things))?(?: for (?:this|the|my) week)? after (.+)$/;
const LOOSE_DISH_ON = /^(put )?(?:the )?(.+?) (?:on|for) (.+)$/;
const LOOSE_DISH_WD = new RegExp(`^(put )?(?:the )?(.+?) (${WD})$`);
const WEEKDAY_ONLY = new RegExp(`^${WD}$`);
const NUMBER_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

/**
 * A plan request the closed grammar (`planIntent`) refused, read only to say what the Pan can't place (Ruling 22,
 * C1): a dish name the cooks don't teach ("dal on Sunday" → `plan.dish_unknown`), a day that names no single day
 * (`plan.which_day`), "pick N after <not one day>" (`plan.after_which_day`). Every clause must be one of these
 * shapes, and without the "plan my week" lead each dish clause needs "put" or a weekday. Never a card: the player's
 * words come back in the asks, and nothing is planned from this reading.
 */
function loosePlan(own: string): PlanRequest | null {
  if (own.includes('?')) return null;
  const s = own.replace(/[.!]+$/, '');
  const lead = LOOSE_LEAD.exec(s);
  const clauses = (lead ? s.slice(lead[0].length) : s).split(/\s*(?:[,;]+|\band\b|\bthen\b)\s*/).map((c) => c.trim()).filter((c) => c !== '');
  if (clauses.length === 0) return null;
  const days: { weekday: string; dish: string }[] = [];
  let pick: number | null = null;
  let after: string | null = null;
  for (const c of clauses) {
    let m: RegExpExecArray | null;
    if ((m = LOOSE_PICK_AFTER.exec(c)) !== null && pick === null) {
      const n = /\d/.exec(c)?.[0];
      pick = n !== undefined ? Number(n) : NUMBER_WORDS[/(one|two|three|four|five|six|seven)/.exec(c)![1]];
      after = m[1];
      continue;
    }
    m = LOOSE_DISH_ON.exec(c) ?? LOOSE_DISH_WD.exec(c);
    if (m === null) return null;
    const [, put, dish, day] = m;
    if (dish.split(/\s+/).length > 4) return null;
    if (lead === null && put === undefined && !WEEKDAY_ONLY.test(day)) return null;
    days.push({ weekday: day, dish });
  }
  return { days: days.length > 0 ? days : null, pick, hard: null, after };
}

/** The lines a loose plan reading may say: the asks, never a read-back or a card. */
const ASK_TRIGGERS: ReadonlySet<string> = new Set(['plan.dish_unknown', 'plan.which_day', 'plan.after_which_day', 'plan.dish_sacred']);

/** The player says when they shop: a profile `marketDays` card, with the days named. */
const MARKET_WORD = /\b(market|shop|shopping)\b/;
/** Words that make a slot word a schedule ("lunch at …", "remind me … dinner"); "what's for dinner" has none. */
const SCHEDULE_CUE = /\b(remind|reminder|usually|normally|always|schedule|window|at|around|about|by|from|o'?clock|am|pm|noon|midday|midnight|half|quarter)\b|\d/;
const WINDOW_SLOTS: readonly MealSlot[] = MEAL_SLOTS.filter((s) => s !== 'other');
const DAY_MS = 86_400_000;

/** Where `re` first matches `t`, or -1. */
function indexOf(re: RegExp, t: string): number {
  const m = new RegExp(re.source, re.flags.replace('g', '')).exec(t);
  return m ? m.index : -1;
}

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** One reply item and the card that goes with it, placed where its match starts in the text (pre-flight C31). */
interface Found { at: number; items: PanItem[]; card?: ProposalCard }

export function createScriptedEngine(deps: {
  dialogue: Dialogue; graph: IngredientGraph; ruleTerms: RuleTerm[]; recipes: { slug: string; title: string }[]; now: () => Date;
  /** The player's saved rules (account or device): a rule card below one of them is never offered (S13, M-5). */
  savedRules?: () => readonly Rule[];
  /** The conversation's child flag (m-4), shared with the local safety check and the intake. */
  child?: ChildFlag;
  /**
   * M5 Step 10: the plan card's context now (week, stored items, rules, One More Technique), or null while the rules
   * can't be read. Without it the engine plans nothing.
   */
  week?: () => (PlanContext & { slot: WeeklySlotInput }) | null;
  /** M5 Step 10: navigation chips' places: the cooks by id with their display names. */
  cooks?: Readonly<Record<string, string>>;
  /** What the player sees when the rules can't be read (the rules screen's own copy). */
  rulesError?: () => PanItem;
}): ScriptedEngine {
  const { dialogue, graph, ruleTerms, recipes } = deps;
  const say = (l: LineRef): PanItem => ({ kind: 'said', said: dialogue.say(l.trigger, l.vars) });
  const line = (trigger: string, vars: Record<string, string> = {}): PanItem => say({ trigger, vars });
  const view = (card: ProposalCard, turn: number): LocalCardView => ({ origin: 'local', localId: crypto.randomUUID(), card, issuedTurn: turn });
  const reply = (items: PanItem[], extra: { cards?: CardView[]; intents?: LocalIntent[] } = {}): PanReply =>
    ({ items, cards: extra.cards ?? [], intents: extra.intents ?? [], actions: [], notice: null });
  /** A card and its read-back, spoken from the card's own LineRefs (§7.6b.2). */
  const withReadback = (at: number, card: ProposalCard): Found => ({ at, card, items: card.readback.map(say) });

  /** A `go` chip with its `nav.offer` line (Ruling 15): nothing moves until the player taps it. */
  const goItem = (target: NavTarget): PanItem => {
    const name = target.to === 'visit' ? (deps.cooks?.[target.cook] ?? null)
      : target.to === 'recipe' ? (recipes.find((r) => r.slug === target.slug)?.title.replace(/\s*\([^)]*\)\s*$/, '').trim() ?? null) : null;
    return { kind: 'go', target, said: dialogue.say('nav.offer', { place: navPlace(target, name) }) };
  };
  /** Code reads a plan (planIntent's closed grammar, as the server does): the plan card, or the lines when nothing is planned. */
  const planReply = (req: PlanRequest, turn: number): PanReply => {
    const ctx = deps.week?.() ?? null;
    if (ctx === null) return reply(deps.rulesError ? [deps.rulesError()] : [line('didnt_understand')]);
    const built = buildPlanCard(req, ctx);
    if ('none' in built) return reply(built.none.map(say));
    const card: PlanCard = built;
    return reply(card.readback.map(say), { cards: [view(card, turn)] });
  };

  /** Step 4 of the reply: every parser runs, so a multi-intent turn yields several items. */
  function parseAll(raw: string, text: string, ctx: TurnContext): { items: PanItem[]; cards: ProposalCard[] } {
    const t = normalizeTurn(text);
    const found: Found[] = [];
    const now = deps.now();

    // Rules: one card per term, or why there is none.
    const statement = parseRuleStatement(text, graph);
    const ruleFallback = Math.max(0, indexOf(/allerg|intoleran|anaphyla|can'?t|cannot|avoid|don'?t eat/, t));
    let ruleOutcome = false;
    for (const item of statement?.items ?? []) {
      const at = t.indexOf(item.term);
      const where = at < 0 ? ruleFallback : at;
      const built = buildRuleCard({ term: item.term, severity: item.severity }, graph, ruleTerms);
      ruleOutcome = true;
      const onFile = built.ok ? alreadySavedLine(built.card, deps.savedRules?.() ?? [], graph, ruleTerms) : null;
      if (onFile !== null) found.push({ at: where, items: [say(onFile)] });
      else if (built.ok) found.push(withReadback(where, built.card));
      else if (built.reason === 'unknown_term') found.push({ at: where, items: [say(built.line)] });
      else found.push({ at: where, items: [say(built.line), { kind: 'choices', options: built.options, severity: item.severity }] });
    }

    const removals = parsePantryRemovals(text);

    // A meal: an account write (M4), so signed out it gets the plain line. A "meal" that is a removed pantry item is no meal (T05).
    const meal = parseMealStatement(text);
    if (meal !== null) {
      const dish = matchDish(meal.description, recipes);
      const kept = dropMealsMatchingRemovals([{ description: meal.description, dish: dish?.title ?? null }], removals);
      if (kept.length > 0) {
        const at = Math.max(0, indexOf(MEAL_VERB_PATTERN, t));
        if (!ctx.signedIn) found.push({ at, items: [line('log.needs_account')] });
        else {
          const eatenOn = localDate(meal.when === 'yesterday' ? new Date(now.getTime() - DAY_MS) : now);
          const slot = meal.slot ?? slotForTime(hhmm(now));
          const card = dish
            ? buildMealCard({ eatenOn, slot, dish: { slug: dish.slug, title: dish.title, servings: 1 } })
            : buildMealCard({ eatenOn, slot, description: meal.description });
          found.push(withReadback(at, card));
        }
      }
    }

    // Market days.
    const market = indexOf(MARKET_WORD, t);
    if (market >= 0) {
      const days = parseWeekdays(text);
      if (days.length > 0) found.push(withReadback(market, buildProfileCard({ marketDays: days })));
    }

    // Meal windows: the clock in the clause naming each slot; `end` comes from core (`windowEnd`), so PUT /profile takes it.
    if (meal === null) {
      const windows: { at: number; name: MealSlot; start: string }[] = [];
      let badAt = -1;
      for (const slot of WINDOW_SLOTS) {
        const clause = slotClause(t, slot);
        if (clause === null || !SCHEDULE_CUE.test(clause)) continue;
        const start = parseClock(clause);
        const at = t.indexOf(clause);
        if (start !== null) windows.push({ at, name: slot, start });
        else if (badAt < 0) badAt = at;
      }
      windows.sort((a, b) => a.at - b.at);
      if (windows.length > 0) {
        found.push(withReadback(windows[0].at, buildProfileCard({ mealWindows: windows.map(({ name, start }) => ({ name, start })) })));
      }
      if (badAt >= 0) found.push({ at: badAt, items: [line('schedule.bad_time')] });
    }

    // Pantry: one card for everything added and used up.
    const adds = parsePantryAdds(text).filter((a) => !removals.some((r) => normalizeName(r) === normalizeName(a)));
    if (adds.length + removals.length > 0) {
      const starts = [PANTRY_ADD_PATTERN, ...PANTRY_REMOVAL_PATTERNS].map((re) => indexOf(re, t)).filter((i) => i >= 0);
      found.push(withReadback(starts.length > 0 ? Math.min(...starts) : t.length, buildPantryCard({ add: adds, remove: removals }, graph)));
    }

    return finish(found, raw, statement?.terms ?? [], ruleOutcome);
  }

  function finish(found: Found[], raw: string, ruleTermsSaid: string[], ruleOutcome: boolean): { items: PanItem[]; cards: ProposalCard[] } {
    // Items in the order their match starts in the text, whatever order the parsers ran in (stable for ties).
    found.sort((a, b) => a.at - b.at);
    const items = found.flatMap((f) => f.items);
    const cards = found.flatMap((f) => (f.card ? [f.card] : []));
    // The ask-for-dropped-terms rule, the server's own (Step 7 "Carry from Step 1"): intake answers included.
    const ask = askForDroppedTerms(raw, ruleTermsSaid, ruleOutcome, graph);
    if (ask !== null) items.push(say(ask));
    return { items, cards };
  }

  return {
    reply(text, ctx) {
      // 1. Page-event lookalikes never arrive as the player's words (§7.6b.4).
      const stripped = stripPageEvents(text).text.trim();
      const intent = classifyTurn(stripped);
      // §19 / m-4: once a child spoke in this conversation, every later turn gets the grown-up line and nothing is
      // offered or written. Only an emergency still gets its line (below), with no ask.
      if (intent === 'child') deps.child?.set();
      const child = intent === 'child' || deps.child?.on === true;
      if (child && intent !== 'emergency') return reply([line('child.grownup')]);
      if (stripped === '') return reply([line('didnt_understand')]);
      // 2. The fixed lines (emergency, medical, child, allowance, thanks): the server's own function.
      const fixed = preRoute(intent);
      if (fixed !== null) {
        // E2/F3 (ruling M-2): an emergency that also states a rule gets the emergency line first, then an ask for every
        // allergen named, exactly as the server answers it (turn.ts stage 2a). No card of any kind on an emergency turn.
        if (intent !== 'emergency' || child || !emergencyStatesRule(text, graph)) return reply([say(fixed)]);
        return reply([say(fixed), ...emergencyRuleAsks(text, [], graph).map(say)]);
      }
      // 3. A plain yes, no or undo: core decides which card it means. A typed yes never confirms a severe card.
      if (intent === 'yes' || intent === 'no' || intent === 'undo') {
        // Step 9 carry: while more than one card of either origin is open, a plain yes or no never picks one.
        const recentCount = ctx.openCards.filter((c) => c.issuedTurn === ctx.turn - 1).length;
        // Undo goes by the trail, not the cards (fix round 1, M1).
        if (intent !== 'undo' && recentCount > 0 && ctx.openCards.length > 1) return reply([line('confirm.tap_card')]);
        // Server cards count too: with a local and a server card both open, a yes never confirms either.
        const refs: OpenCardRef[] = ctx.openCards.map((c) => ({
          ref: c.origin === 'local' ? c.localId : `server:${c.proposalId}`,
          severe: c.card.kind === 'rule' && c.card.severe, ingredient: c.card.kind === 'rule' ? c.card.display.ingredient : null, issuedTurn: c.issuedTurn,
        }));
        const target = shortReplyTarget(intent, refs, ctx.turn);
        switch (target.kind) {
          case 'confirm':
          case 'reject':
            // A server card is answered by its own tap here: this engine never sends a typed yes for it.
            if (target.ref.startsWith('server:')) return reply([line('confirm.tap_card')]);
            return reply([], { intents: [{ kind: target.kind, localId: target.ref }] });
          case 'undo':
            return reply([], { intents: [{ kind: 'undo' }] });
          case 'line':
            return reply([say(target.line)]);
          case 'none':
            break;
        }
      }
      // 3b. M5 Step 10: the week by code alone (§7.5): a plan in the closed grammar, else a navigation chip.
      if (deps.week) {
        const plan = planIntent(text, recipes);
        if (plan !== null) return planReply(plan, ctx.turn);
        const nav = navIntent(text, { cooks: new Set(Object.keys(deps.cooks ?? {})), slugs: new Set(recipes.map((r) => r.slug)) });
        if (nav !== null) return reply([goItem(nav)]);
      }
      // 4. Every parser; 5. nothing found.
      const { items, cards } = parseAll(text, stripped, ctx);
      // A health turn is never silently lost: with nothing read, the plain ask, as the server does (fix round 2, E4).
      if (items.length === 0 && deps.week && !isHealthText(stripped, graph, ruleTerms)) {
        // A plan the closed grammar refused: only the asks for what can't be placed (Ruling 22: "dal" is never a guess).
        const loose = loosePlan(normalizeTurn(stripped));
        const week = loose === null ? null : deps.week();
        if (loose !== null && week !== null) {
          const built = buildPlanCard(loose, week);
          const asks = ('none' in built ? built.none : built.readback).filter((l) => ASK_TRIGGERS.has(l.trigger));
          if (asks.length > 0) return reply(asks.map(say));
        }
      }
      if (items.length === 0) {
        const health = isHealthText(stripped, graph, ruleTerms) || ctx.intakeStep === 'allergies' ||
          ctx.openCards.some((c) => c.card.kind === 'rule' || c.card.kind === 'meal');
        return reply([line(health ? 'rule.ask_keep_off' : 'didnt_understand')]);
      }
      return reply(items, { cards: cards.map((c) => view(c, ctx.turn)) });
    },

    cardFromChoice(id, severity, turn) {
      if (!graph.has(id)) throw new Error(`cardFromChoice: "${id}" is not in the ingredient graph`);
      const built = buildRuleCard({ term: graph.get(id).name, severity }, graph, ruleTerms);
      // The tapped option, exactly: never a wider or narrower reading of its name.
      if (!built.ok || built.card.rule.target.ids.length !== 1 || built.card.rule.target.ids[0] !== id) {
        throw new Error(`cardFromChoice: "${id}" did not build a card for itself`);
      }
      return view(built.card, turn);
    },
  };
}

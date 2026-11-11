import {
  alreadySavedLine, askForDroppedTerms, broadKindsAsked, buildPantryCard, buildProfileCard, buildRuleCard, classifyTurn, leftoverNamedIngredients, LIST_SPLIT, normalizeName,
  normalizeTurn, parseCount, parsePantryAdds, parseRuleStatement, parseWeekdays, preRoute, stripPageEvents, WEEKDAY_NAMES,
  type IngredientGraph, type IntakeStep, type LineRef, type ProposalCard, type RuleCardResult, type RuleTerm, type Severity,
} from '@kitchenquest/core/engine';
import { healthConsent, type ApiClient } from '../api/client';
import type { BureauForm } from '../content/types';
import type { PlayerStore } from '../state/store';
import { contentText, h } from '../ui/dom';
import type { MentorBackend } from './backend';
import type { ChildFlag } from './child-flag';
import { savedRules } from './saved-rules';
import type { Dialogue } from './dialogue';
import type { MentorPanel } from './panel';
import type { CardView, ConsentAnswer, LocalCardView, PanItem, PanReply, TurnContext } from './reply';
import type { ScriptedEngine } from './scripted';

/**
 * Form 1-A, the intake interview, by conversation (spec §13 M4, M4 Step 11). Scripted first: the Pan asks with
 * the written `intake.*` lines, core parses the answer, and any card it yields is stamped like any other card.
 * Only an answer code can't read goes to the AI, when the AI backend is the one in use; when the AI is off or
 * failing, the Pan asks again with quick answers, so the interview always finishes. Every question can be skipped.
 * Allergies come after the `health_data` consent card when signed in (C-17); saying no still finishes onboarding.
 */
export const INTAKE_ORDER: readonly IntakeStep[] = ['market_day', 'meals_per_week', 'region', 'allergies', 'pantry'];

export type IntakeAnswer =
  | { kind: 'card'; card: ProposalCard }
  | { kind: 'none' }
  | { kind: 'done' }
  | { kind: 'skip' }
  | { kind: 'unparsed' }
  | { kind: 'reply'; reply: RuleCardResult }
  /** An allergies answer that names more than one term, or leaves a severe term out (the ask-for-dropped-terms rule). */
  | { kind: 'rules'; results: RuleCardResult[]; ask: LineRef | null; notes?: LineRef[] };

export interface Intake {
  start(): void;
  answer(text: string, ctx?: TurnContext): Promise<PanReply>;
  skip(): PanReply;
  readonly step: IntakeStep | 'done' | null;
  readonly expecting: 'answer' | 'more_rules' | 'consent' | null;
}

/** Skip words come before any step parser (pre-flight C45), so "skip" never becomes `country: 'skip'`. */
const SKIP_WORD = /^(please )?(skip|skip (it|this|that|this one|that one|for now)|not now|later|maybe later|ask (me )?later|pass|i'?ll pass)( (please|thanks|thank you|for now))?$/;
const NONE_WORDS = /^(none|no|nothing|nope|that'?s all|that'?s it|no allergies)( (thanks|thank you|at all))?$/;
const PANTRY_NONE = /^(none|nothing|nothing much|not much|empty|it'?s empty|no|nope)$/;
const REGION_MAX = 80;
/** Turns the backend's local safety answers (outage.ts createLocalSafety). */
const SAFETY: ReadonlySet<string> = new Set(['emergency', 'medical', 'child']);
const REGION_LEAD = /^(i (live|am|'m) (in|from|near)|i'?m (in|from|near)|we'?re (in|from)|in|from|near|around)\s+/i;

const ANSWER_LABELS: Readonly<Record<IntakeStep, string>> = {
  market_day: 'Market day', meals_per_week: 'Meals a week', region: 'Region', allergies: 'Allergies', pantry: 'Pantry',
};
/** The Form 1-A field each step ticks. */
const FIELD: Readonly<Record<IntakeStep, string>> = {
  market_day: 'market_day', meals_per_week: 'meals_per_week', region: 'region', allergies: 'rules', pantry: 'pantry',
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const joinAnd = (xs: readonly string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)!}`);
/** The answer as code reads it: page-event lookalikes removed (§7.6b.4), normalised, trailing punctuation gone. */
const clean = (text: string) => normalizeTurn(stripPageEvents(text).text).trim().replace(/[.!?]+$/, '').trim();

/**
 * Not an answer to this question: a turn with its own fixed line or a health turn ("I'm allergic to peanuts" is never
 * a region or a pantry item). An ingredient name alone is fine here: "Turkey" is a country, "eggs" a pantry item.
 */
function notAnAnswer(raw: string, graph: IngredientGraph): boolean {
  return classifyTurn(raw) !== 'other' || parseRuleStatement(raw, graph) !== null;
}

/** Words before or around a bare list that are no term: "just", "only", "none except", "and". */
const BARE_LEAD = /^(?:(?:none|nothing|no allergies|no|nope)\s+(?:except|but|apart from|other than|besides)\s+|(?:just|only|except|and|also|plus|maybe)\s+)+/;
/** Intents whose words name no allergy ("yes", "thanks", "undo that"). */
const NAMES_NOTHING: ReadonlySet<string> = new Set(['yes', 'thanks', 'undo', 'allowance']);
/** A list part that is only a filler word ("nope, just peanuts"). */
const FILLER = /^(no|nope|none|nothing|yes|yeah|yep|um|erm|well|ok|okay|so)$/;
/** The parts of a bare allergy list, each as said. */
/** Core's list split, plus ; / and parentheses ("peanuts; sesame", "peanuts/sesame", "shellfish (prawns mainly)"). */
const BARE_SPLIT = new RegExp(`${LIST_SPLIT.source}|\\s*[;/()]\\s*`);
/**
 * The parts of a bare allergy list that are terms of their own. A part that names a ledger entry inside other words
 * ("prawns mainly", "peanuts but not tree nuts") is left to `leftoverNamedIngredients`, which reads exclusions;
 * a part that names nothing the ledger knows is kept, so it gets its own unknown-term or which-one line.
 */
function bareTerms(raw: string, graph: IngredientGraph, ruleTerms: readonly RuleTerm[]): string[] {
  const t = normalizeTurn(raw).replace(/[.!?]+$/, '').trim().replace(BARE_LEAD, '');
  const isTerm = (x: string) => graph.resolve(x) !== null || ruleTerms.some((rt) => rt.phrases.some((p) => normalizeName(p) === normalizeName(x)));
  return t.split(BARE_SPLIT).map((x) => x.trim().replace(BARE_LEAD, '').trim())
    .filter((x) => x !== '' && !FILLER.test(x))
    .filter((x) => isTerm(x) || leftoverNamedIngredients(x, [], graph).left.length + leftoverNamedIngredients(x, [], graph).excluded.length === 0);
}

export function parseIntakeAnswer(
  step: IntakeStep, text: string, deps: { graph: IngredientGraph; ruleTerms: readonly RuleTerm[]; rulesStamped?: boolean },
): IntakeAnswer {
  const { graph, ruleTerms } = deps;
  const raw = stripPageEvents(text).text.trim();
  const t = clean(text);
  if (t === '') return { kind: 'unparsed' };
  if (SKIP_WORD.test(t)) return { kind: 'skip' };
  switch (step) {
    case 'market_day': {
      const days = parseWeekdays(raw);
      return days.length === 0 ? { kind: 'unparsed' } : { kind: 'card', card: buildProfileCard({ marketDays: days }) };
    }
    case 'meals_per_week': {
      const n = parseCount(raw);
      return n === null ? { kind: 'unparsed' } : { kind: 'card', card: buildProfileCard({ mealsPerWeek: n }) };
    }
    case 'region': {
      if (notAnAnswer(raw, graph)) return { kind: 'unparsed' };
      const place = raw.replace(/[.!?]+$/, '').replace(REGION_LEAD, '').trim();
      if (place === '' || place.length > REGION_MAX) return { kind: 'unparsed' };
      const comma = place.lastIndexOf(',');
      const card = comma < 0
        ? buildProfileCard({ country: place, region: null })
        : buildProfileCard({ region: place.slice(0, comma).trim() || null, country: place.slice(comma + 1).trim() || null });
      return { kind: 'card', card };
    }
    case 'allergies': {
      if (NONE_WORDS.test(t)) return deps.rulesStamped ? { kind: 'done' } : { kind: 'none' };
      // A plain yes, thanks or the like names nothing (fix round 1, M7): the intake asks plainly.
      if (NAMES_NOTHING.has(classifyTurn(raw))) return { kind: 'unparsed' };
      const statement = parseRuleStatement(raw, graph);
      // No rule grammar: the answer is a bare list ("peanuts and shellfish", "just peanuts", "none except peanuts").
      // Each part is its own term; naming states no severity, so each card asks and defaults to Severe allergy (a tap).
      // Can't verify is never safe: an unknown or ambiguous part gets its own line.
      const items: { term: string; severity: Severity | null }[] = statement?.items.length
        ? statement.items
        : bareTerms(raw, graph, ruleTerms).map((term) => ({ term, severity: null }));
      const results = items.map((i) => buildRuleCard({ term: i.term, severity: i.severity }, graph, ruleTerms));
      // Fix round 2 (structural): every named allergen gets a card or an ask. A ledger name no card covers
      // ("vegan and peanuts") gets its own bare card: no severity stated, so it asks and defaults to Severe (a tap).
      const covered = results.flatMap((r) => (r.ok ? r.card.rule.target.ids : []));
      // A which-kind ask ("herbs", C1) answers its broad category: never a second ask for it.
      covered.push(...broadKindsAsked(results.flatMap((r) => (!r.ok && r.reason === 'ambiguous' && r.line.trigger === 'rule.which_kind' ? r.options.map((o) => o.id) : [])), graph));
      const { left, excluded } = leftoverNamedIngredients(raw, covered, graph);
      for (const name of left) results.push(buildRuleCard({ term: name, severity: null }, graph, ruleTerms));
      if (results.length === 0) return { kind: 'unparsed' };
      // "peanuts but not tree nuts": the allowance is never a card, and the Pan says it isn't written down.
      const notes = excluded.map((term): LineRef => ({ trigger: 'rule.exclusion_not_kept', vars: { term } }));
      // The Step 7 ask-for-dropped-terms rule (Carry from Step 1): a severe statement never loses a named ingredient.
      const dropped = askForDroppedTerms(raw, [...(statement?.terms ?? items.map((i) => i.term)), ...left], results.length > 0, graph);
      // A name the player said is fine ("but not peanuts") gets only rule.exclusion_not_kept, never an ask as well.
      const isExcluded = (term: string | undefined) => term !== undefined && excluded.some((e) => e === term || (graph.resolve(e) ?? e) === graph.resolve(term));
      const ask = dropped !== null && isExcluded(dropped.vars.term) ? null : dropped;
      if (results.length === 1 && ask === null && notes.length === 0) {
        return results[0].ok ? { kind: 'card', card: results[0].card } : { kind: 'reply', reply: results[0] };
      }
      return { kind: 'rules', results, ask, notes };
    }
    case 'pantry': {
      if (PANTRY_NONE.test(t)) return { kind: 'skip' };
      if (notAnAnswer(raw, graph)) return { kind: 'unparsed' };
      const adds = parsePantryAdds(raw);
      const items = adds.length > 0 ? adds : raw.replace(/[.!?]+$/, '').split(LIST_SPLIT).map((x) => x.trim()).filter((x) => x !== '');
      return items.length === 0 ? { kind: 'unparsed' } : { kind: 'card', card: buildPantryCard({ add: items, remove: [] }, graph) };
    }
  }
}

/** Which Form 1-A step a stamped card answers, or null. */
function stepOf(card: ProposalCard): IntakeStep | null {
  switch (card.kind) {
    case 'rule': return 'allergies';
    case 'pantry': return card.add.length > 0 ? 'pantry' : null;
    case 'meal': return null;
    case 'plan': return null;
    case 'profile': {
      const p = card.patch;
      if (p.marketDays !== undefined) return 'market_day';
      if (p.mealsPerWeek !== undefined) return 'meals_per_week';
      if (p.region !== undefined || p.country !== undefined) return 'region';
      return null;
    }
  }
}

/** The follow-up line's variable for a stamped card (`day`, `count`, `region`, `items`). */
function followupVars(card: ProposalCard): Record<string, string> {
  if (card.kind === 'pantry') return { items: joinAnd(card.add.map((a) => a.name)) };
  if (card.kind !== 'profile') return {};
  const p = card.patch;
  if (p.marketDays !== undefined) return { day: joinAnd(p.marketDays.map((d) => cap(WEEKDAY_NAMES[d] ?? String(d)))) };
  if (p.mealsPerWeek !== undefined) return { count: String(p.mealsPerWeek ?? '') };
  return { region: [p.region, p.country].filter((x) => typeof x === 'string' && x !== '').join(', ') };
}

const QUICK: Readonly<Partial<Record<IntakeStep, { label: string; value: string }[]>>> = {
  market_day: WEEKDAY_NAMES.slice(1).concat(WEEKDAY_NAMES.slice(0, 1)).map((d) => ({ label: cap(d), value: d })),
  meals_per_week: Array.from({ length: 7 }, (_, i) => ({ label: String(i + 1), value: String(i + 1) })),
};

export function createIntake(deps: {
  panel: MentorPanel; engine: ScriptedEngine; ai: MentorBackend | null; store: PlayerStore; client: ApiClient;
  dialogue: Dialogue; signedIn: () => boolean;
  graph: IngredientGraph; ruleTerms: readonly RuleTerm[];
  /** forms.intake: the Form 1-A checklist beside the interview. */
  form: BureauForm;
  /** The conversation's child flag (m-4), shared with the local safety check and the scripted engine. */
  child?: ChildFlag;
}): Intake {
  const { panel, engine, store, client, dialogue, graph, ruleTerms } = deps;
  let expecting: Intake['expecting'] = null;
  let started = false;
  let rulesStamped = false;
  const ticks = new Map<string, 'stamped' | 'skipped' | 'earlier'>();

  const say = (trigger: string, vars: Record<string, string> = {}): PanItem => ({ kind: 'said', said: dialogue.say(trigger, vars) });
  const ref = (l: LineRef): PanItem => say(l.trigger, l.vars);
  const reply = (items: PanItem[], cards: CardView[] = []): PanReply => ({ items, cards, intents: [], actions: [], notice: null });
  const view = (card: ProposalCard, turn: number): LocalCardView => ({ origin: 'local', localId: crypto.randomUUID(), card, issuedTurn: turn });
  const current = (): IntakeStep | 'done' | null => store.get().intake.step;
  const isStep = (s: IntakeStep | 'done' | null): s is IntakeStep => s !== null && s !== 'done';
  const setStep = (step: IntakeStep | 'done') => { store.update((s) => ({ ...s, intake: { step } })); };
  /** The AI backend, only while it is the one in use (signed in, AI on, not Family Table). */
  const aiNow = (): MentorBackend | null => (deps.ai?.kind === 'ai' ? deps.ai : null);

  // --- The Form 1-A checklist ------------------------------------------------------------------------------------
  const list = h('ul', { class: 'intake-list' });
  const checklist = h('section', { class: 'intake-checklist', 'aria-labelledby': 'intake-title' },
    h('p', { class: 'bureau-number' }, `PANTRY BUREAU · FORM ${deps.form.number}`),
    contentText('h3', deps.form.title, { id: 'intake-title', class: 'bureau-title' }),
    list);
  const drawChecklist = () => {
    list.replaceChildren(...deps.form.fields.map((f) => {
      const tick = ticks.get(f.key);
      return h('li', { class: `intake-field${tick === 'stamped' ? ' is-stamped' : ''}`, 'data-field': f.key },
        contentText('span', f.label, { class: 'intake-label' }),
        h('span', { class: 'intake-tick' }, tick === 'stamped' ? '✔ Stamped' : tick === 'skipped' ? 'Skipped' : tick === 'earlier' ? 'Answered earlier' : 'Not yet'));
    }));
  };
  const tick = (field: string, how: 'stamped' | 'skipped') => {
    if (how === 'skipped' && ticks.get(field) === 'stamped') return;
    ticks.set(field, how);
    drawChecklist();
  };

  // --- Moving through the steps ----------------------------------------------------------------------------------

  /** What entering the current step shows: its ask, the consent card first (C-17), or the end of the form. */
  async function enter(): Promise<PanItem[]> {
    const step = current();
    if (!isStep(step)) {
      expecting = null;
      panel.interceptText(null);
      return [say('intake.complete')]; // intake.notifications is M9's (reminders)
    }
    if (step === 'allergies' && deps.signedIn()) {
      const r = await client.consents();
      if (!(r.ok && healthConsent(r.data) === 'granted')) {
        expecting = 'consent';
        return [say('intake.allergies.consent'), { kind: 'consent', purpose: 'health_data', onAnswer: onConsent }];
      }
    }
    expecting = rulesStamped && step === 'allergies' ? 'more_rules' : 'answer';
    return [say(`intake.${step}.ask`)];
  }

  /** The next step, persisted, and what entering it shows. */
  async function moveOn(): Promise<PanItem[]> {
    const step = current();
    const i = isStep(step) ? INTAKE_ORDER.indexOf(step) : INTAKE_ORDER.length;
    setStep(INTAKE_ORDER[i + 1] ?? 'done');
    return enter();
  }

  /** The consent card's answer: agreed → the allergies question; Not now → skipped, onboarding goes on without rules (spec §6). */
  function onConsent(outcome: ConsentAnswer): void {
    if (current() !== 'allergies' || expecting !== 'consent') return;
    if (outcome === 'granted') {
      expecting = 'answer';
      panel.show(reply([say('intake.allergies.ask')]));
      return;
    }
    if (outcome === 'unavailable') {
      // The notice couldn't load: not a no (fix round 1, I1). The step stays open: try again, or skip.
      panel.show(reply([{
        kind: 'quick', label: 'The permission form', options: [{ label: 'Try again', value: 'retry' }, { label: 'Skip', value: 'skip' }],
        onPick: async (value, ctx) => {
          if (value === 'skip') return reply(await skipNow());
          if (current() !== 'allergies' || expecting !== 'consent') return answer(value, ctx);
          return reply(await enter());
        },
      }]));
      return;
    }
    tick('rules', 'skipped');
    void moveOn().then((items) => { panel.show(reply([say('intake.skip'), ...items])); });
  }

  async function skipNow(): Promise<PanItem[]> {
    const step = current();
    expecting = null; // a consent card still on screen no longer moves the interview
    if (isStep(step)) tick(FIELD[step], 'skipped');
    return [say('intake.skip'), ...(await moveOn())];
  }

  const quick = (step: IntakeStep): PanItem => ({
    kind: 'quick', label: `Quick answers: ${ANSWER_LABELS[step]}`,
    options: [...(QUICK[step] ?? []), { label: 'Skip', value: 'skip' }],
    onPick: (value, ctx) => answer(value, ctx),
  });

  /** The Pan didn't read the answer, and there is no AI to ask (or it failed): ask again, with quick answers. */
  const reask = (step: IntakeStep, notices: PanItem[]): PanReply => reply([...notices, say('didnt_understand'), quick(step)]);

  async function unparsed(step: IntakeStep, text: string, ctx: TurnContext): Promise<PanReply> {
    const ai = aiNow();
    if (ai !== null) {
      // The server's tools make the card (Step 7): the turn carries `intakeStep` (the AI backend reads the store).
      const r = await ai.reply({ kind: 'text', text }, ctx);
      // A child spoke earlier in this conversation (C-1): the grown-up line, as the backend answered it; the step waits.
      const head = r.items.at(0);
      if (head?.kind === 'said' && head.said.trigger === 'child.grownup') return r;
      if (r.cards.length > 0 || r.intents.length > 0 || r.actions.length > 0) return r;
      // No card: the AI failed, is capped or read nothing. Keep only what it said about itself, then ask again.
      const notices = r.items.filter((i) => i.kind === 'consent' || (i.kind === 'said' && /^(mentor\.ai_unavailable|rate_limited|ai\.try_again)$/.test(i.said.trigger)));
      return reask(step, notices);
    }
    // The script may still read it as something else ("I'm allergic to peanuts" while asked about market day):
    // its card is shown, never lost, and the question is asked again.
    const scripted = engine.reply(text, ctx);
    if (scripted.cards.length > 0 || scripted.intents.length > 0) return { ...scripted, items: [...scripted.items, say(`intake.${step}.ask`), quick(step)] };
    return reask(step, []);
  }

  /** S13 (M-5): a rule card a stricter saved rule already covers is never offered; the line says it is on file. */
  const onFile = (card: ProposalCard): LineRef | null => (card.kind === 'rule' ? alreadySavedLine(card, savedRules(store.get()), graph, ruleTerms) : null);

  function rulesReply(results: RuleCardResult[], ask: LineRef | null, turn: number, notes: LineRef[] = []): PanReply {
    const items: PanItem[] = [];
    const cards: CardView[] = [];
    for (const r of results) {
      const saved = r.ok ? onFile(r.card) : null;
      if (saved !== null) items.push(ref(saved));
      else if (r.ok) { items.push(...r.card.readback.map(ref)); cards.push(view(r.card, turn)); }
      else if (r.reason === 'unknown_term') items.push(ref(r.line));
      else items.push(ref(r.line), { kind: 'choices', options: r.options, severity: null });
    }
    items.push(...notes.map(ref));
    if (ask !== null) items.push(ref(ask));
    return reply(items, cards);
  }

  async function answer(text: string, ctx?: TurnContext): Promise<PanReply> {
    const step = current();
    const c: TurnContext = ctx ?? { turn: panel.turn, openCards: [], intakeStep: isStep(step) ? step : null, signedIn: deps.signedIn(), trail: [] };
    const stripped = stripPageEvents(text).text.trim();
    if (!isStep(step) || expecting === null) return engine.reply(text, c);
    // §19 / m-4: after a child turn in this conversation, no answer is read, no card made, no step moved: the grown-up
    // line. An emergency still goes on to its own line below (it is never held back).
    const intent = classifyTurn(stripped);
    if (deps.child?.on === true && intent !== 'emergency') return reply([say('child.grownup')]);
    // Skip words first (pre-flight C45).
    const parsed = parseIntakeAnswer(step, text, { graph, ruleTerms, rulesStamped });
    if (parsed.kind === 'skip') return reply(await skipNow());
    // Emergency, medical, child and the other fixed lines: the engine's answer (E2 keeps a stated rule), and the step waits.
    // An emergency, medical or child turn goes through the backend in use (C-1): its local safety answers it and keeps
    // the conversation's child flag. (The panel already sends these past the intake; this covers a direct call.)
    if (preRoute(intent) !== null) return (SAFETY.has(intent) ? aiNow()?.reply({ kind: 'text', text }, c) : undefined) ?? engine.reply(text, c);
    // The consent card is answered by a tap only (C-17, P-4): typed words never grant it.
    if (expecting === 'consent') return reply([say('consent.health_first')]);
    // A plain yes, no or undo with a card open answers the card, as anywhere else.
    if ((intent === 'yes' || intent === 'no' || intent === 'undo') && (c.openCards.length > 0 || (intent === 'undo' && c.trail.length > 0))) {
      return aiNow()?.reply({ kind: 'text', text }, c) ?? engine.reply(text, c);
    }
    switch (parsed.kind) {
      case 'none': return reply([say('intake.allergies.none'), ...(await moveOn())]);
      case 'done': return reply(await moveOn());
      case 'card': {
        const saved = onFile(parsed.card);
        return saved !== null ? reply([ref(saved)]) : reply(parsed.card.readback.map(ref), [view(parsed.card, c.turn)]);
      }
      case 'reply': return rulesReply([parsed.reply], null, c.turn);
      case 'rules': return rulesReply(parsed.results, parsed.ask, c.turn, parsed.notes ?? []);
      // At allergies an answer that names nothing is never sent anywhere: the plain ask (fix round 1, M7).
      case 'unparsed': return step === 'allergies' ? reply([say('rule.ask_keep_off')]) : unparsed(step, text, c);
    }
  }

  // A card stamped for the step being asked: its follow-up, then the next question. Any other step's card just ticks.
  panel.onCardDone((v, result) => {
    const step = current();
    const answers = stepOf(v.card);
    if (!started || !isStep(step) || answers === null) return;
    if (result === 'rejected') {
      if (answers === step && step !== 'allergies' && expecting === 'answer') panel.show(reply([say(`intake.${step}.ask`)]));
      return;
    }
    tick(FIELD[answers], 'stamped');
    if (answers !== step) return;
    if (step === 'allergies') {
      // The panel says intake.allergies.followup after the write (Step 10); the step stays open for more rules.
      rulesStamped = true;
      expecting = 'more_rules';
      return;
    }
    if (expecting !== 'answer') return;
    void moveOn().then((items) => { panel.show(reply([say(`intake.${step}.followup`, followupVars(v.card)), ...items])); });
  });

  function begin(fresh: boolean): void {
    if (started || store.get().settings.familyTable || panel.mode !== 'standard') return;
    started = true;
    // Resumed on a later visit: the steps before this one were stamped or skipped then (ticks live in memory only).
    const at = INTAKE_ORDER.indexOf(current() as IntakeStep);
    for (const step of INTAKE_ORDER.slice(0, Math.max(0, at))) ticks.set(FIELD[step], 'earlier');
    drawChecklist();
    panel.setAside(checklist);
    panel.interceptText((text, ctx) => (expecting !== null && isStep(current()) ? answer(text, ctx) : null));
    if (fresh) setStep(INTAKE_ORDER[0]);
    const opening = fresh ? [say('intake.open')] : [];
    void enter().then((items) => { panel.show(reply([...opening, ...items])); });
  }

  return {
    /** First open (step null): intake.open and the first question. A step left mid-way on an earlier visit resumes there. */
    start() {
      const step = current();
      if (step === 'done') return;
      begin(step === null);
    },
    answer,
    skip() {
      const step = current();
      if (!isStep(step)) return reply([]);
      tick(FIELD[step], 'skipped');
      const items = [say('intake.skip')];
      void moveOn().then((next) => { panel.show(reply(next)); });
      return reply(items);
    },
    get step() { return current(); },
    get expecting() { return expecting; },
  };
}

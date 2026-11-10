import {
  askForDroppedTerms, buildPantryCard, buildProfileCard, buildRuleCard, classifyTurn, LIST_SPLIT, normalizeTurn,
  parseCount, parsePantryAdds, parseRuleStatement, parseWeekdays, preRoute, stripPageEvents, WEEKDAY_NAMES,
  type IngredientGraph, type IntakeStep, type LineRef, type ProposalCard, type RuleCardResult, type RuleTerm,
} from '@kitchenquest/core/engine';
import { healthConsent, type ApiClient } from '../api/client';
import type { BureauForm } from '../content/types';
import type { PlayerStore } from '../state/store';
import { contentText, h } from '../ui/dom';
import type { MentorBackend } from './backend';
import type { Dialogue } from './dialogue';
import type { MentorPanel } from './panel';
import type { CardView, LocalCardView, PanItem, PanReply, TurnContext } from './reply';
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
  | { kind: 'rules'; results: RuleCardResult[]; ask: LineRef | null };

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
      const statement = parseRuleStatement(raw, graph);
      // No rule grammar: the whole answer is the term ("peanuts"). Can't verify is never safe: an unknown term says so.
      const items = statement?.items.length ? statement.items : [{ term: raw, severity: null }];
      const results = items.map((i) => buildRuleCard({ term: i.term, severity: i.severity }, graph, ruleTerms));
      // The Step 7 ask-for-dropped-terms rule (Carry from Step 1): a severe statement never loses a named ingredient.
      const ask = askForDroppedTerms(raw, statement?.terms ?? [raw], results.length > 0, graph);
      if (results.length === 1 && ask === null) return results[0].ok ? { kind: 'card', card: results[0].card } : { kind: 'reply', reply: results[0] };
      return { kind: 'rules', results, ask };
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
}): Intake {
  const { panel, engine, store, client, dialogue, graph, ruleTerms } = deps;
  let expecting: Intake['expecting'] = null;
  let started = false;
  let rulesStamped = false;
  const ticks = new Map<string, 'stamped' | 'skipped'>();

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
        h('span', { class: 'intake-tick' }, tick === 'stamped' ? '✔ Stamped' : tick === 'skipped' ? 'Skipped' : 'Not yet'));
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
        return [{ kind: 'consent', purpose: 'health_data', onAnswer: onConsent }];
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
  function onConsent(granted: boolean): void {
    if (current() !== 'allergies' || expecting !== 'consent') return;
    if (granted) {
      expecting = 'answer';
      panel.show(reply([say('intake.allergies.ask')]));
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

  function rulesReply(results: RuleCardResult[], ask: LineRef | null, turn: number): PanReply {
    const items: PanItem[] = [];
    const cards: CardView[] = [];
    for (const r of results) {
      if (r.ok) { items.push(...r.card.readback.map(ref)); cards.push(view(r.card, turn)); }
      else if (r.reason === 'unknown_term') items.push(ref(r.line));
      else items.push(ref(r.line), { kind: 'choices', options: r.options, severity: null });
    }
    if (ask !== null) items.push(ref(ask));
    return reply(items, cards);
  }

  async function answer(text: string, ctx?: TurnContext): Promise<PanReply> {
    const step = current();
    const c: TurnContext = ctx ?? { turn: panel.turn, openCards: [], intakeStep: isStep(step) ? step : null, signedIn: deps.signedIn(), trail: [] };
    const stripped = stripPageEvents(text).text.trim();
    if (!isStep(step) || expecting === null) return engine.reply(text, c);
    // Skip words first (pre-flight C45).
    const parsed = parseIntakeAnswer(step, text, { graph, ruleTerms, rulesStamped });
    if (parsed.kind === 'skip') return reply(await skipNow());
    // Emergency, medical, child and the other fixed lines: the engine's answer (E2 keeps a stated rule), and the step waits.
    const intent = classifyTurn(stripped);
    if (preRoute(intent) !== null) return engine.reply(text, c);
    // The consent card is answered by a tap only (C-17, P-4): typed words never grant it.
    if (expecting === 'consent') return reply([say('consent.health_first')]);
    // A plain yes, no or undo with a card open answers the card, as anywhere else.
    if ((intent === 'yes' || intent === 'no' || intent === 'undo') && (c.openCards.length > 0 || (intent === 'undo' && c.trail.length > 0))) {
      return aiNow()?.reply({ kind: 'text', text }, c) ?? engine.reply(text, c);
    }
    switch (parsed.kind) {
      case 'none': return reply([say('intake.allergies.none'), ...(await moveOn())]);
      case 'done': return reply(await moveOn());
      case 'card': return reply(parsed.card.readback.map(ref), [view(parsed.card, c.turn)]);
      case 'reply': return rulesReply([parsed.reply], null, c.turn);
      case 'rules': return rulesReply(parsed.results, parsed.ask, c.turn);
      case 'unparsed': return unparsed(step, text, c);
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

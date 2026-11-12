import {
  buildRuleCard, normalizeName, SEVERITY_WORDS,
  type IngredientGraph, type RuleCard, type RuleTerm, type Severity,
} from '@kitchenquest/core/engine';
import { copy } from '../content/copy';
import { h } from '../ui/dom';

/**
 * The form fallback for rules (spec §7.5): no AI and no conversation. Search the ingredient ledger (and the
 * rule-term phrases, "vegetarian", "coeliac"), pick one, say how serious it is, and get the same Form 27-B card
 * the Pan would make. Nothing is saved here: the card is handed to `onCard`, and only its own tap writes it.
 * Can't verify is never safe (§2.2): only a ledger entry or a rule term can be picked, never free text.
 */
const MAX_OPTIONS = 8;
const SEVERITIES: readonly { value: Severity; label: string }[] = [
  { value: 'anaphylactic', label: 'Severe allergy' },
  { value: 'allergy', label: 'Allergy' },
  { value: 'intolerance', label: 'Intolerance' },
  { value: 'preference', label: 'Preference' },
];

type Pick = { kind: 'ingredient'; id: string; name: string } | { kind: 'term'; term: RuleTerm };

/** The severity a pick is filed with when the player chooses none: a rule term's own, else Severe allergy. */
const defaultSeverity = (p: Pick): Severity => (p.kind === 'term' ? p.term.severity ?? 'anaphylactic' : 'anaphylactic');
const severityLabel = (s: Severity): string => (s === 'anaphylactic' ? 'a Severe allergy' : SEVERITY_WORDS[s]);

function options(query: string, graph: IngredientGraph, ruleTerms: readonly RuleTerm[]): Pick[] {
  const q = normalizeName(query);
  if (q === '') return [];
  const terms = ruleTerms.filter((t) => [t.name, ...t.phrases].some((p) => normalizeName(p).includes(q)))
    .map((term): Pick => ({ kind: 'term', term }));
  const ingredients = graph.search(q, MAX_OPTIONS).map((x): Pick => ({ kind: 'ingredient', id: x.id, name: x.name }));
  return [...terms, ...ingredients].slice(0, MAX_OPTIONS);
}

/**
 * The card for a pick, exactly: never a wider or narrower reading of its name (the same check as `cardFromChoice`).
 * A broad item whose name core reads as more than one thing ("butternut", "bean", "berry", "herb": M6 Step 4 N3) is
 * never auto-picked and never a thrown error: its which-kind choices come back for the player to pick from. Anything
 * else that isn't the pick exactly gives no card (`none`), so nothing is filed on a guess.
 */
function cardFor(p: Pick, severity: Severity, graph: IngredientGraph, ruleTerms: readonly RuleTerm[]):
  { kind: 'card'; card: RuleCard } | { kind: 'choices'; options: { id: string; name: string }[] } | { kind: 'none' } {
  const built = buildRuleCard({ term: p.kind === 'term' ? p.term.name : p.name, severity }, graph, ruleTerms);
  if (!built.ok) return built.reason === 'ambiguous' && built.options.length > 0 ? { kind: 'choices', options: built.options } : { kind: 'none' };
  const want = p.kind === 'term' ? [...p.term.ids].sort() : [p.id];
  const got = [...built.card.rule.target.ids].sort();
  if (want.length !== got.length || want.some((id, i) => id !== got[i])) return { kind: 'none' };
  return { kind: 'card', card: built.card };
}

const WHICH_ONE = 'Which one do you mean?';
const NOT_FILED = "That one can't be filed from here exactly as picked. Try a more specific name.";

let seq = 0;

export function mountRuleForm(el: HTMLElement, opts: { graph: IngredientGraph; ruleTerms: RuleTerm[]; onCard(card: RuleCard): void }): () => void {
  const { graph, ruleTerms } = opts;
  const n = ++seq;
  const search = h('input', { type: 'search', id: 'rule-search', autocomplete: 'off', maxlength: 80, 'aria-describedby': `rule-search-hint-${n}` });
  const list = h('ul', { class: 'rule-form-options', 'aria-label': 'Matches' });
  const found = h('p', { class: 'rule-form-found', role: 'status' });
  const chosen = h('p', { class: 'rule-form-chosen' });
  const which = h('div', { class: 'rule-form-which' });
  const severity = h('select', { id: 'rule-severity', 'aria-describedby': `rule-severity-hint-${n}` },
    h('option', { value: '' }, 'Not chosen'),
    ...SEVERITIES.map((s) => h('option', { value: s.value }, s.label)));
  severity.value = '';
  const severityHint = h('p', { class: 'field-hint', id: `rule-severity-hint-${n}` });
  const fill = h('button', { type: 'button', class: 'btn btn-primary rule-form-fill' }, 'Fill in Form 27-B');
  fill.disabled = true;

  let picked: Pick | null = null;
  const showHint = () => {
    severityHint.textContent = copy('ui.rules.severity_default', { severity: severityLabel(picked ? defaultSeverity(picked) : 'anaphylactic') });
  };
  showHint();

  const render = () => {
    const q = search.value;
    const opts2 = options(q, graph, ruleTerms);
    list.replaceChildren(...opts2.map((p) => {
      const label = p.kind === 'term' ? `${p.term.name} (a rule for ${p.term.ids.map((id) => graph.get(id).name).join(', ')})` : p.name;
      const b = h('button', { type: 'button', class: 'btn btn-secondary rule-form-option', 'aria-pressed': 'false' }, label);
      b.addEventListener('click', () => {
        picked = p;
        which.replaceChildren();
        for (const x of list.querySelectorAll('button')) x.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        chosen.textContent = copy('ui.rules.chosen', { name: p.kind === 'term' ? p.term.name : p.name });
        fill.disabled = false;
        showHint();
      });
      return h('li', null, b);
    }));
    found.textContent = normalizeName(q) !== '' && opts2.length === 0 ? copy('ui.rules.nothing_found') : '';
  };
  search.addEventListener('input', render);

  const fillWith = (p: Pick) => {
    const s = severity.value === '' ? defaultSeverity(p) : (severity.value as Severity);
    const out = cardFor(p, s, graph, ruleTerms);
    which.replaceChildren();
    if (out.kind === 'card') { opts.onCard(out.card); return; }
    if (out.kind === 'none') { which.append(h('p', { class: 'rule-form-found', role: 'status' }, NOT_FILED)); return; }
    // The which-kind choices (the Pan's own `choices`): one tap files exactly that one, never a wider reading.
    const buttons = out.options.map((o) => {
      const b = h('button', { type: 'button', class: 'btn btn-secondary rule-form-choice' }, o.name);
      b.addEventListener('click', () => {
        picked = { kind: 'ingredient', id: o.id, name: o.name };
        chosen.textContent = copy('ui.rules.chosen', { name: o.name });
        fillWith(picked);
      });
      return b;
    });
    which.append(h('div', { class: 'button-row', role: 'group', 'aria-label': WHICH_ONE }, ...buttons));
    buttons[0]?.focus();
  };
  fill.addEventListener('click', () => {
    if (picked === null) return;
    fillWith(picked);
  });

  const form = h('div', { class: 'rule-form' },
    h('div', { class: 'field' },
      h('label', { for: 'rule-search' }, 'Ingredient or diet rule'),
      search,
      h('p', { class: 'field-hint', id: `rule-search-hint-${n}` }, copy('ui.rules.search_hint'))),
    found,
    list,
    chosen,
    h('div', { class: 'field' }, h('label', { for: 'rule-severity' }, 'How serious'), severity, severityHint),
    fill,
    which);
  el.append(form);
  return () => { form.remove(); };
}

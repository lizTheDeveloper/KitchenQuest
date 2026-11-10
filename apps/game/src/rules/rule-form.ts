import {
  buildRuleCard, normalizeName, SEVERITY_WORDS,
  type IngredientGraph, type RuleCard, type RuleTerm, type Severity,
} from '@kitchenquest/core/engine';
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
const NOTHING_FOUND = "The Bureau's ledger has nothing by that name. Try another word, or tell the Pan.";

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

/** The card for a pick, exactly: never a wider or narrower reading of its name (the same check as `cardFromChoice`). */
function cardFor(p: Pick, severity: Severity, graph: IngredientGraph, ruleTerms: readonly RuleTerm[]): RuleCard {
  const built = buildRuleCard({ term: p.kind === 'term' ? p.term.name : p.name, severity }, graph, ruleTerms);
  if (!built.ok) throw new Error('rule form: the pick did not build a card');
  const want = p.kind === 'term' ? [...p.term.ids].sort() : [p.id];
  const got = [...built.card.rule.target.ids].sort();
  if (want.length !== got.length || want.some((id, i) => id !== got[i])) throw new Error('rule form: the card is not the pick');
  return built.card;
}

let seq = 0;

export function mountRuleForm(el: HTMLElement, opts: { graph: IngredientGraph; ruleTerms: RuleTerm[]; onCard(card: RuleCard): void }): () => void {
  const { graph, ruleTerms } = opts;
  const n = ++seq;
  const search = h('input', { type: 'search', id: 'rule-search', autocomplete: 'off', maxlength: 80, 'aria-describedby': `rule-search-hint-${n}` });
  const list = h('ul', { class: 'rule-form-options', 'aria-label': 'Matches' });
  const found = h('p', { class: 'rule-form-found', role: 'status' });
  const chosen = h('p', { class: 'rule-form-chosen' });
  const severity = h('select', { id: 'rule-severity', 'aria-describedby': `rule-severity-hint-${n}` },
    h('option', { value: '' }, 'Not chosen'),
    ...SEVERITIES.map((s) => h('option', { value: s.value }, s.label)));
  severity.value = '';
  const severityHint = h('p', { class: 'field-hint', id: `rule-severity-hint-${n}` });
  const fill = h('button', { type: 'button', class: 'btn btn-primary rule-form-fill' }, 'Fill in Form 27-B');
  fill.disabled = true;

  let picked: Pick | null = null;
  const showHint = () => {
    severityHint.textContent = `If you leave this, it is filed as ${severityLabel(picked ? defaultSeverity(picked) : 'anaphylactic')}.`;
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
        for (const x of list.querySelectorAll('button')) x.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        chosen.textContent = `Chosen: ${p.kind === 'term' ? p.term.name : p.name}`;
        fill.disabled = false;
        showHint();
      });
      return h('li', null, b);
    }));
    found.textContent = normalizeName(q) !== '' && opts2.length === 0 ? NOTHING_FOUND : '';
  };
  search.addEventListener('input', render);

  fill.addEventListener('click', () => {
    if (picked === null) return;
    const s = severity.value === '' ? defaultSeverity(picked) : (severity.value as Severity);
    opts.onCard(cardFor(picked, s, graph, ruleTerms));
  });

  const form = h('div', { class: 'rule-form' },
    h('div', { class: 'field' },
      h('label', { for: 'rule-search' }, 'Ingredient or diet rule'),
      search,
      h('p', { class: 'field-hint', id: `rule-search-hint-${n}` }, 'Type part of a name, then choose one from the list.')),
    found,
    list,
    chosen,
    h('div', { class: 'field' }, h('label', { for: 'rule-severity' }, 'How serious'), severity, severityHint),
    fill);
  el.append(form);
  return () => { form.remove(); };
}

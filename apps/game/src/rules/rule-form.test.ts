// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import type { RuleCard } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import { mountRuleForm } from './rule-form';

function mount() {
  document.body.replaceChildren();
  const el = document.createElement('div');
  document.body.append(el);
  const onCard = vi.fn<(card: RuleCard) => void>();
  const stop = mountRuleForm(el, { graph, ruleTerms: content.ruleTerms, onCard });
  const search = el.querySelector<HTMLInputElement>('#rule-search')!;
  const type = (q: string) => { search.value = q; search.dispatchEvent(new Event('input')); };
  const options = () => [...el.querySelectorAll<HTMLButtonElement>('.rule-form-option')];
  const severity = el.querySelector<HTMLSelectElement>('#rule-severity')!;
  const fill = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Fill in Form 27-B')!;
  return { el, onCard, stop, type, options, severity, fill };
}

describe('mountRuleForm', () => {
  test('search → pick → severity → 27-B card; an empty severity is Severe allergy', () => {
    const m = mount();
    expect(m.fill().disabled).toBe(true);
    m.type('peanu');
    const peanut = m.options().find((b) => b.textContent === 'peanut')!;
    expect(peanut).toBeDefined();
    peanut.click();
    // No severity is chosen for the player; the screen says what an empty choice means.
    expect(m.severity.value).toBe('');
    expect(m.el.textContent).toContain('If you leave this, it is filed as a Severe allergy.');
    expect(m.fill().disabled).toBe(false);
    m.fill().click();
    expect(m.onCard).toHaveBeenCalledTimes(1);
    const card = m.onCard.mock.calls[0][0];
    expect(card).toMatchObject({ kind: 'rule', severe: true, severityUnclear: false, form: 'rule_allergen', rule: { severity: 'anaphylactic', target: { ids: ['peanut'] } } });
    expect(card.display.spelled).toBe('P-E-A-N-U-T');
  });

  test('a chosen severity is used, and a rule term is offered beside ingredients', () => {
    const m = mount();
    m.type('peanut');
    m.options().find((b) => b.textContent === 'peanut')!.click();
    m.severity.value = 'intolerance';
    m.severity.dispatchEvent(new Event('change'));
    m.fill().click();
    expect(m.onCard.mock.calls[0][0]).toMatchObject({ severe: false, form: 'rule_intolerance', rule: { severity: 'intolerance' } });

    m.type('vegetar');
    const veg = m.options().find((b) => b.textContent.startsWith('vegetarian'))!;
    veg.click();
    // A diet word keeps its own severity when none is chosen, and says so.
    expect(m.el.textContent).toContain('If you leave this, it is filed as a preference.');
    m.severity.value = '';
    m.fill().click();
    expect(m.onCard.mock.calls[1][0]).toMatchObject({ form: 'rule_diet', rule: { severity: 'preference' } });
    expect(m.onCard.mock.calls[1][0].rule.target.ids).toEqual(expect.arrayContaining(['meat', 'fish']));
  });

  test('nothing found says so; the stop function removes the form', () => {
    const m = mount();
    m.type('zzqx');
    expect(m.options()).toEqual([]);
    expect(m.el.textContent).toContain("The Bureau's ledger has nothing by that name.");
    m.stop();
    expect(m.el.querySelector('#rule-search')).toBeNull();
  });
});

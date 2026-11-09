import { content } from '../content';
import { statusChip } from '../ui/chips';
import { contentText, h } from '../ui/dom';
import type { CardFinding, RecipeCard } from './card-model';

export const NO_RULES_TEXT = "You haven't told the Bureau about any allergies or diet rules yet.";
export const RULES_ERROR_TEXT = "Couldn't check this dish against your rules. Treat it as unchecked.";
const DRAFT_TEXT = 'Draft — awaiting review by cooks from this tradition';
const BLOCKED_TEXT = "This dish isn't cookable with your rules. It stays on your map.";
const SACRED_TEXT = 'Shared as a story only.';

export const rulesCheckedText = (n: number): string =>
  n === 0 ? NO_RULES_TEXT : `Checked against your ${n} ${n === 1 ? 'rule' : 'rules'}.`;

export const LABEL_RULE_TEXT = "We can't be sure about this one — check what's in it and how much.";
export const LABEL_STORE_BOUGHT_TEXT = 'store-bought: what it contains depends on the brand, so check the label';

/**
 * Core's `label` finding has three causes: a store-bought product (no rule attached), an ingredient that only reaches
 * a rule through a kind or category, and an unmeasured quantity under a per-serving limit. Only the first is about a
 * brand, so a rule-driven one gets neutral wording.
 */
export function findingText(f: CardFinding): string {
  if (f.kind === 'unresolved') return "we couldn't identify this ingredient, so it isn't checked";
  if (f.kind === 'label') return f.fromRule ? LABEL_RULE_TEXT : LABEL_STORE_BOUGHT_TEXT;
  return f.swapLabel ?? 'not with your rules';
}

function findingItem(f: CardFinding): HTMLElement {
  return h('li', { class: 'finding', 'data-status': f.status },
    statusChip(f.status), ' ',
    h('strong', null, f.ingredient), `: ${findingText(f)}`,
    f.path ? h('span', { class: 'finding-path' }, ` (${f.path})`) : null,
    f.ruleNote ? h('span', { class: 'finding-note' }, `Your note: “${f.ruleNote}”`) : null);
}

/** A recipe card. Every string is a text node; status and cookability come from the model only. */
export function renderRecipeCard(card: RecipeCard, opts: { onCook(): void; headingLevel: 1 | 2 }): HTMLElement {
  const d = content.bureau.disclaimers;
  const parts: (Node | null)[] = [];

  parts.push(
    contentText(opts.headingLevel === 1 ? 'h1' : 'h2', card.title),
    contentText('p', `${card.region}, ${card.country}`, { class: 'recipe-place' }),
    h('p', { class: 'recipe-cook' }, 'Taught by ', contentText('span', card.cook.name)),
    contentText('p', card.credit, { class: 'recipe-credit' }),
    card.draft ? h('p', { class: 'draft-label' }, DRAFT_TEXT) : null,
    h('p', { class: 'recipe-status' }, statusChip(card.status)),
  );

  if (card.rulesError !== null) {
    parts.push(h('div', { class: 'rules-error', role: 'note' },
      h('p', null, h('strong', null, RULES_ERROR_TEXT)),
      h('p', { class: 'rules-error-detail' }, card.rulesError)));
  } else {
    parts.push(h('p', { class: 'rules-checked' }, rulesCheckedText(card.rulesChecked)));
  }

  if (card.findings.length > 0) parts.push(h('ul', { class: 'findings' }, ...card.findings.map(findingItem)));

  if (card.severe && card.disclaimer !== null) {
    // Always visible, never collapsible (§4.4).
    parts.push(
      h('p', { class: 'disclaimer', role: 'note' }, card.disclaimer),
      contentText('p', d.cross_contact, { class: 'disclaimer' }),
    );
  }
  if (card.findings.some((f) => f.kind === 'label')) parts.push(contentText('p', d.unverified, { class: 'disclaimer-unverified' }));

  const n = card.nutrition;
  parts.push(
    h('table', { class: 'nutrition' },
      h('caption', null, 'Per serving'),
      h('tbody', null, ...n.rows.map((r) =>
        h('tr', { 'data-nutrient': r.nutrient }, h('th', { scope: 'row' }, r.label), h('td', null, r.value))))),
    n.estimated ? h('p', { class: 'nutrition-estimate' }, '≈ estimate') : null,
    n.missing.length > 0 ? h('p', { class: 'nutrition-missing' }, `Not counted: ${n.missing.join(', ')}`) : null,
  );

  parts.push(
    h('p', { class: 'recipe-skills' }, 'Skills: ', contentText('span', card.skills.map((s) => s.name).join(', '))),
    h('p', { class: 'recipe-license' }, 'License: ', contentText('span', card.license)),
  );

  if (card.notCookableReason === 'sacred') {
    parts.push(h('p', { class: 'not-cookable' }, SACRED_TEXT));
  } else {
    const reasonId = `not-cookable-${card.slug.replace(/[^a-z0-9]+/g, '-')}`;
    const button = h('button', {
      type: 'button', class: 'btn btn-primary cook-button',
      disabled: !card.cookable, 'aria-describedby': card.cookable ? null : reasonId,
    }, 'Cook it ', h('span', { 'aria-hidden': 'true' }, '▶'));
    if (card.cookable) button.addEventListener('click', () => opts.onCook());
    parts.push(h('div', { class: 'button-row' }, button));
    if (!card.cookable) parts.push(h('p', { class: 'not-cookable', id: reasonId }, BLOCKED_TEXT));
  }

  return h('article', { class: 'recipe-card panel', 'data-slug': card.slug, 'data-status': card.status }, ...parts);
}

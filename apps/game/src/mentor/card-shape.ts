import type { ServerCard } from '@kitchenquest/core/engine';

/**
 * The shapes a card from the server must have before the panel draws it (fix round 1, M8 of M4; M5 Step 10 adds the
 * plan card). Anything else is dropped, never rendered. Shared by the AI backend (a turn's cards) and the week's turn
 * code (a card re-offered after 409 `plan_changed`, M1), so every server card meets the same check.
 */
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export const isStr = (x: unknown): x is string => typeof x === 'string';
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
export const isDate = (x: unknown): x is string => isStr(x) && Number.isFinite(Date.parse(x));
const isLineRef = (x: unknown): boolean => isObj(x) && isStr(x.trigger) && isObj(x.vars) && Object.values(x.vars).every(isStr);
const RULE_FORMS: readonly unknown[] = ['rule_allergen', 'rule_intolerance', 'rule_diet'];
export const KINDS: readonly unknown[] = ['rule', 'meal', 'profile', 'pantry', 'plan'];
const isPlanItem = (i: unknown): boolean =>
  isObj(i) && Number.isInteger(i.day) && isStr(i.slug) && (i.kind === 'lesson' || (i.kind === 'dish' && typeof i.servings === 'number'));
/** A plan card's checks are never ⛔ (a ⛔ item never reaches a card); anything else is dropped, never drawn as ok. */
const PLAN_CHECK: readonly unknown[] = ['ok', 'swap', 'unverified'];

/** A proposal card with every field the panel draws (fix round 1, M8): anything else is dropped, never rendered. */
export function isProposalCard(c: unknown): boolean {
  if (!isObj(c) || !Array.isArray(c.readback) || !c.readback.every(isLineRef)) return false;
  switch (c.kind) {
    case 'rule': {
      const d = c.display;
      const r = c.rule;
      return RULE_FORMS.includes(c.form) && typeof c.severe === 'boolean' && typeof c.severityUnclear === 'boolean' &&
        isObj(d) && isStr(d.ingredient) && isStr(d.spelled) && isStr(d.severity) && isStr(d.covers) &&
        isObj(r) && isObj(r.target) && isStrArr(r.target.ids) && isStr(r.severity);
    }
    case 'meal': {
      const m = c.meal;
      if (!isObj(m) || !isStr(m.eatenOn) || !isStr(m.slot) || !isObj(m.item) || !isStr(c.summary) || typeof c.estimate !== 'boolean') return false;
      return m.item.kind === 'dish' ? isStr(m.item.slug) && typeof m.item.servings === 'number' : m.item.kind === 'free' && isStr(m.item.description);
    }
    case 'profile': {
      const p = c.patch;
      if (!isObj(p) || !isStr(c.summary)) return false;
      return (p.marketDays === undefined || (Array.isArray(p.marketDays) && p.marketDays.every((d) => Number.isInteger(d)))) &&
        (p.mealsPerWeek === undefined || p.mealsPerWeek === null || typeof p.mealsPerWeek === 'number') &&
        (p.country === undefined || p.country === null || isStr(p.country)) && (p.region === undefined || p.region === null || isStr(p.region)) &&
        (p.mealWindows === undefined || (Array.isArray(p.mealWindows) && p.mealWindows.every((w) => isObj(w) && isStr(w.name) && isStr(w.start) && isStr(w.end))));
    }
    case 'pantry':
      return Array.isArray(c.add) && c.add.every((a) => isObj(a) && isStr(a.name) && (a.ingredientId === null || isStr(a.ingredientId))) &&
        isStrArr(c.remove) && isStr(c.summary) && (c.removeIds === undefined || isStrArr(c.removeIds));
    case 'plan':
      return isStr(c.weekStart) && Array.isArray(c.items) && c.items.every(isPlanItem) && typeof c.hard === 'boolean' &&
        Array.isArray(c.checks) && c.checks.length === c.items.length && c.checks.every((k) => isObj(k) && isStr(k.slug) && PLAN_CHECK.includes(k.status)) &&
        isStrArr(c.unknown) && isStrArr(c.dropped) && isStr(c.summary) && Array.isArray(c.added) && c.added.every(isPlanItem) && isStr(c.basis) &&
        (c.offer === null || (isObj(c.offer) && (c.offer.kind === 'new' || c.offer.kind === 'refresh') && isStr(c.offer.technique) && isStr(c.offer.recipe) &&
          (c.offer.status === 'ok' || c.offer.status === 'swap') && (c.offer.kind === 'refresh' || isStr(c.offer.from))));
    default:
      return false;
  }
}
export const isServerCard = (x: unknown): x is ServerCard => isObj(x) && isStr(x.proposalId) && isDate(x.expiresAt) && isProposalCard(x.card);

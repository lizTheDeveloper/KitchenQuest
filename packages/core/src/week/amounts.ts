// Amounts on Form 12-M, the market list (M6 Ruling 12): honest arithmetic only. Each dish's lines scale by plan
// servings ÷ recipe servings; lines are summed only when their units are one family after core's unit normalisation
// (`nutrition/units.ts`, the toGrams tables); everything else is listed side by side. Nothing converts between volume
// and mass, and nothing is guessed: a line with no quantity is shown as written, or not at all.
import { unitOf } from '../nutrition/units';

/** One amount on a list row. `text` is the display form ("450 g", "3", "a handful"); `quantity` null when fuzzy. */
export interface Amount {
  quantity: number | null;
  unit: string | null;
  text: string;
}

/** Two decimals at most, trailing zeros dropped; a tiny non-zero amount keeps two significant digits (never "0"). */
function round(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 && n > 0 ? Number(n.toPrecision(2)) : r;
}

const textOf = (quantity: number, unit: string | null): string => {
  const q = String(round(quantity));
  if (unit === null) return q;
  return unit === 'cup' && round(quantity) !== 1 ? `${q} cups` : `${q} ${unit}`;
};

type Group =
  | { kind: 'family'; family: string; total: number; unit: string; size: number }
  | { kind: 'plain'; unit: string | null; total: number };

/**
 * Ruling 12: per dish, scale each line by plan servings ÷ recipe servings; sum only when normalised units agree.
 * - A family unit (g/mg/kg, oz/lb, ml/l, tsp/tbsp, cup) sums with its family, shown in the smallest unit given
 *   ("500 g" + "1 kg" → "1500 g"; "1 tbsp" + "1 tsp" → "4 tsp"). Different families stay apart ("2 tbsp + 1 cup").
 * - Any other unit sums only with the same spelling (trimmed, any case): "2 cloves" + "1 clove" stay apart.
 * - No unit (a count, "2 onions") sums with other counts.
 * - A line with no quantity (or no usable one: zero, negative, not finite, or an unusable servings factor) is fuzzy:
 *   its unit is shown as written, once ("a handful"); with no unit either, it adds nothing.
 * Order: summed amounts in first-seen order, then fuzzy ones. [] when nothing can be shown (never "0").
 */
export function listAmounts(lines: readonly { quantity: number | null; unit: string | null; servingsFactor: number }[]): Amount[] {
  const groups = new Map<string, Group>();
  const fuzzy = new Map<string, string>();
  for (const line of lines) {
    const written = line.unit === null ? '' : line.unit.trim();
    const usable =
      line.quantity !== null &&
      Number.isFinite(line.quantity) &&
      line.quantity > 0 &&
      Number.isFinite(line.servingsFactor) &&
      line.servingsFactor > 0;
    if (!usable) {
      if (written !== '' && !fuzzy.has(written.toLowerCase())) fuzzy.set(written.toLowerCase(), written);
      continue;
    }
    const amount = (line.quantity as number) * line.servingsFactor;
    const u = unitOf(written === '' ? null : written);
    if (u !== null) {
      const k = `family:${u.family}`;
      const g = groups.get(k);
      if (g === undefined) groups.set(k, { kind: 'family', family: u.family, total: amount * u.size, unit: u.unit, size: u.size });
      else if (g.kind === 'family') {
        g.total += amount * u.size;
        if (u.size < g.size) Object.assign(g, { unit: u.unit, size: u.size });
      }
      continue;
    }
    const k = written === '' ? 'count' : `unit:${written.toLowerCase()}`;
    const g = groups.get(k);
    if (g === undefined) groups.set(k, { kind: 'plain', unit: written === '' ? null : written, total: amount });
    else g.total += amount;
  }
  const out: Amount[] = [];
  for (const g of groups.values()) {
    const quantity = g.kind === 'family' ? g.total / g.size : g.total;
    out.push({ quantity: round(quantity), unit: g.unit, text: textOf(quantity, g.unit) });
  }
  for (const text of fuzzy.values()) out.push({ quantity: null, unit: text, text });
  return out;
}

/** The amounts as one line: "2 tbsp + 1 cup"; [] → "". */
export function formatAmounts(a: readonly Amount[]): string {
  return a.map((x) => x.text).join(' + ');
}

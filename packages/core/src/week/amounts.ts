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
  | { kind: 'plain'; unit: string | null; total: number; name: string };

type Line = { quantity: number | null; unit: string | null; servingsFactor: number; name?: string };

/** The text for a row's lines when a recipe gave one of them no amount at all (fix round 1, I1). */
export const UNWRITTEN_AMOUNT = 'some';

const nameOf = (line: Line): string => (line.name ?? '').trim().toLowerCase();

/**
 * Ruling 12: per dish, scale each line by plan servings ÷ recipe servings; sum only when normalised units agree.
 * - A family unit (g/mg/kg, oz/lb, ml/l, tsp/tbsp, cup) sums with its family, shown in the smallest unit given
 *   ("500 g" + "1 kg" → "1500 g"; "1 tbsp" + "1 tsp" → "4 tsp"). Different families stay apart ("2 tbsp + 1 cup").
 * - Any other unit sums only with the exact same spelling (trimmed): "2 cloves" + "1 clove" stay apart, and so do
 *   "T" (tablespoon) and "t" (teaspoon), by cooking convention (fix round 1, M1).
 * - No unit (a count, "2 onions") sums only with lines of the identical name (`name`, trimmed, any case). When a row
 *   has counts of more than one name, each says what it counts ("1 curry leaf sprig + 10 curry leaves", M2).
 * - A line with no usable quantity (null, zero, negative, not finite, or an unusable servings factor) is fuzzy: its
 *   unit is shown as written, once ("a handful").
 * - A line with no usable quantity AND no unit gives no number to add, so a sum would understate the row (I1). Then
 *   nothing is summed: every line is shown as written (scaled), and the unwritten ones as one UNWRITTEN_AMOUNT. When
 *   every line is like that, there is nothing to show.
 * Order: amounts in first-seen order, then fuzzy ones. [] when nothing can be shown (never "0").
 */
export function listAmounts(lines: readonly Line[]): Amount[] {
  const usable = (line: Line): boolean =>
    line.quantity !== null &&
    Number.isFinite(line.quantity) &&
    line.quantity > 0 &&
    Number.isFinite(line.servingsFactor) &&
    line.servingsFactor > 0;
  const written = (line: Line): string => (line.unit === null ? '' : line.unit.trim());
  const unwritten = lines.some((line) => !usable(line) && written(line) === '');
  const groups = new Map<string, Group>();
  const fuzzy = new Map<string, string>();
  lines.forEach((line, i) => {
    const unit = written(line);
    if (!usable(line)) {
      if (unit !== '' && !fuzzy.has(unit)) fuzzy.set(unit, unit);
      return;
    }
    const amount = (line.quantity as number) * line.servingsFactor;
    // As written (I1): each line its own group, never added to another.
    const own = unwritten ? `line:${i}:` : '';
    const u = unitOf(unit === '' ? null : unit);
    if (u !== null) {
      const k = `${own}family:${u.family}`;
      const g = groups.get(k);
      if (g === undefined) groups.set(k, { kind: 'family', family: u.family, total: amount * u.size, unit: u.unit, size: u.size });
      else if (g.kind === 'family') {
        g.total += amount * u.size;
        if (u.size < g.size) Object.assign(g, { unit: u.unit, size: u.size });
      }
      return;
    }
    const k = unit === '' ? `${own}count:${nameOf(line)}` : `${own}unit:${unit}`;
    const g = groups.get(k);
    if (g === undefined) groups.set(k, { kind: 'plain', unit: unit === '' ? null : unit, total: amount, name: (line.name ?? '').trim() });
    else g.total += amount;
  });
  const counts = [...groups.values()].filter((g) => g.kind === 'plain' && g.unit === null);
  const named = new Set(counts.map((g) => (g.kind === 'plain' ? g.name.toLowerCase() : ''))).size > 1;
  const out: Amount[] = [];
  for (const g of groups.values()) {
    const quantity = g.kind === 'family' ? g.total / g.size : g.total;
    const text = g.kind === 'plain' && g.unit === null && named && g.name !== '' ? `${String(round(quantity))} ${g.name}` : textOf(quantity, g.unit);
    out.push({ quantity: round(quantity), unit: g.unit, text });
  }
  for (const text of fuzzy.values()) out.push({ quantity: null, unit: text, text });
  if (unwritten && out.length > 0) out.push({ quantity: null, unit: null, text: UNWRITTEN_AMOUNT });
  return out;
}

/** The amounts as one line: "2 tbsp + 1 cup"; [] → "". */
export function formatAmounts(a: readonly Amount[]): string {
  return a.map((x) => x.text).join(' + ');
}

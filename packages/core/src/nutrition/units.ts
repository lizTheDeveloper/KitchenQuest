import type { IngredientNode } from '../ingredients/types';

const MASS_G: Record<string, number> = { g: 1, kg: 1000, mg: 0.001, oz: 28.3495, lb: 453.592 };
const VOLUME_ML: Record<string, number> = { ml: 1, l: 1000, tsp: 4.929, tbsp: 14.787, cup: 236.588 };

function lookup(table: Record<string, number>, unit: string): number | undefined {
  const exact = Object.prototype.hasOwnProperty.call(table, unit) ? table[unit] : undefined;
  if (exact !== undefined) return exact;
  if (unit.endsWith('s')) {
    const singular = unit.slice(0, -1);
    return Object.prototype.hasOwnProperty.call(table, singular) ? table[singular] : undefined;
  }
  return undefined;
}

/**
 * The unit families amounts may be summed within (M6 Ruling 12), over the same spellings as the tables above: metric
 * mass, imperial mass, metric volume, spoons, and the cup alone. Named by their smallest unit. Nothing converts between
 * families: a list never turns a volume into a weight, or ounces into grams. Each is named by its first unit.
 */
const FAMILIES: readonly (readonly string[])[] = [['g', 'mg', 'kg'], ['oz', 'lb'], ['ml', 'l'], ['tsp', 'tbsp'], ['cup']];

/**
 * A unit as the toGrams tables read it (trimmed, lower case, a plural "s" folded): its canonical spelling, its
 * family (`unitFamily`) and its size in grams or millilitres (from MASS_G / VOLUME_ML, so units of one family compare).
 * null for a unit the tables don't hold ("clove", "pinch", "T") and for no unit.
 */
export function unitOf(unit: string | null): { unit: string; family: string; size: number } | null {
  if (unit === null) return null;
  const u = unit.trim().toLowerCase();
  if (u === '') return null;
  for (const table of [MASS_G, VOLUME_ML]) {
    const size = lookup(table, u);
    if (size === undefined) continue;
    const canonical = Object.prototype.hasOwnProperty.call(table, u) ? u : u.slice(0, -1);
    const family = FAMILIES.find((f) => f.includes(canonical));
    return family === undefined ? null : { unit: canonical, family: family[0], size };
  }
  return null;
}

/** The family a unit belongs to ('g' metric mass, 'oz' imperial mass, 'ml', 'tsp' spoons, 'cup'), or null (M6 Ruling 12). */
export function unitFamily(unit: string | null): string | null {
  return unitOf(unit)?.family ?? null;
}

function positive(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Convert a recipe quantity to grams. Returns null when it cannot be done
 * honestly (unknown unit, volume without density, count without weight).
 * Never returns NaN or a negative weight.
 */
export function toGrams(
  quantity: number | null,
  unit: string | null,
  node: IngredientNode,
): { grams: number; estimated: boolean } | null {
  if (quantity === null) {
    return Number.isFinite(node.defaultGrams) && (node.defaultGrams as number) >= 0
      ? { grams: node.defaultGrams as number, estimated: true }
      : null;
  }
  if (!Number.isFinite(quantity) || quantity < 0) return null;

  const u = unit === null ? '' : unit.trim().toLowerCase();
  if (u === '') {
    return positive(node.gramsPerUnit) ? { grams: quantity * node.gramsPerUnit, estimated: false } : null;
  }
  const mass = lookup(MASS_G, u);
  if (mass !== undefined) return { grams: quantity * mass, estimated: false };
  const volume = lookup(VOLUME_ML, u);
  if (volume !== undefined && positive(node.densityGPerMl)) {
    return { grams: quantity * volume * node.densityGPerMl, estimated: false };
  }
  return null;
}

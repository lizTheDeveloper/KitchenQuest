/**
 * N-7: a meal window's name is one of a fixed set. Free text here could name
 * a fast or a medical routine ("Ramadan suhoor", "insulin snack"), which is
 * special-category data in a plain column.
 */
export const MEAL_WINDOW_NAMES = ['breakfast', 'lunch', 'dinner', 'snack', 'other'] as const;

type MealWindowName = (typeof MEAL_WINDOW_NAMES)[number];
export type StoredMealWindow = { name: MealWindowName; start: string; end: string };

/**
 * Stored meal windows as served: a name outside the fixed set (a row written
 * before N-7 made names an enum) reads as `other`, so free text is never
 * shown back or exported. Used by GET /profile and the account export.
 */
export function knownMealWindows(stored: unknown): StoredMealWindow[] {
  const list = Array.isArray(stored) ? (stored as { name?: unknown }[]) : [];
  return list.map((w) => ({
    ...(w as StoredMealWindow),
    name: (MEAL_WINDOW_NAMES as readonly unknown[]).includes(w.name) ? (w.name as MealWindowName) : 'other',
  }));
}

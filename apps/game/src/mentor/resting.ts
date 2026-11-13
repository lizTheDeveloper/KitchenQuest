// M7 Ruling 5: a rest is shown as a day and a date, never as a number of anything (no count, countdown or timer).

/** "2026-11-19" → "Thursday 19 November". */
export function restingUntil(until: string): string {
  const [y, m, d] = until.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

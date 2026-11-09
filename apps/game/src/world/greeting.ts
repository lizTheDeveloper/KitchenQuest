const GAP_MS = 3 * 86_400_000;

/**
 * Which `greet.*` trigger the Pan opens with. First ever beats everything; three or more days away beats
 * the time of day; otherwise the player's local hour picks it.
 */
export function greetingTrigger(now: Date, firstOpenedAt: string | null, lastOpenedAt: string | null): string {
  if (firstOpenedAt === null) return 'greet.first_ever';
  const last = lastOpenedAt === null ? NaN : Date.parse(lastOpenedAt);
  if (Number.isFinite(last) && now.getTime() - last >= GAP_MS) return 'greet.return_after_gap';
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) return 'greet.morning';
  if (hour >= 11 && hour < 17) return 'greet.afternoon';
  if (hour >= 17 && hour < 22) return 'greet.evening';
  return 'greet.late_night';
}

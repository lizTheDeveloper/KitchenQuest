const pick = <T>(xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(Math.random() * xs.length)]);

/** A return visit's line (Step 9): one of `trust_lines[level]`, the highest written level at or below it. Level 0 has none. */
export function trustLine(lines: Readonly<Record<string, string[]>>, level: number): string | null {
  if (level < 1) return null;
  const levels = Object.keys(lines).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= level).sort((a, b) => b - a);
  for (const l of levels) {
    const line = pick(lines[String(l)] ?? []);
    if (line !== undefined) return line;
  }
  return null;
}

/** `undefined`, `null` and `''` count as missing, so a line never reads "Hi ." or "Hi null.". */
export type Vars = Record<string, string | number | null | undefined>;

const VAR = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The trigger to use for `id`: itself, else its nearest dotted ancestor that exists. */
export function resolveTrigger(bank: { triggers: Record<string, unknown> }, id: string): string | null {
  let cur = id;
  for (;;) {
    if (Object.hasOwn(bank.triggers, cur)) return cur;
    const dot = cur.lastIndexOf('.');
    if (dot < 0) return null;
    cur = cur.slice(0, dot);
  }
}

/** The value of `name` as text, or null when it is absent, `undefined`, `null` or `''`. */
function varText(vars: Vars, name: string): string | null {
  if (!Object.hasOwn(vars, name)) return null;
  const v = vars[name];
  return v === undefined || v === null || v === '' ? null : String(v);
}

/** The line with every {var} filled, or null when any is missing. */
export function fillLine(line: string, vars: Vars): string | null {
  const names = [...line.matchAll(VAR)].map((m) => m[1]);
  if (names.some((name) => varText(vars, name) === null)) return null;
  return line.replace(VAR, (_m, name: string) => varText(vars, name)!);
}

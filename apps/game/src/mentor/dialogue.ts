import { fillLine, resolveTrigger, type Vars } from '@kitchenquest/core/engine';
import type { LineBank, LineTrigger } from '../content/types';

// Line filling and trigger fallback live in core (the API's lines use them too).
export { fillLine, resolveTrigger, type Vars };
/** `trigger` is the resolved id actually used, which may be a parent of the one asked for. */
export interface Said { trigger: string; text: string; ai: 'never' | 'allowed' }
export class DialogueError extends Error {}

/** The "Common variables" documented in the pan.yaml header. */
export const COMMON_DEFAULTS: Readonly<Record<string, string>> = { name: 'apprentice' };

const VAR = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** A safe default for a variable: `(default: X)` / `(default: 'X')` in the trigger's `vars`, else the common one. */
export function defaultFor(trigger: LineTrigger, name: string): string | null {
  const doc = trigger.vars && Object.hasOwn(trigger.vars, name) ? trigger.vars[name] : undefined;
  const m = doc === undefined ? null : /\(default:\s*(?:'([^']*)'|"([^"]*)"|([^)]*?))\s*\)/.exec(doc);
  const found = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  if (found !== undefined && found !== '') return found;
  return Object.hasOwn(COMMON_DEFAULTS, name) ? COMMON_DEFAULTS[name] : null;
}

export interface Dialogue { say(id: string, vars?: Vars): Said }

export function createDialogue(
  bank: LineBank,
  opts: {
    random?: () => number; history?: Record<string, number[]>; onHistory?: (h: Record<string, number[]>) => void;
    /**
     * Whose session the history belongs to (the signed-in account, Step 9 N4). When it changes, the in-memory history
     * starts empty, so an earlier session's lines are never written back.
     */
    session?: () => string;
  } = {},
): Dialogue {
  const random = opts.random ?? Math.random;
  let history: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(opts.history ?? {})) {
    if (Array.isArray(v)) history[k] = v.filter((i) => Number.isInteger(i));
  }
  let session = opts.session?.();

  return {
    say(id, vars = {}) {
      const now = opts.session?.();
      if (now !== session) { session = now; history = {}; }
      const resolved = resolveTrigger(bank, id);
      if (resolved === null) throw new DialogueError(`Unknown dialogue trigger "${id}"`);
      const trigger = bank.triggers[resolved];
      const n = trigger.lines.length;
      if (n === 0) throw new DialogueError(`Dialogue trigger "${resolved}" has no lines`);
      const used = (history[resolved] ?? []).filter((i) => i >= 0 && i < n);
      const recent = used.slice(Math.max(0, used.length - Math.min(3, n - 1)));
      const last = used.length > 0 ? used[used.length - 1] : -1;

      const filled = trigger.lines.map((l) => fillLine(l, vars));
      const fillable = filled.flatMap((t, i) => (t === null ? [] : [i]));
      const pickFrom = (pool: number[]): number => pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];

      let index: number;
      let text: string;
      const fresh = fillable.filter((i) => !recent.includes(i));
      // Only the last line fillable: repeating it beats a default (README rule 3 defaults only when every line is skipped).
      const notLast = fillable.filter((i) => i !== last);
      const repeatable = notLast.length > 0 ? notLast : fillable;
      if (fresh.length > 0) {
        index = pickFrom(fresh);
        text = filled[index]!;
      } else if (repeatable.length > 0) {
        index = pickFrom(repeatable);
        text = filled[index]!;
      } else {
        index = 0;
        text = trigger.lines[0].replace(VAR, (_m, name: string) => {
          const v = fillLine(`{${name}}`, vars);
          if (v !== null) return v;
          const d = defaultFor(trigger, name);
          if (d === null) throw new DialogueError(`Dialogue trigger "${resolved}" needs {${name}} and has no default for it`);
          return d;
        });
      }

      history[resolved] = [...used, index].slice(-3);
      opts.onHistory?.(structuredClone(history));
      return { trigger: resolved, text, ai: trigger.ai };
    },
  };
}

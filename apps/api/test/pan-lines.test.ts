// M4 final M-1: every Pan line the server or core emits by id exists in pan.yaml, is one the game's build requires
// (so a pan.yaml edit that renames it fails the build, not the player's turn), and takes every var the code passes.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { loadPanBank } from '../src/mentor/lines.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCES = ['apps/api/src', 'packages/core/src'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

/** Each literal trigger id the code emits, with the var names it passes (`line('id', { a, b: x })`, `trigger: 'id', vars: { … }`). */
function emitted(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const keysOf = (body: string | undefined) => {
    // Calls and indexes inside a value ("savedRuleName(a, b)") hold commas that are no var names.
    let flat = body ?? '';
    for (let prev = ''; prev !== flat; ) [prev, flat] = [flat, flat.replace(/\([^()]*\)|\[[^[\]]*\]/g, '')];
    return flat
      .split(',')
      .map((part) => /^\s*([A-Za-z_]\w*)\s*(?::|$)/.exec(part)?.[1])
      .filter((k): k is string => k !== undefined);
  };
  const add = (id: string, keys: string[]) => {
    const set = out.get(id) ?? new Set<string>();
    for (const k of keys) set.add(k);
    out.set(id, set);
  };
  for (const dir of SOURCES) {
    for (const file of files(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bline\(\s*'([a-z_.]+)'\s*(?:,\s*\{([^}]*)\})?/g)) add(m[1], keysOf(m[2]));
      for (const m of src.matchAll(/\btrigger:\s*'([a-z_.]+)'(?:\s*,\s*vars:\s*\{([^}]*)\})?/g)) add(m[1], keysOf(m[2]));
    }
  }
  return out;
}

/** REQUIRED_PAN_TRIGGERS, read from the game's source as text (the API never imports the game). */
// The list's entries, and (M5) the keys of M5_LOOP_TRIGGERS_AI, which the list spreads in.
const required = new Set(
  [...readFileSync(join(ROOT, 'apps/game/src/content/required.ts'), 'utf8').matchAll(/^\s*'([a-z_.]+)'(?:,|:\s*'(?:never|allowed)',)/gm)].map((m) => m[1]),
);
const yaml = parse(readFileSync(join(ROOT, 'content/dialogue/pan.yaml'), 'utf8')) as {
  triggers: Record<string, { vars?: Record<string, string>; lines: string[] }>;
};

test('M-1: every trigger the server and core emit exists, is required by the game build, and takes the vars passed', () => {
  const bank = loadPanBank();
  const ids = emitted();
  expect(ids.size).toBeGreaterThan(20);
  for (const [id, vars] of ids) {
    expect(bank.hasTrigger(id), `${id} is in pan.yaml`).toBe(true);
    expect(required.has(id), `${id} is in REQUIRED_PAN_TRIGGERS`).toBe(true);
    const entry = yaml.triggers[id];
    const declared = new Set([...Object.keys(entry.vars ?? {}), ...entry.lines.flatMap((l) => [...l.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))]);
    for (const v of vars) expect(declared.has(v), `${id} takes {${v}}`).toBe(true);
  }
  for (const id of ['rule.already_saved', 'write.daily_limit', 'log.estimate_note', 'rule.severe_label_reminder']) expect(ids.has(id), id).toBe(true);
});

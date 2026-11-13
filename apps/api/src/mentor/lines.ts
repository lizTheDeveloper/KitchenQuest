import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fillLine, resolveTrigger, type LineRef, type ReplyPart } from '@kitchenquest/core';
import { parse } from 'yaml';

/** The repository's Pan line bank. */
const PAN_YAML = new URL('../../../../content/dialogue/pan.yaml', import.meta.url);

/** The server's view of `content/dialogue/pan.yaml`, read once at boot. */
export interface PanBank {
  persona: string[];
  hasTrigger(id: string): boolean;
  /** `ai: never`: the model is never asked to write this line (§8). */
  isNever(id: string): boolean;
  /** The first line of `resolveTrigger(bank, ref.trigger)` that core's `fillLine` fills, or '' when none does. */
  firstLine(ref: LineRef): string;
  /**
   * M7 Step 5 (Ruling 15): variant `index` of `resolveTrigger(bank, trigger)`, filled with `vars` by core `fillLine`;
   * null when the trigger is unknown, the index out of range or a var missing. For spoken lines.
   */
  lineAt(trigger: string, index: number, vars: Record<string, string>): string | null;
  /**
   * Every variable the trigger takes: its declared `vars:` and each `{var}` in any of its lines, sorted; [] for an
   * unknown trigger. A spoken `line` item must name a trigger with none (Ruling 15: the client sends no variables).
   */
  varsOf(trigger: string): string[];
}

interface TriggerEntry {
  ai: string;
  lines: string[];
  vars: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string');

/**
 * Reads and checks the line bank. Throws, naming the file, when it cannot be
 * read or parsed, or when the persona or any trigger is malformed, so the
 * server never starts without its written lines.
 */
export function loadPanBank(file: URL = PAN_YAML): PanBank {
  const path = fileURLToPath(file);
  let doc: unknown;
  try {
    doc = parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`PanBank: cannot read ${path}: ${(e as Error).message}`);
  }
  if (!isObject(doc)) throw new Error(`PanBank: ${path} must be a mapping`);
  if (!isStrings(doc.persona)) throw new Error(`PanBank: ${path}: persona must be a non-empty list of strings`);
  if (!isObject(doc.triggers)) throw new Error(`PanBank: ${path}: triggers must be a mapping`);
  const triggers: Record<string, TriggerEntry> = {};
  for (const [id, entry] of Object.entries(doc.triggers)) {
    if (!isObject(entry) || !isStrings(entry.lines) || (entry.ai !== 'never' && entry.ai !== 'allowed')) {
      throw new Error(`PanBank: ${path}: trigger "${id}" needs ai (never | allowed) and a non-empty list of lines`);
    }
    const declared = isObject(entry.vars) ? Object.keys(entry.vars) : [];
    const used = entry.lines.flatMap((l) => [...l.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]));
    triggers[id] = { ai: entry.ai, lines: entry.lines, vars: [...new Set([...declared, ...used])].sort() };
  }
  const bank = { triggers };
  const persona = [...doc.persona];
  return {
    persona,
    hasTrigger: (id) => Object.hasOwn(triggers, id),
    isNever: (id) => Object.hasOwn(triggers, id) && triggers[id].ai === 'never',
    firstLine(ref) {
      const id = resolveTrigger(bank, ref.trigger);
      if (id === null) return '';
      for (const l of triggers[id].lines) {
        const filled = fillLine(l, ref.vars);
        if (filled !== null) return filled;
      }
      return '';
    },
    lineAt(trigger, index, vars) {
      const id = resolveTrigger(bank, trigger);
      if (id === null || !Number.isInteger(index) || index < 0 || index >= triggers[id].lines.length) return null;
      return fillLine(triggers[id].lines[index], vars);
    },
    varsOf(trigger) {
      const id = resolveTrigger(bank, trigger);
      return id === null ? [] : [...triggers[id].vars];
    },
  };
}

/** A written line as a reply part. */
export function line(trigger: string, vars?: Record<string, string>): ReplyPart {
  return { kind: 'line', line: { trigger, vars: vars ?? {} } };
}

/** "a", "a and b", "a, b and c" (core: the client's writer uses it too). */
export { listWords } from '@kitchenquest/core';

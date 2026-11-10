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
}

interface TriggerEntry {
  ai: string;
  lines: string[];
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
    triggers[id] = { ai: entry.ai, lines: entry.lines };
  }
  const bank = { triggers };
  const persona = [...doc.persona];
  return {
    persona,
    hasTrigger: (id) => Object.hasOwn(triggers, id),
    isNever: (id) => triggers[id]?.ai === 'never',
    firstLine(ref) {
      const id = resolveTrigger(bank, ref.trigger);
      if (id === null) return '';
      for (const l of triggers[id].lines) {
        const filled = fillLine(l, ref.vars);
        if (filled !== null) return filled;
      }
      return '';
    },
  };
}

/** A written line as a reply part. */
export function line(trigger: string, vars?: Record<string, string>): ReplyPart {
  return { kind: 'line', line: { trigger, vars: vars ?? {} } };
}

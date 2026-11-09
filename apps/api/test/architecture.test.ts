// C-10: org data is never joined to health data. Org modules (src/org/, from M12
// or the org plan) may not import health modules or name health tables.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Modules that read or write health data, relative to src/ (a directory covers everything in it). */
const HEALTH_MODULES = ['rules', 'consent', 'crypto/userkeys', 'journeys', 'symptoms', 'meals', 'mentor', 'voice'];
/** Health tables: schema exports and SQL names. Extend both when a milestone adds one. */
const HEALTH_SCHEMA_EXPORTS = ['rules', 'userKeys', 'consents'];
const HEALTH_SQL_TABLES = ['rules', 'user_keys', 'consents'];

interface Violation {
  file: string;
  reason: string;
}

/** Checks one org file (path relative to src/) for imports of health modules or health tables. */
export function healthViolations(file: string, text: string): Violation[] {
  const out: Violation[] = [];
  const dir = join(SRC, file, '..');
  const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  for (const spec of specifiers) {
    if (!spec.startsWith('.')) continue;
    const target = relative(SRC, resolve(dir, spec)).replace(/\.(js|ts)$/, '');
    for (const mod of HEALTH_MODULES) {
      if (target === mod || target.startsWith(`${mod}/`)) out.push({ file, reason: `imports health module ${target}` });
    }
  }
  for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!/db\/schema(\.js)?$/.test(m[2]!)) continue;
    const names = m[1]!.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, ''));
    for (const n of names) if (HEALTH_SCHEMA_EXPORTS.includes(n)) out.push({ file, reason: `imports health table ${n}` });
  }
  if (/import\s*\*\s*as\s+\w+\s*from\s*['"][^'"]*db\/schema(\.js)?['"]/.test(text)) {
    out.push({ file, reason: 'imports the whole schema (health tables included)' });
  }
  for (const t of HEALTH_SQL_TABLES) {
    if (new RegExp(`\\b(from|join|into|update)\\s+"?${t}"?\\b`, 'i').test(text)) out.push({ file, reason: `names health table ${t} in SQL` });
  }
  return out;
}

function filesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|js|mts)$/.test(p) ? [p] : [];
  });
}

describe('org/health separation (C-10)', () => {
  it('flags health imports and table names from an org module', () => {
    const bad = [
      `import { listRules } from '../rules/routes.js';`,
      `import { sealFor } from '../crypto/userkeys.js';`,
      `import { hasConsent } from '../consent/ledger.js';`,
      `import { orgs, rules as r } from '../db/schema.js';`,
      `import * as schema from '../db/schema.js';`,
      'const q = sql`select count(*) from orgs join rules on true`;',
      'const q = sql`select * from "user_keys"`;',
    ];
    for (const line of bad) expect(healthViolations('org/seats.ts', line), line).not.toHaveLength(0);
  });

  it('allows seat counts and non-health modules', () => {
    const ok = [
      `import { orgs, seats, users } from '../db/schema.js';`,
      `import { ApiError } from '../errors.js';`,
      `import { requireUser } from '../auth/session.js';`,
      'const q = sql`select count(*) from seats where org_id = ${id}`;',
      '// rules of the seat programme',
    ];
    for (const line of ok) expect(healthViolations('org/seats.ts', line), line).toEqual([]);
  });

  it('no file under src/org/ touches health modules or tables', () => {
    const files = filesUnder(join(SRC, 'org'));
    const violations = files.flatMap((f) => healthViolations(relative(SRC, f), readFileSync(f, 'utf8')));
    expect(violations).toEqual([]);
  });
});

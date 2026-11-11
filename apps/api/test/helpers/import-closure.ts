import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * M5 Step 8 fix round 4 (N8): the runtime import closure of an API module, computed from the source text, so the eval
 * gate test can check that `EVAL_FILES` hashes every module that decides a turn. Followed: relative imports within
 * the repository and `@kitchenquest/core`, resolved symbol by symbol through barrels (`export * from`, `export { … }
 * from`), so a core module counts only when a name the turn uses is defined there. Not followed: type-only imports
 * and names (they decide nothing at run time), npm packages and `node:` built-ins, and the API's `db/` and `crypto/`
 * (storage, not decisions). Returns repository-relative paths, sorted.
 */
const REPO = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const CORE = resolve(REPO, 'packages/core/src');
const EXCLUDED = [resolve(REPO, 'apps/api/src/db'), resolve(REPO, 'apps/api/src/crypto')];

interface Spec {
  /** The imported (or re-exported source) name, or '*' for a namespace or side-effect import. */
  name: string;
  /** The name this module exports it as (re-exports only). */
  as: string;
}
interface Stmt {
  kind: 'import' | 'reexport' | 'reexport-all';
  from: string;
  specs: Spec[];
}
interface Parsed {
  stmts: Stmt[];
  /** Names this module defines and exports itself (values only), or lists in a local `export { … }`. */
  local: Set<string>;
  /** Names this module exports as types only. */
  typeOnly: Set<string>;
}

const cache = new Map<string, Parsed>();

function specsOf(list: string): Spec[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith('type '))
    .map((s) => {
      const [name, as] = s.split(/\s+as\s+/).map((x) => x.trim());
      return { name, as: as ?? name };
    });
}

function parse(file: string): Parsed {
  const hit = cache.get(file);
  if (hit) return hit;
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const stmts: Stmt[] = [];
  const local = new Set<string>();
  const typeOnly = new Set<string>();
  for (const m of src.matchAll(/^\s*import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (m[1]) continue;
    const clause = m[2];
    const specs: Spec[] = [];
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces) specs.push(...specsOf(braces[1]));
    const head = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ').trim();
    if (/\*\s+as\s+\w+/.test(head)) specs.push({ name: '*', as: '*' });
    else if (head !== '') specs.push({ name: 'default', as: 'default' });
    if (specs.length > 0) stmts.push({ kind: 'import', from: m[3], specs });
  }
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) stmts.push({ kind: 'import', from: m[1], specs: [{ name: '*', as: '*' }] });
  for (const m of src.matchAll(/^\s*export\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (m[1]) continue;
    stmts.push({ kind: 'reexport', from: m[3], specs: specsOf(m[2]) });
  }
  for (const m of src.matchAll(/^\s*export\s+\*\s+(?:as\s+(\w+)\s+)?from\s+['"]([^'"]+)['"]/gm)) {
    if (m[1]) stmts.push({ kind: 'reexport', from: m[2], specs: [{ name: '*', as: m[1] }] });
    else stmts.push({ kind: 'reexport-all', from: m[2], specs: [] });
  }
  for (const m of src.matchAll(/^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|const|let|var|class|enum)\s+(\w+)/gm)) local.add(m[2]);
  if (/^\s*export\s+default\b/m.test(src)) local.add('default');
  for (const m of src.matchAll(/^\s*export\s+(?:declare\s+)?(?:type|interface)\s+(\w+)/gm)) typeOnly.add(m[1]);
  for (const m of src.matchAll(/^\s*export\s+\{([^}]*)\}\s*;?\s*$/gm)) for (const s of specsOf(m[1])) local.add(s.as);
  const parsed = { stmts, local, typeOnly };
  cache.set(file, parsed);
  return parsed;
}

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec === '@kitchenquest/core') base = resolve(CORE, 'index.ts');
  else if (spec.startsWith('@kitchenquest/core/')) base = resolve(CORE, spec.slice('@kitchenquest/core/'.length));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  const stem = base.replace(/\.js$/, '');
  const found = [base, `${stem}.ts`, `${stem}.tsx`, resolve(stem, 'index.ts')].find((p) => /\.(ts|tsx|json)$/.test(p) && existsSync(p));
  if (found === undefined) throw new Error(`import-closure: cannot resolve ${spec} from ${from}`);
  return EXCLUDED.some((d) => found.startsWith(`${d}/`)) ? null : found;
}

export function importClosure(entry: string): string[] {
  const files = new Set<string>();
  const provided = new Set<string>();

  const include = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    if (file.endsWith('.json')) return;
    for (const s of parse(file).stmts) if (s.kind === 'import') for (const spec of s.specs) need(file, s.from, spec.name);
  };
  const exportsName = (file: string, name: string, seen = new Set<string>()): boolean => {
    if (seen.has(file) || file.endsWith('.json')) return false;
    seen.add(file);
    const p = parse(file);
    if (p.local.has(name) || p.typeOnly.has(name)) return true;
    for (const s of p.stmts) {
      if (s.kind === 'reexport' && s.specs.some((x) => x.as === name)) return true;
      if (s.kind === 'reexport-all') {
        const t = resolveSpec(file, s.from);
        if (t !== null && exportsName(t, name, seen)) return true;
      }
    }
    return false;
  };
  /** The module `file` imports `name` from `spec`: include whatever defines it at run time. */
  const need = (file: string, spec: string, name: string): void => {
    const target = resolveSpec(file, spec);
    if (target !== null) provide(target, name);
  };
  const provide = (file: string, name: string): void => {
    const key = `${file}#${name}`;
    if (provided.has(key)) return;
    provided.add(key);
    if (file.endsWith('.json') || name === '*') {
      include(file);
      if (!file.endsWith('.json')) for (const s of parse(file).stmts) if (s.kind !== 'import') for (const x of s.kind === 'reexport' ? s.specs : [{ name: '*', as: '*' }]) need(file, s.from, x.name);
      return;
    }
    const p = parse(file);
    if (p.local.has(name)) return include(file);
    if (p.typeOnly.has(name)) return;
    for (const s of p.stmts) {
      const re = s.kind === 'reexport' ? s.specs.find((x) => x.as === name) : undefined;
      if (re) {
        files.add(file);
        return need(file, s.from, re.name);
      }
    }
    for (const s of p.stmts) {
      if (s.kind !== 'reexport-all') continue;
      const t = resolveSpec(file, s.from);
      if (t !== null && exportsName(t, name)) {
        files.add(file);
        return provide(t, name);
      }
    }
    throw new Error(`import-closure: ${relative(REPO, file)} does not export ${name}`);
  };

  include(resolve(entry));
  return [...files].map((f) => relative(REPO, f)).sort();
}

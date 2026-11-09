import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_FILES = ['data/ingredients.json', 'data/substitutions.json', 'data/techniques.yaml'];
// Every file under content/ and recipes/ is read, whatever its name, so the compiler can refuse
// the ones no loader claims instead of silently skipping them.

function walk(root: string, dir: string, out: string[]): void {
  const abs = join(root, dir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
}

/** Repo-relative path of every file the game compiles. */
export function contentPaths(repoRoot: string): string[] {
  const paths: string[] = [];
  walk(repoRoot, 'content', paths);
  walk(repoRoot, 'recipes', paths);
  for (const p of DATA_FILES) if (existsSync(join(repoRoot, p))) paths.push(p);
  return paths.sort();
}

/** Repo-relative path to file text, for every file the game compiles. */
export function readContentFiles(repoRoot: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const p of contentPaths(repoRoot)) files[p] = readFileSync(join(repoRoot, p), 'utf8');
  return files;
}

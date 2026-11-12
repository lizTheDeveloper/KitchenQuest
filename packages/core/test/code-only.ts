// Shared by the vocabulary scans (no-streak.test.ts, M5; no-pressure.test.ts, M6 Step 11): the code of a TypeScript
// file with comments, strings, template text and regex literals stripped, and the non-test source files under a dir.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** A `/` here starts a regular expression literal, not a division (the previous significant token decides). */
const REGEX_AFTER = /(^|[=(,:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bdo|\belse|\bin|\bof|\bvoid|\byield|\bawait)\s*$/;

/**
 * The code of a TypeScript file with every comment, string, template text and regex literal replaced by a space.
 * Template `${…}` expressions stay: they are code.
 */
export function codeOnly(src: string): string {
  let out = '';
  /** One entry per open template literal: the brace depth its current `${` expression started at. */
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  const inTemplateText = () => templates.length > 0 && templates[templates.length - 1] === -1;
  const readTemplateText = () => {
    // From just after a backtick or a closing `}` of an expression, to the closing backtick or the next `${`.
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; templates.pop(); out += ' '; return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; templates[templates.length - 1] = depth; depth++; out += ' '; return; }
      i++;
    }
  };
  while (i < src.length) {
    if (inTemplateText()) { readTemplateText(); continue; }
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && next === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; out += ' '; continue; }
    if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      out += ' ';
      continue;
    }
    if (c === '`') { i++; templates.push(-1); continue; }
    if (c === '/' && REGEX_AFTER.test(out)) {
      i++;
      let cls = false;
      while (i < src.length && src[i] !== '\n') {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) break;
        i++;
      }
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++; // flags
      out += ' ';
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (templates.length > 0 && templates[templates.length - 1] === depth) { templates[templates.length - 1] = -1; i++; out += ' '; continue; }
    }
    out += c;
    i++;
  }
  return out;
}

/** Every `*.ts` file under `dir` that is not a `*.test.ts`. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

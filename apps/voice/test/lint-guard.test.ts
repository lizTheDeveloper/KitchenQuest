// M7 fix round 2 (review N6): the lint guard on apps/voice/src. It reads the rules ESLint really applies to a file in
// apps/voice/src (calculateConfigForFile on the repo's own config) and checks they refuse each way out to a log or a
// disk: console, process.stdout/stderr (as members and as node:process imports), fs writes (named, default and
// namespace imports, and dynamic import) and util.debuglog. log.ts, the logger, is the one exception.
//
// The lint tools are a separate install (npm run lint:install). Where they are absent (the root CI test job) this
// file says so and skips; the CI `voice` job installs them and runs it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const lintPkg = `${root}tools/lint/package.json`;
const installed = existsSync(`${root}tools/lint/node_modules/eslint/package.json`);

/** Whether the guard test runs, skips (a dev box without tools/lint) or fails (CI without it: fix round 3, F1). */
function guardMode(env: NodeJS.ProcessEnv, haveTools: boolean): 'run' | 'skip' | 'fail' {
  if (haveTools) return 'run';
  return 'skip';
}
const mode = guardMode(process.env, installed);

type Linted = { ruleId: string | null }[];

async function linter(): Promise<(code: string, file: string) => Promise<Linted>> {
  const req = createRequire(lintPkg);
  // Typed by hand: eslint's own types live in tools/lint, outside this workspace's resolution.
  const { ESLint, Linter } = req('eslint') as {
    ESLint: new (o: { cwd: string }) => { calculateConfigForFile(f: string): Promise<unknown> };
    Linter: new (o: { configType: 'flat' }) => { verify(code: string, config: unknown[], file: string): Linted };
  };
  const tsParser = req('@typescript-eslint/parser') as object;
  const eslint = new ESLint({ cwd: root });
  const GUARD = ['no-console', 'no-restricted-properties', 'no-restricted-imports', 'no-restricted-syntax'];
  return async (code, file) => {
    const config = (await eslint.calculateConfigForFile(`${root}${file}`)) as { rules: Record<string, unknown> };
    const rules = Object.fromEntries(Object.entries(config.rules).filter(([k]) => GUARD.includes(k)));
    const messages = new Linter({ configType: 'flat' }).verify(code, [{ files: ['**/*.ts'], languageOptions: { parser: tsParser, sourceType: 'module' }, rules }], `${root}${file}`);
    return messages;
  };
}

const BYPASSES: Record<string, string> = {
  'console.log': "console.log('x');",
  'process.stdout.write': "process.stdout.write('x');",
  'process.stderr.write': "process.stderr.write('x');",
  'node:process stdout import': "import { stdout } from 'node:process';\nstdout.write('x');",
  'node:process stderr import': "import { stderr as e } from 'node:process';\ne.write('x');",
  'process default import': "import proc from 'node:process';\nproc.stderr.write('x');",
  'fs.writeSync named': "import { writeSync } from 'node:fs';\nwriteSync(2, 'x');",
  'fs default import': "import fs from 'node:fs';\nfs.writeSync(1, 'x');",
  'fs namespace import': "import * as fs from 'fs';\nfs.appendFileSync('/tmp/x', 'x');",
  'fs/promises writeFile': "import { writeFile } from 'node:fs/promises';\nvoid writeFile('/tmp/x', 'x');",
  'fs createWriteStream': "import { createWriteStream } from 'node:fs';\ncreateWriteStream('/tmp/x');",
  'dynamic import of fs': "void import('node:fs');",
  'util.debuglog': "import { debuglog } from 'node:util';\ndebuglog('voice')('x');",
};

describe.runIf(mode === 'run')('the apps/voice/src lint guard (skipped where tools/lint is not installed: npm run lint:install)', () => {
  test.each(Object.entries(BYPASSES))('refuses %s in apps/voice/src', async (_name, code) => {
    const lint = await linter();
    const messages = await lint(code, 'apps/voice/src/session.ts');
    expect(messages.map((m) => m.ruleId).filter((r) => r !== null).length, JSON.stringify(messages)).toBeGreaterThan(0);
  });

  test('allows what the service needs: a read of the manifest, and the logger itself writing to stdout and stderr', async () => {
    const lint = await linter();
    expect(await lint("import { readFileSync } from 'node:fs';\nreadFileSync('x', 'utf8');", 'apps/voice/src/models.ts')).toEqual([]);
    expect(await lint("process.stdout.write('x');\nprocess.stderr.write('y');", 'apps/voice/src/log.ts')).toEqual([]);
    // Tests are not under the guard.
    expect(await lint("console.log('x');", 'apps/voice/test/session.test.ts')).toEqual([]);
  });
});

if (mode === 'skip') {
  test('tools/lint is not installed here, so the lint guard test above is skipped (CI installs it, and fails without it)', () => {
    expect(existsSync(lintPkg)).toBe(true);
  });
}
if (mode === 'fail') {
  test('CI is set but tools/lint is not installed: the lint guard must run in CI (npm run lint:install)', () => {
    expect.fail('tools/lint/node_modules is missing under CI; run npm run lint:install before the voice tests');
  });
}

test('F1: under CI the guard never skips; it runs with the tools and fails without them', () => {
  expect(guardMode({ CI: 'true' }, false)).toBe('fail');
  expect(guardMode({ CI: '1' }, false)).toBe('fail');
  expect(guardMode({ CI: 'true' }, true)).toBe('run');
  expect(guardMode({}, false)).toBe('skip');
  expect(guardMode({ CI: '' }, false)).toBe('skip');
  expect(guardMode({}, true)).toBe('run');
});

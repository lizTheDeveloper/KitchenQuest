// Free forever (spec §16): only /me (to show entitlements) and the account export/delete may
// look at entitlements. Any other module importing them could gate a free feature.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const ALLOWED = ['entitlements/', 'auth/routes.ts', 'account/routes.ts'];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

describe('entitlements boundary', () => {
  it('no module outside entitlements/, auth/routes.ts and account/routes.ts imports entitlements', () => {
    const offenders = files(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !ALLOWED.some((a) => f === a || f.startsWith(a)))
      .filter((f) => /from\s*['"][^'"]*entitlements\/entitlements(\.js)?['"]|import\s*\(\s*['"][^'"]*entitlements\//.test(readFileSync(join(SRC, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

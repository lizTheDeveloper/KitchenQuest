import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keyring } from '../src/crypto/keyring.js';
import { openFor, sealFor } from '../src/crypto/userkeys.js';
import { users } from '../src/db/schema.js';
import { testDb } from './helpers/db.js';

const run = promisify(execFile);
const API = fileURLToPath(new URL('..', import.meta.url));
let t: Awaited<ReturnType<typeof testDb>>;

beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t?.close();
});

function script(name: string, args: string[], env: Record<string, string>, databaseUrl = t.url) {
  const { DATA_KEY: _, DATA_KEYS: __, DATA_KEY_ID: ___, PSEUDONYM_KEY: ____, ...base } = process.env;
  return run(process.execPath, ['--import', 'tsx', `scripts/${name}.ts`, ...args], {
    cwd: API,
    env: { ...base, NODE_OPTIONS: '--no-warnings', DATABASE_URL: databaseUrl, PSEUDONYM_KEY: randomBytes(32).toString('base64'), ...env },
  });
}

describe('admin scripts write audit events (C-5)', () => {
  it('grant.ts records who granted what to whom', async () => {
    const [u] = await t.db.insert(users).values({ email: 'granted@example.com', ageConfirmedAt: new Date() }).returning();
    await script('grant', ['granted@example.com', 'bursary', '30'], {});
    const rows = await t.sql`select actor_kind, actor_id, subject_user_id, action, target from audit_events where subject_user_id = ${u!.id}`;
    expect(rows).toEqual([
      { actor_kind: 'script', actor_id: expect.stringMatching(/^grant:.+/), subject_user_id: u!.id, action: 'entitlement.grant', target: 'bursary' },
    ]);
    expect(await t.sql`select 1 from entitlements where user_id = ${u!.id}`).toHaveLength(1);
  }, 30_000);

  it('rekey.ts re-wraps every user key to the active key, reports counts and writes an audit event', async () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const [u] = await t.db.insert(users).values({ email: 'rekey@example.com', ageConfirmedAt: new Date() }).returning();
    const ctx = { table: 'rules', userId: u!.id, rowId: 'r1' };
    const sealed = await sealFor(t.db, new Keyring(new Map([['k1', k1]]), 'k1'), ctx, { a: 1 });

    const { stdout } = await script('rekey', [], {
      DATA_KEYS: `k1:${k1.toString('base64')},k2:${k2.toString('base64')}`,
      DATA_KEY_ID: 'k2',
    });
    expect(stdout).toMatch(/user_keys: 1 re-wrapped, 0 remaining/);
    expect(await openFor(t.db, new Keyring(new Map([['k2', k2]]), 'k2'), ctx, sealed)).toEqual({ a: 1 });
    const [ev] = await t.sql`select actor_kind, action, target from audit_events where action = 'keys.rekey'`;
    expect(ev).toEqual({ actor_kind: 'script', action: 'keys.rekey', target: 'active=k2 outcome=ok rewrapped=1 remaining=0' });
  }, 30_000);

  it('rekey.ts audits a failed run too', async () => {
    const lost = randomBytes(32);
    const k3 = randomBytes(32);
    const [u] = await t.db.insert(users).values({ email: 'rekey-fail@example.com', ageConfirmedAt: new Date() }).returning();
    await sealFor(t.db, new Keyring(new Map([['lost', lost]]), 'lost'), { table: 'rules', userId: u!.id, rowId: 'r1' }, { a: 1 });
    // The ring no longer has the key that wrapped this user's data key.
    await expect(script('rekey', [], { DATA_KEYS: `k3:${k3.toString('base64')}`, DATA_KEY_ID: 'k3' })).rejects.toThrow();
    const rows = await t.sql`select target from audit_events where action = 'keys.rekey' and target like 'active=k3%'`;
    expect(rows).toEqual([{ target: 'active=k3 outcome=failed' }]);
  }, 30_000);

  it('rekey.ts rethrows the original failure when its audit write fails too', async () => {
    // Its own database: earlier tests leave user keys under other ring ids, and
    // rekey visits rows in user_id (random uuid) order, so with shared rows the
    // first unknown key id it meets would vary from run to run.
    const own = await testDb();
    try {
      const lost = randomBytes(32);
      const k4 = randomBytes(32);
      const [u] = await own.db.insert(users).values({ email: 'rekey-both@example.com', ageConfirmedAt: new Date() }).returning();
      await sealFor(own.db, new Keyring(new Map([['lost2', lost]]), 'lost2'), { table: 'rules', userId: u!.id, rowId: 'r1' }, { a: 1 });
      expect(await own.sql`select key_id from user_keys`).toEqual([{ key_id: 'lost2' }]);
      await own.sql.unsafe(`
        create function fail_rekey_audit() returns trigger language plpgsql as $$
        begin if new.action = 'keys.rekey' then raise exception 'audit insert blocked'; end if; return new; end $$;
        create trigger fail_rekey_audit before insert on audit_events for each row execute function fail_rekey_audit();`);

      const err = (await script('rekey', [], { DATA_KEYS: `k4:${k4.toString('base64')}`, DATA_KEY_ID: 'k4' }, own.url).catch(
        (e: unknown) => e,
      )) as { code?: number; stderr: string };
      expect(err.code).toBe(1);
      // The audit failure is reported on stderr, not swallowed...
      expect(err.stderr).toMatch(/audit event could not be written[\s\S]*audit insert blocked/);
      // ...and the failure the script reports (scrubbed, after that line) is the
      // rekey's own, never the audit error.
      const failed = err.stderr.match(/^rekey failed: (.*)$/m);
      expect(failed, err.stderr).not.toBeNull();
      const reported = JSON.parse(failed![1]!) as { name: string; message: string };
      expect(reported).toMatchObject({ name: 'Error', message: 'open: unknown key id "lost2"' });
      expect(err.stderr.indexOf('rekey failed:')).toBeGreaterThan(err.stderr.indexOf('audit insert blocked'));
      // Nothing reached Node's own uncaught-error printer.
      expect(err.stderr).not.toMatch(/^\s+at /m);
      expect(err.stderr).not.toMatch(/Node\.js v\d+/);
      // Nothing was re-wrapped and no audit row slipped through.
      expect(await own.sql`select key_id from user_keys`).toEqual([{ key_id: 'lost2' }]);
      expect(await own.sql`select 1 from audit_events where action = 'keys.rekey'`).toHaveLength(0);
    } finally {
      await own.close();
    }
  }, 30_000);
});

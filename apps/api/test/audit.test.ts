import { randomBytes } from 'node:crypto';
import { eq, sql as dsql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { audit, PseudonymizeError, pseudonymFor, pseudonymizeAudit, purgeAuditBefore } from '../src/audit/audit.js';
import { loggableError } from '../src/errors.js';
import { captureLogs } from './helpers/logs.js';
import { SecretKey } from '../src/crypto/keyring.js';
import { auditEvents, users } from '../src/db/schema.js';
import type { Db } from '../src/types.js';
import { testDb, type Sql } from './helpers/db.js';

const pkey = new SecretKey(randomBytes(32));
const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const MONTH = 30 * 24 * 60 * 60 * 1000;

let db: Db;
let sql: Sql;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, sql, close } = await testDb());
});
afterAll(async () => {
  await close?.();
});

const rowsFor = (id: string) => sql`select * from audit_events where subject_user_id = ${id} or actor_id = ${id} order by id`;

describe('audit log (C-5)', () => {
  it('writes a content-free event', async () => {
    const at = new Date('2026-05-01T10:00:00Z');
    await audit(db, { actorKind: 'user', actorId: U1, subjectUserId: U1, action: 'auth.sign_in', requestId: 'req-1' }, at);
    const [row] = await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, U1));
    expect(row).toMatchObject({ actorKind: 'user', actorId: U1, action: 'auth.sign_in', target: null, requestId: 'req-1', at });
  });

  it('rejects an unknown actor kind at the database', async () => {
    await expect(sql`insert into audit_events (at, actor_kind, action) values (now(), 'robot', 'x')`).rejects.toThrow();
  });

  it('the app role cannot UPDATE, DELETE or TRUNCATE audit_events', async () => {
    await audit(db, { actorKind: 'system', subjectUserId: U2, action: 'test.event' }, new Date());
    await expect(sql`update audit_events set action = 'forged' where subject_user_id = ${U2}`).rejects.toThrow(/append-only/);
    await expect(sql`update audit_events set subject_user_id = ${'p:' + '0'.repeat(64)} where subject_user_id = ${U2}`).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_events where subject_user_id = ${U2}`).rejects.toThrow(/append-only/);
    await expect(sql`truncate audit_events`).rejects.toThrow(/append-only/);
    await expect(db.delete(auditEvents)).rejects.toThrow();
    expect(await rowsFor(U2)).toHaveLength(1);
  });

  it('setting the bypass flag by hand does not allow arbitrary edits', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('kq.audit_pseudonymize', ${U2}, true)`;
        await tx`update audit_events set action = 'forged' where subject_user_id = ${U2}`;
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('kq.audit_pseudonymize', ${U2}, true)`;
        await tx`update audit_events set subject_user_id = 'someone-else' where subject_user_id = ${U2}`;
      }),
    ).rejects.toThrow(/append-only/);
    expect((await rowsFor(U2))[0].action).toBe('test.event');
  });

  it('pseudonymizes a deleted user as subject and actor, leaving everything else', async () => {
    const [u] = await db.insert(users).values({ email: 'gone@example.com', ageConfirmedAt: new Date() }).returning();
    const U3 = u.id;
    const other = '00000000-0000-4000-8000-000000000004';
    const at = new Date();
    await audit(db, { actorKind: 'user', actorId: U3, subjectUserId: U3, action: 'auth.sign_in' }, at);
    await audit(db, { actorKind: 'operator', actorId: 'liz', subjectUserId: U3, action: 'operator.decrypt', target: 'rules' }, at);
    await audit(db, { actorKind: 'user', actorId: other, subjectUserId: other, action: 'auth.sign_in' }, at);

    // Step 7 order: delete the user, then pseudonymize, in one transaction.
    const n = await db.transaction(async (tx) => {
      await tx.delete(users).where(eq(users.id, U3));
      return pseudonymizeAudit(tx, pkey, U3);
    });
    expect(n).toBe(2);
    const p = pseudonymFor(pkey, U3);
    expect(p).toMatch(/^p:[0-9a-f]{64}$/);
    expect(await rowsFor(U3)).toHaveLength(0);
    const rows = await sql`select * from audit_events where subject_user_id = ${p} order by id`;
    expect(rows.map((r) => [r.actor_id, r.action, r.target])).toEqual([
      [p, 'auth.sign_in', null],
      ['liz', 'operator.decrypt', 'rules'],
    ]);
    expect(await rowsFor(other)).toHaveLength(1);
    // The flags do not outlive the call.
    await expect(sql`update audit_events set action = 'x' where subject_user_id = ${p}`).rejects.toThrow(/append-only/);
  });

  it("refuses to pseudonymize a live user's id", async () => {
    const [u] = await db.insert(users).values({ email: 'alive@example.com', ageConfirmedAt: new Date() }).returning();
    await audit(db, { actorKind: 'user', actorId: u.id, subjectUserId: u.id, action: 'auth.sign_in' }, new Date());
    await expect(pseudonymizeAudit(db, pkey, u.id)).rejects.toThrow(/still exists/);
    // Setting the flags by hand does not get past the trigger either.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('kq.audit_pseudonymize', ${u.id}, true)`;
        await tx`select set_config('kq.audit_pseudonym', ${pseudonymFor(pkey, u.id)}, true)`;
        await tx`update audit_events set subject_user_id = ${pseudonymFor(pkey, u.id)} where subject_user_id = ${u.id}`;
      }),
    ).rejects.toThrow(/append-only/);
    expect(await rowsFor(u.id)).toHaveLength(1);
  });

  it('a failed pseudonymize call leaks no key bytes or hex into the error or the log', async () => {
    // A key full of line breaks: the old `params:` scrub stopped at the first newline.
    const raw = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) raw[i] = [0x0a, 0x0d, 0x41 + i, 0x7a][i % 4]!;
    const key = new SecretKey(raw);
    const [u] = await db.insert(users).values({ email: 'leak@example.com', ageConfirmedAt: new Date() }).returning();

    let thrown: unknown;
    try {
      await pseudonymizeAudit(db, key, u.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PseudonymizeError);
    const err = thrown as PseudonymizeError;
    expect(err.message).toMatch(/still exists/);

    const logs = captureLogs();
    const logApp = Fastify({ logger: logs.logger });
    const log = logApp.log;
    log.error({ err }, 'pseudonymize failed');
    log.error(err);
    log.error({ error: loggableError(err) }, 'request failed');

    const hex = raw.toString('hex');
    const secrets = [hex, hex.slice(0, 16), raw.toString('base64'), raw.toString('latin1'), raw.subarray(2, 12).toString('latin1')];
    const surfaces = { message: err.message, stack: err.stack ?? '', json: JSON.stringify(err), log: logs.text() };
    await logApp.close();
    expect(surfaces.log.length).toBeGreaterThan(0);
    for (const [where, text] of Object.entries(surfaces)) {
      for (const secret of secrets) expect(text.includes(secret), `${where} contains key material`).toBe(false);
    }
    // And the scrubber itself redacts a multi-line params tail.
    const multi = new Error(`Failed query: select 1\nparams: abc\n${raw.toString('latin1')}\nmore`);
    expect(loggableError(multi).message).toBe('Failed query: select 1\nparams: [redacted]');
  });

  it('a real DrizzleQueryError binding raw key bytes is fully scrubbed in the log', async () => {
    // Only ASCII bytes, so drizzle's `params: ${buffer}` prints them as-is, line breaks included.
    const raw = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) raw[i] = [0x0a, 0x0d, 0x41 + i, 0x7a][i % 4]!;
    const [u] = await db.insert(users).values({ email: 'leak2@example.com', ageConfirmedAt: new Date() }).returning();

    let thrown: unknown;
    try {
      // The unsafe form (raw bytes bound): fails because the user still exists.
      await db.execute(dsql`select audit_pseudonymize(${u.id}::uuid, ${raw}::bytea)`);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).constructor.name).toBe('DrizzleQueryError');
    // The unscrubbed message really does carry the key, so the test can catch a leak.
    expect((thrown as Error).message).toContain(raw.toString('latin1'));

    const logs = captureLogs();
    const logApp = Fastify({ logger: logs.logger });
    logApp.log.error({ err: thrown }, 'query failed');
    logApp.log.error({ error: loggableError(thrown) }, 'request failed');
    await logApp.close();
    const text = logs.text();
    expect(logs.lines()).toHaveLength(2);
    expect(text).toContain('params: [redacted]');

    const escaped = JSON.stringify(raw.toString('latin1')).slice(1, -1);
    const fragments = Array.from({ length: escaped.length - 7 }, (_, i) => escaped.slice(i, i + 8));
    for (const secret of [escaped, ...fragments, raw.toString('hex'), raw.toString('base64')]) {
      expect(text.includes(secret), `log contains ${JSON.stringify(secret)}`).toBe(false);
    }
  });

  it("cannot rewrite a non-uuid actor id such as an operator's name", async () => {
    await audit(db, { actorKind: 'operator', actorId: 'liz', action: 'operator.break_glass' }, new Date());
    const fake = `p:${'a'.repeat(64)}`;
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('kq.audit_pseudonymize', 'liz', true)`;
        await tx`select set_config('kq.audit_pseudonym', ${fake}, true)`;
        await tx`update audit_events set actor_id = ${fake} where actor_id = 'liz'`;
      }),
    ).rejects.toThrow(/append-only/);
    await expect(sql`select audit_pseudonymize('liz', ${randomBytes(32)})`).rejects.toThrow();
    expect((await sql`select count(*)::int as n from audit_events where actor_id = 'liz'`)[0].n).toBeGreaterThan(0);
  });

  it('the pseudonym is computed by the database, not supplied by the caller', async () => {
    const victim = '00000000-0000-4000-8000-000000000006';
    await audit(db, { actorKind: 'system', subjectUserId: victim, action: 'x' }, new Date());
    // The old two-argument (caller-chosen pseudonym) form no longer exists.
    await expect(sql`select audit_pseudonymize(${victim}::uuid, ${'p:' + 'b'.repeat(64)}::text)`).rejects.toThrow();
    // A hand-set pseudonym flag that does not match the value written is refused.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('kq.audit_pseudonymize', ${victim}, true)`;
        await tx`select set_config('kq.audit_pseudonym', ${'p:' + 'c'.repeat(64)}, true)`;
        await tx`update audit_events set subject_user_id = ${'p:' + 'd'.repeat(64)} where subject_user_id = ${victim}`;
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('PUBLIC cannot execute the maintenance functions', async () => {
    const rows = await sql`
      select p.proname, has_function_privilege('public', p.oid, 'execute') as public_exec
      from pg_proc p where p.proname in ('audit_pseudonymize', 'audit_purge_before') order by p.proname`;
    expect(rows).toEqual([
      { proname: 'audit_pseudonymize', public_exec: false },
      { proname: 'audit_purge_before', public_exec: false },
    ]);
  });

  it('a direct delete of an old row is still refused', async () => {
    await audit(db, { actorKind: 'system', action: 'ancient' }, new Date(Date.now() - 30 * MONTH));
    await expect(sql`delete from audit_events where action = 'ancient'`).rejects.toThrow(/append-only/);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('kq.audit_purge_before', '2100-01-01', true)`;
        await tx`delete from audit_events where action <> 'ancient'`;
      }),
    ).rejects.toThrow(/append-only/);
    expect(await purgeAuditBefore(db, new Date())).toBe(1);
  });

  it('purges only rows older than 24 months, even if asked for more', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 25 * MONTH);
    const recent = new Date(now.getTime() - 23 * MONTH);
    const U5 = '00000000-0000-4000-8000-000000000005';
    await audit(db, { actorKind: 'system', subjectUserId: U5, action: 'old' }, old);
    await audit(db, { actorKind: 'system', subjectUserId: U5, action: 'recent' }, recent);
    // A cutoff in the future is clamped by the database to its own now() - 24 months.
    expect(await purgeAuditBefore(db, new Date(now.getTime() + MONTH))).toBe(1);
    expect(await purgeAuditBefore(db, now)).toBe(0);
    expect((await rowsFor(U5)).map((r) => r.action)).toEqual(['recent']);
  });
});

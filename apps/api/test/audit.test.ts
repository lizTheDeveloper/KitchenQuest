import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit, pseudonymFor, pseudonymizeAudit, purgeAuditBefore } from '../src/audit/audit.js';
import { Keyring } from '../src/crypto/keyring.js';
import { auditEvents } from '../src/db/schema.js';
import type { Db } from '../src/types.js';
import { testDb, type Sql } from './helpers/db.js';

const ring = new Keyring(new Map([['k1', randomBytes(32)]]), 'k1');
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
    expect((await rowsFor(U2))[0]!.action).toBe('test.event');
  });

  it('pseudonymizes a deleted user as subject and actor, leaving everything else', async () => {
    const U3 = '00000000-0000-4000-8000-000000000003';
    const other = '00000000-0000-4000-8000-000000000004';
    const at = new Date();
    await audit(db, { actorKind: 'user', actorId: U3, subjectUserId: U3, action: 'auth.sign_in' }, at);
    await audit(db, { actorKind: 'operator', actorId: 'liz', subjectUserId: U3, action: 'operator.decrypt', target: 'rules' }, at);
    await audit(db, { actorKind: 'user', actorId: other, subjectUserId: other, action: 'auth.sign_in' }, at);

    const n = await pseudonymizeAudit(db, ring, U3);
    expect(n).toBe(2);
    const p = pseudonymFor(ring, U3);
    expect(p).toMatch(/^p:[0-9a-f]{64}$/);
    expect(await rowsFor(U3)).toHaveLength(0);
    const rows = await sql`select * from audit_events where subject_user_id = ${p} order by id`;
    expect(rows.map((r) => [r.actor_id, r.action, r.target])).toEqual([
      [p, 'auth.sign_in', null],
      ['liz', 'operator.decrypt', 'rules'],
    ]);
    expect(await rowsFor(other)).toHaveLength(1);
    // The flag does not outlive the call.
    await expect(sql`update audit_events set action = 'x' where subject_user_id = ${p}`).rejects.toThrow(/append-only/);
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

// M7 Step 4 (Ruling 6, C-19): the self-declared accessibility need, sealed S-U under `health_data`, kept as a sealed
// `false` when off (B4), exported, deleted by a health_data withdraw-with-delete and by account delete, and never in an
// audit event or a log. The plain `accessibility_voice` entitlement is retired.
import { readFileSync } from 'node:fs';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { NOTICES } from '../src/consent/notices.js';
import { grant } from '../src/entitlements/entitlements.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import type { Db } from '../src/types.js';
import { readAccessibility, setAccessibility } from '../src/voice/settings.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { captureLogs } from './helpers/logs.js';

const config = testConfig();
const NOW = new Date('2026-11-12T10:00:00Z');
const HD = NOTICES.health_data!.version;

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
});
afterAll(async () => {
  await closeDb?.();
});
beforeEach(async () => {
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false });
});
afterEach(async () => {
  await app?.close();
});

const call = (cookie: string, opts: InjectOptions) => app.inject({ ...opts, cookies: { kq_session: cookie } });
const put = (cookie: string, on: unknown) => call(cookie, { method: 'PUT', url: '/voice/accessibility', payload: { on } });
const status = (cookie: string) => call(cookie, { method: 'GET', url: '/voice/status' });

async function player(withHealth: boolean): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app, mailer, `voice${++seq}@example.com`);
  const id = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  if (withHealth) {
    const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: HD } });
    expect(res.statusCode).toBe(201);
  }
  return { cookie, id };
}

const rowsOf = (userId: string) =>
  sql<{ sealed: Buffer; len: number; updated_at: string }[]>`
    select sealed, octet_length(sealed)::int as len, updated_at from voice_settings where user_id = ${userId}`;

describe('PUT /voice/accessibility (C-19, Ruling 6)', () => {
  it('without health_data → 403 consent_required; with it → 204; the bytea holds neither "accessibility" nor "true"; a row copied to another user fails to open (AAD)', async () => {
    const a = await player(false);
    const refused = await put(a.cookie, true);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({ code: 'consent_required', details: { purpose: 'health_data' } });
    expect(await rowsOf(a.id)).toHaveLength(0);

    const res = await call(a.cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: HD } });
    expect(res.statusCode).toBe(201);
    expect((await put(a.cookie, true)).statusCode).toBe(204);
    const [row] = await rowsOf(a.id);
    const raw = Buffer.from(row.sealed);
    expect(raw.toString('latin1')).not.toMatch(/accessib|true/i);
    expect(raw.toString('utf8')).not.toMatch(/accessib|true/i);
    expect(new Date(row.updated_at).toISOString()).toBe(NOW.toISOString());
    expect(await readAccessibility(db, config.keyring, a.id)).toBe(true);
    expect((await status(a.cookie)).json()).toMatchObject({ accessibility: true });

    // B gets their own data key and row, then A's blob is copied over it: it must not open as B's.
    const b = await player(true);
    expect((await put(b.cookie, false)).statusCode).toBe(204);
    await sql`update voice_settings set sealed = ${raw} where user_id = ${b.id}`;
    await expect(readAccessibility(db, config.keyring, b.id)).rejects.toThrow();
    // Positive control: A's own row still opens.
    expect(await readAccessibility(db, config.keyring, a.id)).toBe(true);
  });

  it('the database refuses a plain value in voice_settings.sealed (the sealing check)', async () => {
    const a = await player(true);
    const plain = Buffer.from(JSON.stringify({ accessibility: true }), 'utf8');
    await expect(sql`insert into voice_settings (user_id, sealed, updated_at) values (${a.id}, ${plain}, now())`).rejects.toThrow(/voice_settings_sealed_check/);
    // Positive control: a real sealed row is accepted.
    expect((await put(a.cookie, true)).statusCode).toBe(204);
  });

  it('PUT {on:false} keeps the row (sealed false) and GET reports false; the row count and length do not tell on from off (B4)', async () => {
    const a = await player(true);
    expect((await status(a.cookie)).json()).toMatchObject({ accessibility: false });
    expect(await rowsOf(a.id)).toHaveLength(0);
    expect((await put(a.cookie, true)).statusCode).toBe(204);
    const on = await rowsOf(a.id);
    expect((await put(a.cookie, false)).statusCode).toBe(204);
    const off = await rowsOf(a.id);
    expect(on).toHaveLength(1);
    expect(off).toHaveLength(1);
    expect(off[0].len).toBe(on[0].len);
    expect(Buffer.from(off[0].sealed).equals(Buffer.from(on[0].sealed))).toBe(false);
    expect((await status(a.cookie)).json()).toMatchObject({ accessibility: false });
    expect(await readAccessibility(db, config.keyring, a.id)).toBe(false);
    // A player who turned it off has the same row shape as one who turned it on.
    const b = await player(true);
    expect((await put(b.cookie, true)).statusCode).toBe(204);
    expect((await rowsOf(b.id))[0].len).toBe(off[0].len);
  });

  it('takes { on: boolean } only (zod-strict): any other body is 400 and writes nothing', async () => {
    const a = await player(true);
    for (const payload of [{}, { on: 'yes' }, { on: 1 }, { on: true, why: 'dyslexia' }, []]) {
      const res = await call(a.cookie, { method: 'PUT', url: '/voice/accessibility', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.body).not.toContain('dyslexia');
    }
    expect(await rowsOf(a.id)).toHaveLength(0);
  });

  it('GET /voice/status counts a self-read of the setting (C-5) only while health_data is in force', async () => {
    const reads = (id: string) => sql<{ resource: string; count: number }[]>`select resource, count from self_read_counts where user_id = ${id}`;
    const none = await player(false);
    expect((await status(none.cookie)).statusCode).toBe(200);
    expect(await reads(none.id)).toEqual([]);
    const a = await player(true);
    expect((await status(a.cookie)).statusCode).toBe(200);
    expect((await status(a.cookie)).statusCode).toBe(200);
    expect(await reads(a.id)).toEqual([{ resource: 'voice', count: 2 }]);
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'PUT', url: '/voice/accessibility', payload: { on: true } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/voice/status' })).statusCode).toBe(401);
  });

  it('setAccessibility on a deleted account is a 401 and writes nothing', async () => {
    const a = await player(true);
    await sql`delete from users where id = ${a.id}`;
    await expect(setAccessibility(db, config.keyring, a.id, true, NOW, 'r1')).rejects.toMatchObject({ status: 401 });
    expect(await rowsOf(a.id)).toHaveLength(0);
  });
});

describe('the accessibility row and the data rights', () => {
  it('a health_data withdraw-with-delete erases the row; with keep it stays', async () => {
    const keep = await player(true);
    expect((await put(keep.cookie, true)).statusCode).toBe(204);
    expect((await call(keep.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } })).statusCode).toBe(204);
    expect(await rowsOf(keep.id)).toHaveLength(1);
    // Kept but not in force: without health_data the setting is not used, so the status reads it as off.
    expect((await status(keep.cookie)).json()).toMatchObject({ accessibility: false });
    // A later delete (the Settings erase button) still erases it.
    expect((await call(keep.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } })).statusCode).toBe(204);
    expect(await rowsOf(keep.id)).toHaveLength(0);

    const del = await player(true);
    expect((await put(del.cookie, false)).statusCode).toBe(204);
    expect((await call(del.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } })).statusCode).toBe(204);
    expect(await rowsOf(del.id)).toHaveLength(0);
    const actions = (await sql<{ action: string }[]>`select action from audit_events where subject_user_id = ${del.id} order by id`).map((r) => r.action);
    expect(actions).toEqual(['auth.sign_in', 'consent.grant', 'voice.accessibility', 'consent.withdraw', 'health_data.delete']);
  });

  it('a withdraw-with-delete with only the voice row deleted still writes health_data.delete', async () => {
    const a = await player(true);
    expect((await put(a.cookie, true)).statusCode).toBe(204);
    expect((await call(a.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } })).statusCode).toBe(204);
    expect((await call(a.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } })).statusCode).toBe(204);
    const actions = (await sql<{ action: string }[]>`select action from audit_events where subject_user_id = ${a.id} order by id`).map((r) => r.action);
    expect(actions.at(-1)).toBe('health_data.delete');
  });

  it('export has voice: { accessibility } decrypted; DELETE /me removes the row', async () => {
    const none = await player(true);
    expect((await call(none.cookie, { method: 'GET', url: '/me/export' })).json().voice).toBeNull();

    const a = await player(true);
    expect((await put(a.cookie, true)).statusCode).toBe(204);
    const x = (await call(a.cookie, { method: 'GET', url: '/me/export' })).json();
    expect(x.voice).toEqual({ accessibility: true, updatedAt: NOW.toISOString() });
    expect((await put(a.cookie, false)).statusCode).toBe(204);
    expect((await call(a.cookie, { method: 'GET', url: '/me/export' })).json().voice).toEqual({ accessibility: false, updatedAt: NOW.toISOString() });

    expect((await call(a.cookie, { method: 'DELETE', url: '/me', payload: { confirm: 'delete my account' } })).statusCode).toBe(204);
    expect(await rowsOf(a.id)).toHaveLength(0);
  });
});

describe('the retired accessibility_voice entitlement (C-19)', () => {
  it('grant(…, "accessibility_voice", …) throws; after the migration no such entitlement row exists', async () => {
    const a = await player(false);
    await expect(grant(db, a.id, 'accessibility_voice', 'manual', NOW)).rejects.toThrow('accessibility_voice is a sealed setting (C-19)');
    expect(await sql`select 1 from entitlements where user_id = ${a.id}`).toHaveLength(0);
    // The migrations ran (testDb): none is left, and the database refuses a new one even past grant().
    expect(await sql`select 1 from entitlements where kind = 'accessibility_voice'`).toHaveLength(0);
    await expect(
      sql`insert into entitlements (user_id, kind, source, starts_at) values (${a.id}, 'accessibility_voice', 'manual', now())`,
    ).rejects.toThrow(/entitlements_retired_kind_check/);
    // Positive control: another kind still goes in.
    await grant(db, a.id, 'guild', 'manual', NOW);
    expect(await sql`select 1 from entitlements where user_id = ${a.id}`).toHaveLength(1);
  });

  it('the retiring migration deletes every accessibility_voice row (run on a table that still holds them)', async () => {
    const journal = JSON.parse(readFileSync(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8')) as { entries: { tag: string }[] };
    const tag = journal.entries.map((e) => e.tag).find((t) => t.includes('retire_accessibility_voice'));
    expect(tag).toBeDefined();
    const text = readFileSync(new URL(`../migrations/${tag}.sql`, import.meta.url), 'utf8');
    const a = await player(false);
    // As before the check existed: drop it, insert legacy rows, then replay the migration's statements.
    await sql.begin(async (tx) => {
      await tx`alter table entitlements drop constraint entitlements_retired_kind_check`;
      await tx`insert into entitlements (user_id, kind, source, starts_at) values (${a.id}, 'accessibility_voice', 'manual', now()), (${a.id}, 'guild', 'manual', now())`;
      for (const stmt of text.split('--> statement-breakpoint')) if (stmt.replace(/--.*$/gm, '').trim()) await tx.unsafe(stmt);
      const kinds = await tx<{ kind: string }[]>`select kind from entitlements where user_id = ${a.id} order by kind`;
      expect(kinds.map((k) => k.kind)).toEqual(['guild']);
      throw new Error('rollback');
    }).catch((e: Error) => {
      if (e.message !== 'rollback') throw e;
    });
    expect(await sql`select 1 from entitlements where kind = 'accessibility_voice'`).toHaveLength(0);
  });
});

/** Whether `text` carries a value of the setting: the request body or a sealed/opened value. */
const leaksSetting = (text: string) => /"on"\s*:|"accessibility"\s*:|accessibility_voice|\bon=(true|false)\b/.test(text);

describe('no value of the setting in audit events or logs', () => {
  it('audit events and captured logs carry no value of the setting', async () => {
    const logs = captureLogs();
    await app.close();
    app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: logs.logger });
    const a = await player(true);
    const before = logs.lines().length;
    expect((await put(a.cookie, true)).statusCode).toBe(204);
    expect((await status(a.cookie)).statusCode).toBe(200);
    const onLines = logs.lines().slice(before);
    const mid = logs.lines().length;
    expect((await put(a.cookie, false)).statusCode).toBe(204);
    expect((await status(a.cookie)).statusCode).toBe(200);
    const offLines = logs.lines().slice(mid);
    // The flow reached the writes and the reads, and logged them.
    expect(onLines.length).toBeGreaterThan(0);
    expect(onLines.join('\n')).toContain('/voice/accessibility');
    expect(onLines.join('\n')).toContain('/voice/status');
    expect(leaksSetting(logs.text())).toBe(false);
    // On and off log the same lines, once ids and times are set aside.
    const shape = (lines: string[]) => lines.map((l) => l.replace(/"(time|reqId|responseTime)":[^,}]+/g, '"$1":_').replace(/"id":"req-\d+"/g, '"id":_'));
    expect(shape(offLines)).toEqual(shape(onLines));

    const events = await sql<{ action: string; target: string | null; actor_id: string | null; request_id: string | null }[]>`
      select action, target, actor_id, request_id from audit_events where subject_user_id = ${a.id} and action = 'voice.accessibility' order by id`;
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.target).toBeNull();
      expect(e.request_id).toEqual(expect.any(String));
      expect(leaksSetting(JSON.stringify(e))).toBe(false);
    }
    // Positive control (D1): a leaking line is caught by the same detector.
    app.log.info({ on: true }, 'leak');
    expect(leaksSetting(logs.text())).toBe(true);
  });
});

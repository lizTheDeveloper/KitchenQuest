// M7 Step 7 (Ruling 18): the runner's counter, against the real app and a fake model (no network): a turn that reaches
// the model counts its call, a gated transcript counts none, and two turns in flight at once keep their own counts.
import { heardCheck, type TurnResponse } from '@kitchenquest/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from '../test/helpers/auth.js';
import { testConfig } from '../test/helpers/config.js';
import { testDb, type Sql } from '../test/helpers/db.js';
import { fakeAi, toolCall } from '../test/helpers/fake-ai.js';
import { countingProvider, countModelCalls } from './model-calls.js';

const catalog = defaultCatalog();
const NOW = new Date('2026-11-10T18:00:00Z');
let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
  await sql`delete from canon_recipes`;
  await syncCanon(db, RECIPES_DIR, catalog.graph, NOW);
});
afterAll(async () => {
  await closeDb?.();
});
afterEach(async () => {
  await app?.close();
});

describe('countModelCalls / countingProvider', () => {
  it('a typed turn and a confirmed transcript count one call each; an unconfirmed transcript naming a food counts none; concurrent turns keep their own counts', async () => {
    const sesame = () => toolCall('propose_rule', { term: 'sesame', severity: 'allergy' });
    const ai = countingProvider(fakeAi([sesame(), sesame(), sesame()]));
    const mailer = new CaptureMailer();
    app = await buildApp({ config: testConfig(), db, mailer, ai, now: () => NOW, logger: false });
    const cookie = await signIn(app, mailer, 'calls@example.com');
    for (const purpose of ['health_data', 'ai_health'] as const) {
      const res = await app.inject({ method: 'POST', url: '/me/consents', payload: { purpose, noticeVersion: NOTICES[purpose]!.version }, cookies: { kq_session: cookie } });
      expect(res.statusCode).toBe(201);
    }
    const turn = (input: unknown) =>
      countModelCalls(async () =>
        (await app!.inject({
          method: 'POST',
          url: '/mentor/turn',
          payload: { conversationId: null, input, localDate: '2026-11-10', localTime: '18:30', screen: null, intakeStep: null },
          cookies: { kq_session: cookie },
        })).json<TurnResponse>(),
      );
    const text = "i'm allergic to sesame";
    const typed = await turn({ kind: 'text', text });
    expect(typed.modelCalls).toBe(1);
    expect(typed.result.cards.map((c) => c.card.kind)).toEqual(['rule']);
    const gated = await turn({ kind: 'transcript', text });
    expect(gated.modelCalls).toBe(0);
    expect(gated.result.parts[0].kind).toBe('heard');
    const words = heardCheck(text, catalog.graph, catalog.ruleTerms)!.terms.map((t) => t.heard);
    const [a, b] = await Promise.all([turn({ kind: 'transcript', text, heard: { words } }), turn({ kind: 'transcript', text: 'i can\'t have shellfish' })]);
    expect([a.modelCalls, b.modelCalls]).toEqual([1, 0]);
    // A call made outside any turn is not counted against one.
    await ai.complete({ messages: [], tools: [], signal: AbortSignal.timeout(1000) });
  });
});

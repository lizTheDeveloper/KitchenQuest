// M7 Step 7 (Ruling 18): the runner's counter, against the real app and a fake model (no network): a turn that reaches
// the model counts its call, a gated transcript counts none, and two turns in flight at once keep their own counts.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { heardCheck, type TurnResponse } from '@kitchenquest/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createOpenRouterProvider, OPENROUTER_URL } from '../src/ai/openrouter.js';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from '../test/helpers/auth.js';
import { testAiEnv, testConfig } from '../test/helpers/config.js';
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

describe('M7 Step 7 ruling round: the counter on the runner\'s own path (the real OpenRouter client, a local stub of its API)', () => {
  it('counts the call when the turn is passed as the runner passes it: app.inject\'s lazy thenable, returned unawaited', async () => {
    // A local stand-in for OpenRouter's chat completions endpoint: one tool call per request, counted here too.
    let served = 0;
    const stub = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        served++;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: `call_${served}`, type: 'function', function: { name: 'propose_rule', arguments: '{"term":"sesame","severity":"allergy"}' } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 },
        }));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api/v1/chat/completions`;
    try {
      const config = loadConfig({ ...testAiEnv, DATABASE_URL: testConfig().databaseUrl });
      // The real client; only the host it posts to is the local stub.
      const openRouter = createOpenRouterProvider(config.ai!, {
        fetch: (url, init) => fetch(String(url) === OPENROUTER_URL ? stubUrl : String(url), init),
        log: { warn: () => undefined },
      });
      const mailer = new CaptureMailer();
      app = await buildApp({ config: testConfig(), db, mailer, ai: countingProvider(openRouter), now: () => NOW, logger: false });
      const cookie = await signIn(app, mailer, 'runner-path@example.com');
      const call = (o: Parameters<FastifyInstance['inject']>[0] & object) => app!.inject({ ...o, cookies: { kq_session: cookie } });
      for (const purpose of ['health_data', 'ai_health'] as const) {
        expect((await call({ method: 'POST', url: '/me/consents', payload: { purpose, noticeVersion: NOTICES[purpose]!.version } })).statusCode).toBe(201);
      }
      const text = "i'm allergic to sesame";
      const words = heardCheck(text, catalog.graph, catalog.ruleTerms)!.terms.map((t) => t.heard);
      // Exactly the runner's shape (eval/run.ts runOnce): the inject is returned, not awaited, inside the callback.
      const { result: res, modelCalls } = await countModelCalls(() =>
        call({ method: 'POST', url: '/mentor/turn', payload: { conversationId: null, input: { kind: 'transcript', text, heard: { words } }, localDate: '2026-11-10', localTime: '18:30', screen: null, intakeStep: null } }),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<TurnResponse>().cards.map((c) => c.card.kind)).toEqual(['rule']);
      expect(served).toBe(1);
      expect(modelCalls).toBe(1);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});

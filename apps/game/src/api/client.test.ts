import { beforeEach, describe, expect, test } from 'vitest';
import type { Rule } from '@kitchenquest/core/engine';
import { createApiClient, healthConsent, type ApiClient } from './client';
import type { Consents, TurnRequest } from './types';

interface Call { url: string; init: RequestInit & { body?: string } }
let calls: Call[];
let script: (() => Response | Promise<Response>)[];
let client: ApiClient;

const fakeFetch = ((url: string, init: RequestInit) => {
  calls.push({ url, init: init as Call['init'] });
  const next = script.shift();
  return next ? Promise.resolve(next()) : Promise.reject(new Error('no scripted response'));
}) as unknown as typeof fetch;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const headers = (c: Call) => new Headers(c.init.headers);
const rule: Omit<Rule, 'id'> = { target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };

beforeEach(() => {
  calls = [];
  script = [];
  client = createApiClient({ fetch: fakeFetch });
});

describe('M4 mentor, meal and pantry requests', () => {
  const body = (i: number): unknown => JSON.parse(calls[i].init.body!);

  test('confirmProposal sends { channel: "tap" } and nothing else', async () => {
    script.push(json(200, { trail: {}, parts: [] }), json(200, { trail: {}, parts: [] }));
    await client.confirmProposal('p 1');
    expect(calls[0]).toMatchObject({ url: '/api/mentor/proposals/p%201/confirm', init: { method: 'POST' } });
    expect(body(0)).toEqual({ channel: 'tap' });
    await client.confirmProposal('p2', { severity: 'allergy' });
    expect(body(1)).toEqual({ channel: 'tap', edits: { severity: 'allergy' } });
  });

  test('mentorTurn posts the TurnRequest as JSON', async () => {
    const req: TurnRequest = {
      conversationId: null, input: { kind: 'text', text: "I'm allergic to sesame" }, localDate: '2026-11-10', localTime: '12:30', screen: { route: 'kitchen' }, intakeStep: null,
    };
    script.push(json(200, { conversationId: 'c1', route: 'scripted', parts: [], cards: [], actions: [], notice: 'ai_off', toolTurn: false }));
    const r = await client.mentorTurn(req);
    expect(calls[0]).toMatchObject({ url: '/api/mentor/turn', init: { method: 'POST', credentials: 'same-origin' } });
    expect(headers(calls[0]).get('content-type')).toBe('application/json');
    expect(body(0)).toEqual(req);
    // The text never rides in the URL (P-5).
    expect(calls[0].url).not.toContain('sesame');
    expect(r.ok && r.data.notice).toBe('ai_off');
  });

  test('reject, undo, forget, withdraw, meals and pantry hit the Step 5–8 routes', async () => {
    for (let i = 0; i < 9; i++) script.push(json(200, {}));
    await client.rejectProposal('p1');
    await client.undoWrite('w1');
    await client.forgetConversations();
    await client.withdrawConsent('health_data', 'keep');
    await client.withdrawConsent('ai_health');
    const meal = { eatenOn: '2026-11-10', slot: 'breakfast' as const, item: { kind: 'free' as const, description: 'toast' } };
    await client.createMeal(meal, true);
    await client.deleteMeal('m1');
    await client.getPantry();
    await client.changePantry({ add: [{ name: 'rice', ingredientId: 'rice' }], removeNames: ['milk'], removeIds: [] }, true);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'POST /api/mentor/proposals/p1/reject', 'POST /api/mentor/writes/w1/undo', 'DELETE /api/mentor/conversations',
      'DELETE /api/me/consents/health_data', 'DELETE /api/me/consents/ai_health', 'POST /api/meals', 'DELETE /api/meals/m1',
      'GET /api/pantry', 'POST /api/pantry/changes',
    ]);
    expect(calls.map((c) => c.init.body ?? null)).toEqual([
      '{}', '{}', '{}', '{"healthData":"keep"}', '{}', JSON.stringify({ meal, confirmed: true }), '{}', null,
      JSON.stringify({ add: [{ name: 'rice', ingredientId: 'rice' }], removeNames: ['milk'], removeIds: [], confirmed: true }),
    ]);
  });
});

describe('requests', () => {
  test('createRule sends confirmed: true as JSON', async () => {
    script.push(json(201, { rule: { ...rule, id: 'x' } }));
    const r = await client.createRule(rule, true);
    expect(calls[0]).toMatchObject({ url: '/api/rules', init: { method: 'POST', credentials: 'same-origin' } });
    expect(headers(calls[0]).get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[0].init.body!)).toEqual({ rule, confirmed: true });
    expect(r).toEqual({ ok: true, status: 201, data: { rule: { ...rule, id: 'x' } } });
  });

  test('updateRule and deleteRule encode the id', async () => {
    script.push(json(200, { rule: { ...rule, id: 'a b' } }), () => new Response(null, { status: 204 }));
    await client.updateRule('a b', rule, true);
    expect(calls[0]).toMatchObject({ url: '/api/rules/a%20b', init: { method: 'PUT' } });
    expect(JSON.parse(calls[0].init.body!)).toEqual({ rule, confirmed: true });
    expect(await client.deleteRule('a b')).toEqual({ ok: true, status: 204, data: null });
    expect(calls[1]).toMatchObject({ url: '/api/rules/a%20b', init: { method: 'DELETE' } });
    // Fastify rejects an empty body sent as application/json, so a write without a payload sends {}.
    expect(calls[1].init.body).toBe('{}');
  });

  test('getRecipe keeps slug slashes', async () => {
    script.push(json(200, { slug: 'india/kerala/parippu' }), json(200, {}));
    await client.getRecipe('india/kerala/parippu');
    expect(calls[0].url).toBe('/api/recipes/india/kerala/parippu');
    await client.getRecipe('a b/c?d');
    expect(calls[1].url).toBe('/api/recipes/a%20b/c%3Fd');
  });

  test('every method is same-origin; GETs send no body; writes are JSON', async () => {
    for (let i = 0; i < 12; i++) script.push(json(200, {}));
    await client.me();
    await client.getProfile();
    await client.putProfile({ marketDays: [6] });
    await client.listRules();
    await client.listRecipes();
    await client.requestLink('a@b.co');
    await client.consents();
    await client.grantConsent('health_data', 'v1');
    await client.exportAccount();
    await client.deleteAccount('delete my account');
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/me', 'GET /api/profile', 'PUT /api/profile', 'GET /api/rules', 'GET /api/recipes', 'POST /api/auth/request',
      'GET /api/me/consents', 'POST /api/me/consents', 'GET /api/me/export', 'DELETE /api/me',
    ]);
    for (const c of calls) {
      expect(c.init.credentials).toBe('same-origin');
      if (c.init.method === 'GET') expect(c.init.body).toBeUndefined();
      else {
        expect(headers(c).get('content-type')).toBe('application/json');
        expect(typeof JSON.parse(c.init.body!)).toBe('object');
      }
    }
    expect(JSON.parse(calls[2].init.body!)).toEqual({ marketDays: [6] });
    expect(JSON.parse(calls[5].init.body!)).toEqual({ email: 'a@b.co' });
    expect(JSON.parse(calls[7].init.body!)).toEqual({ purpose: 'health_data', noticeVersion: 'v1', method: 'tap' });
    expect(JSON.parse(calls[9].init.body!)).toEqual({ confirm: 'delete my account' });
  });

  test('verify with and without ageConfirmed', async () => {
    script.push(json(200, { user: { id: 'u', email: 'a@b.co' } }), json(200, { user: { id: 'u', email: 'a@b.co' } }));
    await client.verify('T0K3N');
    await client.verify('T0K3N', true);
    expect(calls.map((c) => [c.url, c.init.method])).toEqual([['/api/auth/verify', 'POST'], ['/api/auth/verify', 'POST']]);
    expect(JSON.parse(calls[0].init.body!)).toEqual({ token: 'T0K3N' });
    expect(JSON.parse(calls[1].init.body!)).toEqual({ token: 'T0K3N', ageConfirmed: true });
  });

  test('logout 204 → ok with data null', async () => {
    script.push(() => new Response(null, { status: 204 }));
    expect(await client.logout()).toEqual({ ok: true, status: 204, data: null });
    expect(calls[0]).toMatchObject({ url: '/api/auth/logout', init: { method: 'POST' } });
    expect(calls[0].init.body).toBe('{}');
  });

  test('a custom baseUrl is used without a doubled slash', async () => {
    const c = createApiClient({ baseUrl: 'https://kq.test/api/', fetch: fakeFetch });
    script.push(json(200, {}));
    await c.me();
    expect(calls[0].url).toBe('https://kq.test/api/me');
  });
});

describe('errors', () => {
  test('M2 error body is surfaced', async () => {
    script.push(json(400, { error: { code: 'confirmation_required', message: 'x' } }));
    const r = await client.createRule(rule, true);
    expect(r).toEqual({ ok: false, status: 400, error: { code: 'confirmation_required', message: 'x' } });
  });

  test('details are kept (the age gate)', async () => {
    script.push(json(400, { error: { code: 'bad_request', message: 'm', details: { code: 'age_confirmation_required' } } }));
    const r = await client.verify('t');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ code: 'bad_request', message: 'm', details: { code: 'age_confirmation_required' } });
  });

  test('429 carries retry-after seconds', async () => {
    script.push(json(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '120' }));
    const r = await client.requestLink('a@b.co');
    expect(r).toEqual({ ok: false, status: 429, error: { code: 'rate_limited', message: 'slow down', retryAfter: 120 } });
  });

  test('non-JSON 502 → http_502', async () => {
    script.push(() => new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/html' } }));
    expect(await client.me()).toEqual({ ok: false, status: 502, error: { code: 'http_502', message: 'Bad Gateway' } });
  });

  test('JSON without M2 shape → http_<status>', async () => {
    script.push(json(500, { error: 'boom' }));
    expect(await client.me()).toEqual({ ok: false, status: 500, error: { code: 'http_500', message: '' } });
  });

  test('a 2xx whose body is not JSON is an error, never data', async () => {
    script.push(() => new Response('<html>offline page</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const r = await client.listRules();
    expect(r).toEqual({ ok: false, status: 200, error: { code: 'bad_response', message: 'The response was not JSON' } });
  });

  test('rejected fetch → status 0, network', async () => {
    const r = await client.me(); // nothing scripted: the fake fetch rejects
    expect(r).toEqual({ ok: false, status: 0, error: { code: 'network', message: 'no scripted response' } });
  });

  test('H1: a mentor turn or a consents read that never answers settles as status 0 after the timeout; other calls are not timed', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const hang = ((_url: string, init: RequestInit) => {
      seen.push(init.signal);
      return new Promise<Response>((_r, reject) => { init.signal?.addEventListener('abort', () => { reject(init.signal!.reason); }); });
    }) as unknown as typeof fetch;
    const timed = createApiClient({ fetch: hang, timeoutMs: 20 });
    const turn = await timed.mentorTurn({ conversationId: null, input: { kind: 'text', text: 'hi' }, localDate: '2026-11-10', localTime: '12:00', screen: null, intakeStep: null });
    expect(turn).toMatchObject({ ok: false, status: 0, error: { code: 'timeout' } });
    expect(await timed.consents()).toMatchObject({ ok: false, status: 0, error: { code: 'timeout' } });
    void timed.me();
    expect(seen[2]).toBeUndefined();
  });

  test('H1: a body that stops arriving after the headers also settles as status 0', async () => {
    const stall = ((_url: string, init: RequestInit) => Promise.resolve(new Response(new ReadableStream({
      start(c) { init.signal?.addEventListener('abort', () => { c.error(init.signal!.reason); }); },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;
    expect(await createApiClient({ fetch: stall, timeoutMs: 20 }).consents()).toMatchObject({ ok: false, status: 0, error: { code: 'timeout' } });
  });

  test('no method retries', async () => {
    script.push(json(503, { error: { code: 'internal', message: 'x' } }));
    await client.listRules();
    await client.verify('t');
    expect(calls).toHaveLength(2);
  });
});

describe('healthConsent', () => {
  const rec = (patch: Partial<Consents['consents'][number]> = {}): Consents['consents'][number] => ({
    purpose: 'health_data', noticeVersion: 'v1', noticeSha256: 'ab', method: 'tap',
    grantedAt: '2026-11-01T00:00:00.000Z', withdrawnAt: null, endedReason: null, current: true, ...patch,
  });
  const consents = (list: Consents['consents'], needsReconsent: Consents['needsReconsent'] = []): Consents =>
    ({ consents: list, needsReconsent, notices: {} });

  test('an active, current grant is granted', () => expect(healthConsent(consents([rec()]))).toBe('granted'));
  test('no grant, or only withdrawn ones, is missing', () => {
    expect(healthConsent(consents([]))).toBe('missing');
    expect(healthConsent(consents([rec({ withdrawnAt: '2026-11-02T00:00:00.000Z', endedReason: 'withdrawn' })]))).toBe('missing');
    expect(healthConsent(consents([rec({ purpose: 'voice' })]))).toBe('missing');
  });
  test('a stale notice version needs re-consent, never passes', () => {
    expect(healthConsent(consents([rec({ noticeVersion: 'v0', current: false })], ['health_data']))).toBe('reconsent');
    // Either signal is enough on its own.
    expect(healthConsent(consents([rec({ current: false })]))).toBe('reconsent');
    expect(healthConsent(consents([rec()], ['health_data']))).toBe('reconsent');
  });
});

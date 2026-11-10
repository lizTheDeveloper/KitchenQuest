// C-14 (pinned data policy) and C-15 (no content in logs). fetch is a fake; nothing touches the network.
import { describe, expect, test } from 'vitest';
import { buildRequestBody, createOpenRouterProvider, OPENROUTER_URL, type AiConfig } from './openrouter.js';
import type { AiRequest } from './provider.js';

const CFG: AiConfig = {
  apiKey: 'sk-test-key',
  model: 'qwen/qwen3.8-27b',
  providers: ['tenstorrent', 'modelrun'],
  timeoutMs: 1000,
  dailyBudgetMicroUsd: 5_000_000,
};

interface Call {
  url: string;
  init: RequestInit & { body: string; headers: Record<string, string> };
}

type Responder = (init: RequestInit) => Promise<Response> | Response;

function fakeFetch(...responders: Responder[]) {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url as string, init: init as Call['init'] });
    const r = responders[Math.min(i++, responders.length - 1)];
    return r(init ?? {});
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (status: number, body: unknown) => () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const OK = {
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: 'Writing that down.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'propose_rule', arguments: '{"ingredient":"milk"}' } }],
      },
    },
  ],
  usage: { prompt_tokens: 812, completion_tokens: 31, cost: 0.00062 },
};

function setup(...responders: Responder[]) {
  const logs = recordLog();
  const log = logs;
  const { fetch, calls } = fakeFetch(...responders);
  const provider = createOpenRouterProvider(CFG, { fetch, log });
  return { provider, calls, logs };
}

/** Records every warn call as one JSON line: everything the provider hands the logger. */
function recordLog() {
  const out: string[] = [];
  return {
    warn: (...args: unknown[]) => void out.push(JSON.stringify(args)),
    lines: () => out,
    text: () => out.join('\n'),
  };
}

const HELLO: AiRequest = { messages: [{ role: 'user', content: 'hello' }], tools: [] };

describe('buildRequestBody', () => {
  test('sends exactly the pinned keys, with tools in function form', () => {
    const body = buildRequestBody(CFG, {
      messages: [{ role: 'system', content: 'You are the Pan.' }, { role: 'user', content: 'hi' }],
      tools: [{ name: 'propose_rule', description: 'Propose a rule', parameters: { type: 'object', properties: {} } }],
    });
    expect(Object.keys(body).sort()).toEqual(
      ['max_tokens', 'messages', 'model', 'provider', 'reasoning', 'stream', 'temperature', 'tool_choice', 'tools', 'usage'].sort(),
    );
    expect(body).toMatchObject({
      tools: [{ type: 'function', function: { name: 'propose_rule', description: 'Propose a rule', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
      usage: { include: true },
      stream: false,
    });
  });

  test('omits tools and tool_choice when there are no tools', () => {
    const body = buildRequestBody(CFG, HELLO);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  test('maps assistant tool calls back to the OpenAI wire shape', () => {
    const body = buildRequestBody(CFG, {
      messages: [{ role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'propose_rule', arguments: '{}' }] }],
      tools: [],
    });
    expect(body.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_rule', arguments: '{}' } }] },
    ]);
  });
});

describe('createOpenRouterProvider', () => {
  test('every request carries the pinned data policy and no identifiers', async () => {
    const { provider, calls } = setup(json(200, OK));
    await provider.complete({ messages: [{ role: 'user', content: 'hello' }], tools: [] });
    expect(calls[0].url).toBe(OPENROUTER_URL);
    expect(calls[0].init.method).toBe('POST');
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>;
    expect(body.provider).toEqual({
      only: ['tenstorrent', 'modelrun'],
      order: ['tenstorrent', 'modelrun'],
      allow_fallbacks: true,
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
    });
    expect(body).toMatchObject({ model: 'qwen/qwen3.8-27b', temperature: 0.3, max_tokens: 200, reasoning: { enabled: false } });
    for (const k of ['user', 'metadata', 'transforms']) expect(Object.keys(body)).not.toContain(k);
    expect(Object.keys(calls[0].init.headers).map((h) => h.toLowerCase()).sort()).toEqual(['authorization', 'content-type']);
    expect(calls[0].init.headers.authorization).toBe('Bearer sk-test-key');
    expect(calls[0].init.headers['content-type']).toBe('application/json');
  });

  test('exposes the configured model', () => {
    expect(setup(json(200, OK)).provider.model).toBe('qwen/qwen3.8-27b');
  });

  test('parses text, tool calls, finish and cost', async () => {
    const { provider } = setup(json(200, OK));
    const r = await provider.complete(HELLO);
    expect(r).toEqual({
      ok: true,
      text: 'Writing that down.',
      toolCalls: [{ id: 'call_1', name: 'propose_rule', arguments: '{"ingredient":"milk"}' }],
      finish: 'tool_calls',
      usage: { inputTokens: 812, outputTokens: 31, costMicroUsd: 620 },
    });
  });

  test('a plain reply: null content is empty text, missing cost is 0, unknown finish is other', async () => {
    const plain = { choices: [{ finish_reason: 'stop', message: { content: 'Morning.' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
    expect(await setup(json(200, plain)).provider.complete(HELLO)).toEqual({
      ok: true,
      text: 'Morning.',
      toolCalls: [],
      finish: 'stop',
      usage: { inputTokens: 5, outputTokens: 2, costMicroUsd: 0 },
    });
    const odd = { choices: [{ finish_reason: 'content_filter', message: { content: null } }], usage: { prompt_tokens: 5, completion_tokens: 0 } };
    expect(await setup(json(200, odd)).provider.complete(HELLO)).toMatchObject({ ok: true, text: '', finish: 'other' });
    const long = { choices: [{ finish_reason: 'length', message: { content: 'Well' } }], usage: { prompt_tokens: 5, completion_tokens: 200 } };
    expect(await setup(json(200, long)).provider.complete(HELLO)).toMatchObject({ ok: true, finish: 'length' });
  });

  test('5xx is retried once, then fails as http_5xx', async () => {
    const { provider, calls } = setup(json(502, { error: { message: 'upstream' } }));
    expect(await provider.complete(HELLO)).toEqual({ ok: false, failure: 'http_5xx', status: 502 });
    expect(calls).toHaveLength(2);
  });

  test('a 5xx then success returns the success', async () => {
    const { provider, calls } = setup(json(503, {}), json(200, OK));
    expect(await provider.complete(HELLO)).toMatchObject({ ok: true, finish: 'tool_calls' });
    expect(calls).toHaveLength(2);
  });

  test('a network error is retried once, then fails as network', async () => {
    const { provider, calls } = setup(() => Promise.reject(new TypeError('fetch failed')));
    expect(await provider.complete(HELLO)).toEqual({ ok: false, failure: 'network' });
    expect(calls).toHaveLength(2);
  });

  test('timeout fails once, without retry', async () => {
    const hang: Responder = (init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { provider, calls } = setup(hang);
    const started = Date.now();
    expect(await provider.complete(HELLO)).toEqual({ ok: false, failure: 'timeout' });
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test("the caller's abort signal also stops the call, without retry", async () => {
    const hang: Responder = (init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { provider, calls } = setup(hang);
    const ctl = new AbortController();
    const p = provider.complete({ ...HELLO, signal: ctl.signal });
    ctl.abort();
    expect(await p).toEqual({ ok: false, failure: 'timeout' });
    expect(calls).toHaveLength(1);
  });

  test('4xx and malformed JSON are not retried', async () => {
    const four = setup(json(429, { error: { message: 'rate limited' } }));
    expect(await four.provider.complete(HELLO)).toEqual({ ok: false, failure: 'http_4xx', status: 429 });
    expect(four.calls).toHaveLength(1);

    const bad = setup(json(200, 'not json {'));
    expect(await bad.provider.complete(HELLO)).toEqual({ ok: false, failure: 'invalid_response', status: 200 });
    expect(bad.calls).toHaveLength(1);

    for (const shape of [{}, { choices: [] }, { choices: [{ message: { content: 7 } }] }, { choices: [{ finish_reason: 'stop', message: { content: 'x', tool_calls: [{ id: 1 }] } }] }]) {
      const s = setup(json(200, shape));
      expect(await s.provider.complete(HELLO), JSON.stringify(shape)).toMatchObject({ ok: false, failure: 'invalid_response' });
      expect(s.calls).toHaveLength(1);
    }
  });

  test('redirects are refused, not followed: a 307 fails as network', async () => {
    // A real fetch with redirect: 'error' rejects with a TypeError on a 3xx; the fake mirrors that.
    const redirecting: Responder = (init) =>
      init.redirect === 'error'
        ? Promise.reject(new TypeError('fetch failed: redirect'))
        : new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } });
    const { provider, calls } = setup(redirecting);
    expect(await provider.complete(HELLO)).toEqual({ ok: false, failure: 'network' });
    expect(calls.every((c) => c.init.redirect === 'error')).toBe(true);
  });

  test('an error response body is cancelled unread', async () => {
    let cancelled = 0;
    const withBody = (status: number): Responder => () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status },
      );
    expect(await setup(withBody(400)).provider.complete(HELLO)).toMatchObject({ failure: 'http_4xx' });
    expect(cancelled).toBe(1);
    expect(await setup(withBody(500)).provider.complete(HELLO)).toMatchObject({ failure: 'http_5xx' });
    expect(cancelled).toBe(3);
  });

  test('a failing call logs no content even when the error body echoes the prompt', async () => {
    const { provider, logs } = setup(json(400, '{"error":{"message":"bad request: I am allergic to peanut"}}'));
    await provider.complete({ messages: [{ role: 'user', content: 'I am allergic to peanut' }], tools: [] });
    expect(logs.text()).not.toMatch(/peanut/i);
    expect(logs.text()).toMatch(/"failure":"http_4xx"/);
    expect(logs.text()).toMatch(/"ai":"openrouter"/);
    expect(logs.lines()).toHaveLength(1);
  });

  test('a network error message is never logged', async () => {
    const { provider, logs } = setup(() => Promise.reject(new Error('connect failed while sending: peanut')));
    await provider.complete({ messages: [{ role: 'user', content: 'peanut' }], tools: [] });
    expect(logs.text()).not.toMatch(/peanut/i);
    expect(logs.text()).toMatch(/"failure":"network"/);
    expect(logs.lines()).toHaveLength(1);
  });

  test('a success logs nothing', async () => {
    const { provider, logs } = setup(json(200, OK));
    await provider.complete(HELLO);
    expect(logs.lines()).toHaveLength(0);
  });

  test('never throws, even when fetch throws synchronously', async () => {
    const f = (() => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const p = createOpenRouterProvider(CFG, { fetch: f, log: { warn() {} } });
    expect(await p.complete(HELLO)).toEqual({ ok: false, failure: 'network' });
  });
});

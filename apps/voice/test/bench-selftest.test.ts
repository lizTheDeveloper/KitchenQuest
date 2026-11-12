// M7 Step 7 (P15): bench/run.ts --selftest. The whole bench loop for one utterance, against fake engines and the stub
// API (no network, no import from apps/api), yields a run parseBenchRun accepts, and writes nothing; the stub itself
// refuses what the real API refuses (an Origin, a cookie, a hello without the player's clock, a gated reply).
import { readFileSync, statSync } from 'node:fs';
import { decodeFrame, parseServerMsg, type ServerMsg } from '@kitchenquest/core';
import { describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { parseBenchRun } from '../bench/schema.js';
import { SELFTEST_TRANSCRIPT, selftest, startStubApi } from '../bench/selftest.js';

const LATEST = new URL('../bench/latest.json', import.meta.url);
const snapshot = () => {
  try {
    return { text: readFileSync(LATEST, 'utf8'), mtime: statSync(LATEST).mtimeMs };
  } catch {
    return null;
  }
};

/** The messages a voice socket gets until it closes, and its close code. */
function socket(url: string, headers: Record<string, string>, send: unknown[] = []): Promise<{ msgs: ServerMsg[]; code: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/voice`, { headers });
    const msgs: ServerMsg[] = [];
    ws.on('open', () => { for (const m of send) ws.send(JSON.stringify(m)); });
    ws.on('message', (d: Buffer, binary: boolean) => {
      if (binary) return void decodeFrame(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      const m = parseServerMsg(JSON.parse(d.toString('utf8')) as unknown);
      if (m !== null) msgs.push(m);
      if (m?.t === 'ready') ws.close(1000);
    });
    ws.on('close', (code) => resolve({ msgs, code }));
    ws.on('error', reject);
  });
}

describe('bench --selftest (P15)', () => {
  test('one utterance end to end yields a BenchRun that parseBenchRun accepts, and bench/latest.json is untouched', async () => {
    const before = snapshot();
    const run = await selftest();
    expect(parseBenchRun(run)).toEqual(run);
    expect(run.utterances).toEqual({ source: 'synthetic', n: 1, noise: ['clean'], consentRecord: null });
    expect(run.box).toBe('selftest');
    for (const k of ['firstAudio', 'replyAudio', 'stt', 'turn', 'ttsFirst'] as const) expect(run.ms[k].p50, k).toBeGreaterThanOrEqual(0);
    expect(snapshot()).toEqual(before);
  }, 60_000);

  test('the stub refuses what the real API refuses: another Origin, no cookie, a hello without localTime; a valid hello is ready', async () => {
    const api = await startStubApi();
    try {
      const hello = { t: 'hello', v: 1, conversationId: null, localDate: '2026-11-12', localTime: '18:30', familyTable: false };
      expect(await socket(api.url, { cookie: api.cookie, origin: 'https://evil.example' })).toMatchObject({ msgs: [{ t: 'closed', reason: 'bad_origin' }], code: 4403 });
      expect(await socket(api.url, { origin: api.origin })).toMatchObject({ msgs: [{ t: 'closed', reason: 'signed_out' }], code: 4401 });
      const { localTime: _t, ...noClock } = hello;
      expect(await socket(api.url, { cookie: api.cookie, origin: api.origin }, [noClock])).toMatchObject({ msgs: [{ t: 'closed', reason: 'bad_message' }], code: 4400 });
      expect(await socket(api.url, { cookie: api.cookie, origin: api.origin }, [hello])).toMatchObject({ msgs: [{ t: 'ready' }] });
      expect(api.problems).toHaveLength(3);
    } finally {
      await api.close();
    }
  });

  test('the stub\'s turn: a transcript naming a food is its heard card until the heard words are confirmed; a gated reply is never kept to speak', async () => {
    const api = await startStubApi();
    try {
      const post = async (input: unknown) => {
        const res = await fetch(`${api.url}/mentor/turn`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: api.cookie, origin: api.origin },
          body: JSON.stringify({ conversationId: null, input, localDate: '2026-11-12', localTime: '18:30', screen: null, intakeStep: null }),
        });
        return (await res.json()) as { parts: { kind: string }[]; replyId: string };
      };
      const gated = await post({ kind: 'transcript', text: SELFTEST_TRANSCRIPT });
      expect(gated.parts.map((p) => p.kind)).toEqual(['heard', 'line']);
      expect((await post({ kind: 'transcript', text: SELFTEST_TRANSCRIPT, heard: { words: ['kiwis'] } })).parts[0].kind).toBe('heard');
      const confirmed = await post({ kind: 'transcript', text: SELFTEST_TRANSCRIPT, heard: { words: ['kiwi'] } });
      expect(confirmed.parts.map((p) => p.kind)).toEqual(['line', 'line']);
      // Speaking the gated reply's lines is refused.
      const hello = { t: 'hello', v: 1, conversationId: null, localDate: '2026-11-12', localTime: '18:30', familyTable: false };
      const speak = { t: 'speak', id: 7, items: [{ kind: 'reply', replyId: gated.replyId, part: 1 }] };
      const r = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`${api.url.replace(/^http/, 'ws')}/voice`, { headers: { cookie: api.cookie, origin: api.origin } });
        ws.on('open', () => { ws.send(JSON.stringify(hello)); ws.send(JSON.stringify(speak)); });
        ws.on('close', (code) => resolve(code));
      });
      expect(r).toBe(4400);
      expect(api.problems).toEqual(['a reply the API never kept (a gated turn, or unknown)']);
    } finally {
      await api.close();
    }
  });
});

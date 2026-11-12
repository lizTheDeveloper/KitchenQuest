// M7 Step 1 (P1): the API <-> voice service protocol, and the shared scripted session both sides replay (Steps 2, 5).
import { describe, expect, test } from 'vitest';
import session from '../../test/fixtures/voice-upstream-session.json';
import { MAX_TEXT } from '../mentor/intents';
import { HINT_MAX_WORDS, MAX_SPEAK_CHARS } from './constants';
import { decodeFrame, encodeFrame } from './protocol';
import {
  parseUpstreamClientMsg,
  parseUpstreamServerMsg,
  UPSTREAM_CLOSE,
  UPSTREAM_REFUSAL,
  upstreamClose,
  upstreamRefusal,
  type UpstreamClientMsg,
  type UpstreamServerMsg,
} from './upstream';

type Entry = { from: string; msg?: unknown; frame?: { id: number; samples: number } };
const entries = session.messages as Entry[];

describe('the upstream protocol', () => {
  test("every message in fixtures/voice-upstream-session.json parses with its side's parser; a mutated copy (extra key) does not", () => {
    expect(entries.length).toBeGreaterThan(10);
    const kinds = new Set<string>();
    for (const e of entries) {
      expect(['api', 'service'], JSON.stringify(e)).toContain(e.from);
      expect((e.msg === undefined) !== (e.frame === undefined), JSON.stringify(e)).toBe(true);
      if (e.frame) {
        const buf = encodeFrame(e.frame.id, new Int16Array(e.frame.samples));
        expect(decodeFrame(buf)?.id).toBe(e.frame.id);
        continue;
      }
      const parse = e.from === 'api' ? parseUpstreamClientMsg : parseUpstreamServerMsg;
      const other = e.from === 'api' ? parseUpstreamServerMsg : parseUpstreamClientMsg;
      expect(parse(e.msg), JSON.stringify(e)).toEqual(e.msg);
      expect(parse({ ...(e.msg as object), extra: true }), JSON.stringify(e)).toBeNull();
      kinds.add(`${e.from}:${(e.msg as { t: string }).t}`);
      // `hello` exists on both sides with different shapes; everything else belongs to one side only
      if ((e.msg as { t: string }).t !== 'hello') expect(other(e.msg), JSON.stringify(e)).toBeNull();
    }
    // the session exercises every message kind of both sides
    expect([...kinds].sort()).toEqual(
      ['api:cancel', 'api:end', 'api:hello', 'api:listen', 'api:speak', 'service:audio_end', 'service:failed', 'service:ready', 'service:transcript'].sort(),
    );
  });

  test('parseUpstreamClientMsg refuses a hint over HINT_MAX_WORDS, an empty or over-long chunk, a chunk without `cache`', () => {
    const ok: UpstreamClientMsg = { t: 'speak', id: 1, voice: 'pan', chunks: [{ text: 'Hello.', cache: true }] };
    expect(parseUpstreamClientMsg(ok)).toEqual(ok);
    const bad: unknown[] = [
      { t: 'listen', id: 1, hint: Array.from({ length: HINT_MAX_WORDS + 1 }, () => 'pea') },
      { t: 'listen', id: 1, hint: [''] },
      { t: 'listen', id: 1, hint: [3] },
      { t: 'listen', id: 1 },
      { ...ok, chunks: [] },
      { ...ok, chunks: [{ text: '', cache: true }] },
      { ...ok, chunks: [{ text: 'x'.repeat(MAX_SPEAK_CHARS + 1), cache: true }] },
      { ...ok, chunks: [{ text: 'Hello.' }] },
      { ...ok, chunks: [{ text: 'Hello.', cache: true, vars: {} }] },
      { ...ok, voice: '' },
      { t: 'hello', v: 2 },
      { t: 'end', id: -3 },
    ];
    for (const m of bad) expect(parseUpstreamClientMsg(m), JSON.stringify(m)).toBeNull();
  });

  test('parseUpstreamServerMsg refuses a negative audioMs, an unknown failure kind and a ready without sampleRate', () => {
    const ok: UpstreamServerMsg = { t: 'audio_end', id: 2, audioMs: 0 };
    expect(parseUpstreamServerMsg(ok)).toEqual(ok);
    const bad: unknown[] = [
      { t: 'audio_end', id: 2, audioMs: -1 },
      { t: 'audio_end', id: 2 },
      { t: 'failed', id: 2, kind: 'upstream' },
      { t: 'ready', stt: 'a', tts: 'b' },
      { t: 'transcript', id: 1, text: 5 },
    ];
    for (const m of bad) expect(parseUpstreamServerMsg(m), JSON.stringify(m)).toBeNull();
  });

  test('fix round 1: a transcript over MAX_TEXT is refused (I2); a speak over MAX_SPEAK_CHARS in total is refused (M6)', () => {
    expect(parseUpstreamServerMsg({ t: 'transcript', id: 1, text: 'a'.repeat(MAX_TEXT) })).not.toBeNull();
    expect(parseUpstreamServerMsg({ t: 'transcript', id: 1, text: 'a'.repeat(MAX_TEXT + 1) })).toBeNull();
    const half = 'x'.repeat(MAX_SPEAK_CHARS / 2);
    expect(parseUpstreamClientMsg({ t: 'speak', id: 1, voice: 'pan', chunks: [{ text: half, cache: false }, { text: half, cache: false }] })).not.toBeNull();
    expect(parseUpstreamClientMsg({ t: 'speak', id: 1, voice: 'pan', chunks: [{ text: half, cache: false }, { text: `${half}x`, cache: false }] })).toBeNull();
  });
});

describe('the service\'s close codes and refusals (M7 Step 5, carry 1)', () => {
  test('the socket codes are 4400 bad message, 4408 idle, 1011 internal, 1001 going away; the HTTP refusals before the upgrade 401, 403, 503, 426', () => {
    expect(UPSTREAM_CLOSE).toEqual({ badMessage: 4400, idle: 4408, internal: 1011, goingAway: 1001 });
    expect(UPSTREAM_REFUSAL).toEqual({ unauthorized: 401, origin: 403, busy: 503, notWebSocket: 426 });
    expect(Object.isFrozen(UPSTREAM_CLOSE) && Object.isFrozen(UPSTREAM_REFUSAL)).toBe(true);
  });

  test('upstreamClose and upstreamRefusal name what each code means for the API; anything else is `down`', () => {
    expect(upstreamClose(4400)).toBe('bad_message');
    expect(upstreamClose(4408)).toBe('idle');
    expect(upstreamClose(1011)).toBe('down');
    expect(upstreamClose(1001)).toBe('down');
    expect(upstreamClose(1006)).toBe('down');
    expect(upstreamClose(1000)).toBe('down');
    expect(upstreamRefusal(401)).toBe('auth');
    expect(upstreamRefusal(403)).toBe('auth');
    expect(upstreamRefusal(503)).toBe('busy');
    expect(upstreamRefusal(426)).toBe('misrouted');
    expect(upstreamRefusal(500)).toBe('down');
  });
});

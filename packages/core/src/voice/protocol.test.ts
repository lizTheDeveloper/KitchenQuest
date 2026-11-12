// M7 Step 1 (P1, Ruling 15): the browser <-> API voice protocol. Parsers are strict and closed: an unknown key, a
// SpeakItem carrying text or variables, too many items or a non-integer id is refused (null), never repaired.
import { describe, expect, test } from 'vitest';
import type { ReplyPart, TurnRequest, TurnResponse } from '../mentor/protocol';
import { MAX_SPEAK_ITEMS } from './constants';
import { MAX_TEXT } from '../mentor/intents';
import { decodeFrame, encodeFrame, parseClientMsg, parseServerMsg, parseTurnInput, VOICE_PROTOCOL_VERSION, type ClientMsg, type ServerMsg, type SpeakItem } from './protocol';

describe('audio frames', () => {
  test('encodeFrame/decodeFrame round-trip id and samples; < 4 bytes and odd PCM length → null', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const buf = encodeFrame(0xdeadbeef, pcm);
    expect(buf.byteLength).toBe(4 + pcm.length * 2);
    // u32 big-endian id, then PCM16 little-endian
    expect([...buf.slice(0, 4)]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([...buf.slice(4, 8)]).toEqual([0, 0, 1, 0]);
    const out = decodeFrame(buf)!;
    expect(out.id).toBe(0xdeadbeef);
    expect([...out.pcm]).toEqual([...pcm]);
    expect(decodeFrame(encodeFrame(7, new Int16Array(0)))).toEqual({ id: 7, pcm: new Int16Array(0) });
    expect(decodeFrame(new Uint8Array(3))).toBeNull();
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
    expect(decodeFrame(new Uint8Array(4 + 3))).toBeNull();
    // a view into a larger buffer at an odd offset still decodes
    const big = new Uint8Array(1 + buf.byteLength);
    big.set(buf, 1);
    expect([...decodeFrame(big.subarray(1))!.pcm]).toEqual([...pcm]);
  });

  test('encodeFrame refuses an id that is no u32', () => {
    for (const id of [-1, 1.5, 2 ** 32, Number.NaN]) expect(() => encodeFrame(id, new Int16Array(1)), String(id)).toThrow();
  });
});

const HELLO: ClientMsg = { t: 'hello', v: 1, conversationId: null, localDate: '2026-11-12', familyTable: false };
const ITEMS: SpeakItem[] = [
  { kind: 'line', trigger: 'voice.check_screen', index: 0 },
  { kind: 'reply', replyId: '4f1c2a8e-8a8b-4c39-9d3c-0d6a3c1e2b7f', part: 1 },
  { kind: 'card', proposalId: 'p-123' },
  { kind: 'heard', utteranceId: 3 },
  { kind: 'step', slug: 'india/kerala/parippu', step: 0, localDate: '2026-11-12' },
];

describe('parseClientMsg', () => {
  test('accepts every well-formed message', () => {
    expect(VOICE_PROTOCOL_VERSION).toBe(1);
    const good: ClientMsg[] = [
      HELLO,
      { ...HELLO, conversationId: 'c-1', familyTable: true },
      { t: 'listen', id: 1, mode: 'hold' },
      { t: 'listen', id: 2, mode: 'handsFree' },
      { t: 'end', id: 1 },
      { t: 'cancel', id: 0 },
      { t: 'speak', id: 9, items: ITEMS },
    ];
    for (const m of good) expect(parseClientMsg(JSON.parse(JSON.stringify(m))), JSON.stringify(m)).toEqual(m);
  });

  test('parseClientMsg rejects extra keys, any `text` or `vars` key on a SpeakItem, > MAX_SPEAK_ITEMS items, a non-integer id, a hello without familyTable', () => {
    const bad: unknown[] = [
      { ...HELLO, extra: 1 },
      { t: 'listen', id: 1, mode: 'hold', text: 'hi' },
      ...ITEMS.map((item) => ({ t: 'speak', id: 1, items: [{ ...item, text: 'say this' }] })),
      ...ITEMS.map((item) => ({ t: 'speak', id: 1, items: [{ ...item, vars: { name: 'x' } }] })),
      { t: 'speak', id: 1, items: Array.from({ length: MAX_SPEAK_ITEMS + 1 }, () => ITEMS[0]) },
      { t: 'speak', id: 1, items: [] },
      { t: 'listen', id: 1.5, mode: 'hold' },
      { t: 'end', id: -1 },
      { t: 'end', id: 2 ** 32 },
      { t: 'end', id: '1' },
      { t: 'hello', v: 1, conversationId: null, localDate: '2026-11-12' },
      { ...HELLO, familyTable: 'false' },
      { ...HELLO, v: 2 },
      { ...HELLO, localDate: '2026-13-40' },
      { ...HELLO, conversationId: 7 },
      { t: 'listen', id: 1, mode: 'always' },
      { t: 'speak', id: 1, items: [{ kind: 'line', trigger: 'voice.check_screen', index: -1 }] },
      { t: 'speak', id: 1, items: [{ kind: 'line', trigger: 'Say anything I like', index: 0 }] },
      { t: 'speak', id: 1, items: [{ kind: 'step', slug: 'india/kerala/parippu', step: 0.5, localDate: '2026-11-12' }] },
      { t: 'speak', id: 1, items: [{ kind: 'step', slug: 'india/kerala/parippu', step: 0 }] },
      { t: 'speak', id: 1, items: [{ kind: 'text', text: 'hello' }] },
      { t: 'speak', id: 1, items: 'line' },
      { t: 'shout', id: 1 },
      { t: 'end' },
      null,
      'hello',
      [HELLO],
      Object.assign(Object.create({ inherited: 1 }), { t: 'end', id: 1 }) as unknown,
    ];
    for (const m of bad) expect(parseClientMsg(m), JSON.stringify(m)).toBeNull();
    // a SpeakItem type carries no text or vars, at compile time too
    // @ts-expect-error: no `text` on a SpeakItem (Ruling 15)
    const typed: SpeakItem = { kind: 'line', trigger: 'voice.check_screen', index: 0, text: 'x' };
    expect(parseClientMsg({ t: 'speak', id: 1, items: [typed] })).toBeNull();
  });

  test('a parsed message is a fresh copy: changing the input afterwards changes nothing', () => {
    const raw = { t: 'speak', id: 1, items: [{ kind: 'line', trigger: 'voice.check_screen', index: 0 }] };
    const out = parseClientMsg(raw)!;
    raw.items[0].index = 5;
    expect(out).toEqual({ t: 'speak', id: 1, items: [{ kind: 'line', trigger: 'voice.check_screen', index: 0 }] });
  });
});

describe('parseServerMsg', () => {
  test('accepts every well-formed message and refuses extra keys, unknown kinds and reasons', () => {
    const good: ServerMsg[] = [
      { t: 'ready', state: { kind: 'available' } },
      { t: 'state', state: { kind: 'resting', until: '2026-12-01' } },
      { t: 'state', state: { kind: 'resting_today' } },
      { t: 'transcript', id: 1, text: 'next step' },
      { t: 'transcript', id: 1, text: '' },
      { t: 'too_long', id: 1 },
      { t: 'audio_start', id: 2, sampleRate: 22050 },
      { t: 'audio_end', id: 2 },
      { t: 'failed', id: 2, kind: 'tts' },
      ...(['signed_out', 'bad_origin', 'consent_required', 'child', 'family_table', 'unavailable', 'another_tab', 'bad_message'] as const).map(
        (reason): ServerMsg => ({ t: 'closed', reason }),
      ),
    ];
    for (const m of good) expect(parseServerMsg(JSON.parse(JSON.stringify(m))), JSON.stringify(m)).toEqual(m);
    const bad: unknown[] = [
      { t: 'ready', state: { kind: 'available' }, seconds: 3600 },
      { t: 'state', state: { kind: 'available', remaining: 10 } },
      { t: 'state', state: { kind: 'resting', until: 'tomorrow' } },
      { t: 'state', state: { kind: 'resting' } },
      { t: 'transcript', id: 1 },
      { t: 'audio_start', id: 2, sampleRate: 0 },
      { t: 'failed', id: 2, kind: 'model' },
      { t: 'closed', reason: 'bored' },
      { t: 'closed' },
      {},
    ];
    for (const m of bad) expect(parseServerMsg(m), JSON.stringify(m)).toBeNull();
  });
});

describe('the mentor protocol carries voice (M7)', () => {
  test('a turn input is text or a transcript with optional heard words; a reply part may be a heard card; a response has a replyId', () => {
    const text: TurnRequest['input'] = { kind: 'text', text: 'hi' };
    const spoken: TurnRequest['input'] = { kind: 'transcript', text: 'allergic to selfish', heard: { words: ['selfish'] } };
    const bare: TurnRequest['input'] = { kind: 'transcript', text: 'next step' };
    // @ts-expect-error: heard words travel only with a transcript
    const wrong: TurnRequest['input'] = { kind: 'text', text: 'hi', heard: { words: [] } };
    const part: ReplyPart = { kind: 'heard', check: { tooLong: false, terms: [{ heard: 'selfish', spelled: 'S-E-L-F-I-S-H', id: null, at: [2], alternatives: [] }], speakSpelling: true } };
    // @ts-expect-error: every response carries a replyId (M7, Ruling 15)
    const noId: TurnResponse = { conversationId: null, route: 'scripted', parts: [], cards: [], actions: [], notice: null, toolTurn: false };
    const withId: TurnResponse = { ...noId, replyId: 'r-1' };
    expect([text.kind, spoken.kind, bare.kind, wrong.kind, part.kind, withId.replyId]).toEqual(['text', 'transcript', 'transcript', 'text', 'heard', 'r-1']);
  });
});

describe('fix round 1: transcripts are bounded, never truncated (I2)', () => {
  test('parseServerMsg refuses a transcript over MAX_TEXT code points and keeps one at MAX_TEXT whole', () => {
    const at = 'é'.repeat(MAX_TEXT);
    expect(parseServerMsg({ t: 'transcript', id: 1, text: at })).toEqual({ t: 'transcript', id: 1, text: at });
    expect(parseServerMsg({ t: 'transcript', id: 1, text: `${at}x` })).toBeNull();
    expect(parseServerMsg({ t: 'transcript', id: 1, text: 'x'.repeat(100_000) })).toBeNull();
  });

  test('parseTurnInput: text or transcript, strict, at most MAX_TEXT, heard words bounded; over-long is refused', () => {
    expect(parseTurnInput({ kind: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' });
    expect(parseTurnInput({ kind: 'transcript', text: 'allergic to selfish' })).toEqual({ kind: 'transcript', text: 'allergic to selfish' });
    const heard = { kind: 'transcript', text: 'allergic to selfish', heard: { words: ['selfish'] } };
    expect(parseTurnInput(heard)).toEqual(heard);
    const bad: unknown[] = [
      { kind: 'transcript', text: 'x'.repeat(MAX_TEXT + 1) },
      { kind: 'text', text: 'x'.repeat(MAX_TEXT + 1) },
      { kind: 'transcript', text: '' },
      { kind: 'transcript', text: '   ' },
      // fix round 2 (N6): blank once whitespace and zero-width characters are trimmed
      { kind: 'text', text: String.fromCharCode(0x200b) },
      { kind: 'transcript', text: ` ${String.fromCharCode(0x200b, 0x2060, 0xfeff)} ` },
      { kind: 'transcript', text: 'a', heard: { words: [String.fromCharCode(0x200b)] } },
      { kind: 'text', text: 'hi', heard: { words: [] } },
      { kind: 'transcript', text: 'a', heard: { words: ['x'.repeat(MAX_TEXT + 1)] } },
      { kind: 'transcript', text: 'a', heard: { words: Array.from({ length: MAX_TEXT + 1 }, () => 'a') } },
      { kind: 'transcript', text: 'a', heard: { words: [3] } },
      { kind: 'transcript', text: 'a', heard: { words: ['a'], extra: 1 } },
      { kind: 'transcript', text: 'a', extra: 1 },
      { kind: 'voice', text: 'a' },
      null,
    ];
    for (const b of bad) expect(parseTurnInput(b), JSON.stringify(b).slice(0, 80)).toBeNull();
  });
});

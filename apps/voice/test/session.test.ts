// M7 Step 2: one Session per API connection, with fake engines (no model, no GPU). P1: upstream protocol; P2: the
// service speaks each chunk verbatim; C-18: the utterance buffer is zeroed and released whenever an utterance ends.
import { decodeFrame, encodeFrame, HINT_MAX_WORDS, MAX_UTTERANCE_MS, SAMPLE_RATE_IN, type UpstreamServerMsg } from '@kitchenquest/core';
import { describe, expect, test } from 'vitest';
import { fakeStt, fakeTts } from '../src/engines/fake';
import type { SttEngine, TtsEngine } from '../src/engines/types';
import { Session, SpeechCache } from '../src/session';

const CAST = { model: 'piper-en_GB-northern_english_male-medium', voice: 'northern_english_male' };
const MAX_SAMPLES = (MAX_UTTERANCE_MS * SAMPLE_RATE_IN) / 1000;

function harness(opts: { stt?: SttEngine; tts?: TtsEngine; cache?: SpeechCache; congestedAfter?: number } = {}) {
  const sent: UpstreamServerMsg[] = [];
  const frames: { id: number; pcm: Int16Array }[] = [];
  const closed: number[] = [];
  const buffers: Int16Array[] = [];
  const session = new Session({
    stt: opts.stt ?? fakeStt((pcm) => `heard ${pcm.length}`),
    tts: opts.tts ?? fakeTts(),
    cast: CAST,
    cache: opts.cache ?? new SpeechCache(),
    log: () => {},
    io: {
      json: (m) => sent.push(m),
      // false = the socket is congested (backpressure); the session must stop sending.
      frame: (b) => frames.push(decodeFrame(b)!) < (opts.congestedAfter ?? Infinity),
      close: (code) => closed.push(code),
    },
    alloc: (n) => {
      const b = new Int16Array(n);
      buffers.push(b);
      return b;
    },
  });
  const msg = (m: object) => session.receive(JSON.stringify(m), false);
  const frame = (id: number, samples: number, value = 1) => session.receive(encodeFrame(id, new Int16Array(samples).fill(value)), true);
  msg({ t: 'hello', v: 1 });
  return { session, sent, frames, closed, buffers, msg, frame };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const allZero = (b: Int16Array) => b.every((s) => s === 0);

describe('Session: listening', () => {
  test('listen → frames → end gives one transcript; frames for another id are dropped; past MAX_UTTERANCE_MS the utterance ends with what came', async () => {
    const lengths: number[] = [];
    const h = harness({ stt: fakeStt((pcm) => (lengths.push(pcm.length), `heard ${pcm.length}`)) });
    expect(h.sent[0]).toEqual({ t: 'ready', stt: 'fake-stt', tts: 'fake-tts', sampleRate: 22_050 });

    h.msg({ t: 'listen', id: 1, hint: [] });
    h.frame(1, 320);
    h.frame(99, 320); // another id: dropped
    h.frame(1, 320);
    h.msg({ t: 'end', id: 1 });
    await h.session.idle();
    expect(h.sent.slice(1)).toEqual([{ t: 'transcript', id: 1, text: 'heard 640' }]);
    h.msg({ t: 'end', id: 1 }); // a second end: nothing
    await h.session.idle();
    expect(h.sent).toHaveLength(2);

    // Past MAX_UTTERANCE_MS: the utterance ends itself with exactly MAX_SAMPLES samples; later frames and end do nothing.
    h.msg({ t: 'listen', id: 2, hint: [] });
    for (let i = 0; i < MAX_SAMPLES / 320 + 5; i++) h.frame(2, 320);
    await h.session.idle();
    expect(h.sent.at(-1)).toEqual({ t: 'transcript', id: 2, text: `heard ${MAX_SAMPLES}` });
    h.msg({ t: 'end', id: 2 });
    await h.session.idle();
    expect(h.sent).toHaveLength(3);
    expect(lengths).toEqual([640, MAX_SAMPLES]);
    // A frame that straddles the limit is cut at it, not dropped whole.
    h.msg({ t: 'listen', id: 3, hint: [] });
    for (let i = 0; i < MAX_SAMPLES / 1000; i++) h.frame(3, 999);
    h.frame(3, 2000);
    await h.session.idle();
    expect(lengths.at(-1)).toBe(MAX_SAMPLES);

    // An end with no audio is a failed stt, without calling the engine; so is a blank transcript.
    h.msg({ t: 'listen', id: 4, hint: [] });
    h.msg({ t: 'end', id: 4 });
    await h.session.idle();
    expect(h.sent.at(-1)).toEqual({ t: 'failed', id: 4, kind: 'stt' });
    expect(lengths).toHaveLength(3);
    const blank = harness({ stt: fakeStt(() => '  \n ') });
    blank.msg({ t: 'listen', id: 1, hint: [] });
    blank.frame(1, 320);
    blank.msg({ t: 'end', id: 1 });
    await blank.session.idle();
    expect(blank.sent.at(-1)).toEqual({ t: 'failed', id: 1, kind: 'stt' });
  });

  test('the hint is capped at HINT_MAX_WORDS and passed to transcribe, and is gone from the session after end', async () => {
    const seen: string[][] = [];
    const refs: (readonly string[])[] = [];
    const stt: SttEngine = {
      model: 'hint-stt',
      transcribe: (_pcm, hint) => {
        seen.push([...hint]);
        refs.push(hint);
        return Promise.resolve('ok');
      },
    };
    const h = harness({ stt });
    const hint = Array.from({ length: HINT_MAX_WORDS }, (_, i) => `word${i}`);
    h.msg({ t: 'listen', id: 1, hint });
    expect(h.session.inspect()).toMatchObject({ utterance: 1, hintWords: HINT_MAX_WORDS });
    h.frame(1, 320);
    h.msg({ t: 'end', id: 1 });
    await h.session.idle();
    expect(seen).toEqual([hint]);
    expect(refs[0]).toHaveLength(0); // the session's own copy is emptied once transcribe settles
    expect(h.session.inspect()).toEqual({ utterance: null, hintWords: 0, bufferedSamples: 0, speech: null });

    // Over HINT_MAX_WORDS is not a valid listen at all (core parser): bad_message, the socket is closed.
    h.msg({ t: 'listen', id: 2, hint: [...hint, 'one-more'] });
    expect(h.closed).toEqual([4400]);
  });

  test('the utterance buffer is zero-filled and released after end, cancel and close', async () => {
    const h = harness();
    // end
    h.msg({ t: 'listen', id: 1, hint: ['a'] });
    h.frame(1, 320, 0x4b51);
    expect(allZero(h.buffers[0])).toBe(false);
    expect(h.buffers[0].length).toBe(MAX_SAMPLES);
    h.msg({ t: 'end', id: 1 });
    await h.session.idle();
    expect(allZero(h.buffers[0])).toBe(true);
    // cancel
    h.msg({ t: 'listen', id: 2, hint: [] });
    h.frame(2, 320, 0x4b51);
    h.msg({ t: 'cancel', id: 2 });
    expect(allZero(h.buffers[1])).toBe(true);
    expect(h.session.inspect()).toEqual({ utterance: null, hintWords: 0, bufferedSamples: 0, speech: null });
    await h.session.idle();
    expect(h.sent).toHaveLength(2); // ready, transcript 1; nothing for the cancelled one
    // a new listen replaces an open one, releasing it, and answers it (fix round 3: no utterance goes unanswered)
    h.msg({ t: 'listen', id: 3, hint: [] });
    h.frame(3, 320, 0x4b51);
    h.msg({ t: 'listen', id: 4, hint: [] });
    expect(allZero(h.buffers[2])).toBe(true);
    expect(h.sent.at(-1)).toEqual({ t: 'failed', id: 3, kind: 'stt' });
    // close mid-utterance
    h.frame(4, 320, 0x4b51);
    expect(h.session.inspect().bufferedSamples).toBe(320);
    h.session.close();
    expect(allZero(h.buffers[3])).toBe(true);
    expect(h.session.inspect()).toEqual({ utterance: null, hintWords: 0, bufferedSamples: 0, speech: null });

    // close while transcribing: the buffer is zeroed once the engine lets go, and nothing is sent after close.
    let release!: (s: string) => void;
    const slow: SttEngine = { model: 's', transcribe: () => new Promise<string>((r) => (release = r)) };
    const t = harness({ stt: slow });
    t.msg({ t: 'listen', id: 1, hint: [] });
    t.frame(1, 320, 0x4b51);
    t.msg({ t: 'end', id: 1 });
    await until(() => typeof release === 'function'); // the engine has the buffer
    t.session.close();
    release('late words');
    await t.session.idle();
    expect(allZero(t.buffers[0])).toBe(true);
    expect(t.sent).toHaveLength(1);
  });

  test('a throwing STT engine sends failed stt and logs engine_error with numbers only; messages before hello are bad', async () => {
    const make = () => {
      const logs: [string, unknown][] = [];
      const sent: UpstreamServerMsg[] = [];
      const closed: number[] = [];
      const session = new Session({
        stt: { model: 'x', transcribe: () => Promise.reject(new Error('boom zebrapeanut71')) },
        tts: fakeTts(),
        cast: CAST,
        cache: new SpeechCache(),
        log: (kind, fields) => logs.push([kind, fields]),
        io: { json: (m) => sent.push(m), frame: () => true, close: (c) => closed.push(c) },
      });
      return { logs, sent, closed, session };
    };
    // Before hello: a listen and a frame are each bad_message, and the session is closed and ignores the rest.
    for (const first of [[JSON.stringify({ t: 'listen', id: 1, hint: [] }), false], [encodeFrame(1, new Int16Array(4)), true]] as const) {
      const early = make();
      early.session.receive(first[0], first[1]);
      early.session.receive(JSON.stringify({ t: 'hello', v: 1 }), false);
      expect(early.closed).toEqual([4400]);
      expect(early.logs).toEqual([['bad_message', undefined]]);
      expect(early.sent).toEqual([]);
    }
    const { logs, sent, closed, session } = make();
    session.receive(JSON.stringify({ t: 'hello', v: 1 }), false);
    session.receive(JSON.stringify({ t: 'listen', id: 1, hint: [] }), false);
    session.receive(encodeFrame(1, new Int16Array(320)), true);
    session.receive(JSON.stringify({ t: 'end', id: 1 }), false);
    await session.idle();
    expect(sent.at(-1)).toEqual({ t: 'failed', id: 1, kind: 'stt' });
    expect(logs).toEqual([['engine_error', { stt: true }]]);
    expect(JSON.stringify(logs)).not.toContain('zebrapeanut71');
    // A second hello is bad too.
    session.receive(JSON.stringify({ t: 'hello', v: 1 }), false);
    expect(closed).toEqual([4400]);
  });
});

describe('Session: speaking', () => {
  test("speak synthesises each chunk's text exactly as sent (verbatim, P2); cancel mid-chunk stops frames and sends no audio_end", async () => {
    const texts: [string, string][] = [];
    const base = fakeTts();
    const tts: TtsEngine = {
      model: base.model,
      sampleRate: base.sampleRate,
      synthesize: (text, voice, signal) => (texts.push([text, voice]), base.synthesize(text, voice, signal)),
    };
    const h = harness({ tts });
    const chunks = [
      { text: '  Kiwi,  K-I-W-I.  ', cache: false },
      { text: "It's on the screen; read it there.", cache: false },
      { text: '<b>not markup</b> & 3/4 cup', cache: false },
    ];
    h.msg({ t: 'speak', id: 7, voice: 'pan', chunks });
    await h.session.idle();
    expect(texts).toEqual(chunks.map((c) => [c.text, 'northern_english_male']));
    const end = h.sent.at(-1)!;
    expect(end.t).toBe('audio_end');
    // 50 ms of sine per word (fakeTts); frames are FRAME_MS (20 ms) at the engine's rate: 441 samples at 22 050 Hz.
    const samples = h.frames.reduce((n, f) => n + f.pcm.length, 0);
    expect(h.frames.every((f) => f.id === 7)).toBe(true);
    expect(h.frames.slice(0, -1).every((f) => f.pcm.length === 441)).toBe(true);
    expect(end).toEqual({ t: 'audio_end', id: 7, audioMs: Math.round((samples * 1000) / 22_050) });

    // An unknown voice role is a failed tts, never a guess.
    h.msg({ t: 'speak', id: 8, voice: 'cook_maria', chunks: [{ text: 'hi', cache: false }] });
    await h.session.idle();
    expect(h.sent.at(-1)).toEqual({ t: 'failed', id: 8, kind: 'tts' });

    // Cancel mid-chunk: after the cancel no further frame for that id, and no audio_end.
    h.frames.length = 0;
    const before = h.sent.length;
    h.msg({ t: 'speak', id: 9, voice: 'pan', chunks: [{ text: Array.from({ length: 80 }, () => 'word').join(' '), cache: false }] });
    await until(() => h.frames.length >= 2);
    h.msg({ t: 'cancel', id: 9 });
    const atCancel = h.frames.length;
    await h.session.idle();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.frames.length).toBe(atCancel);
    expect(h.sent.length).toBe(before);
    expect(h.session.inspect().speech).toBeNull();

    // A new speak replaces one in flight: the old one gets no audio_end.
    h.msg({ t: 'speak', id: 10, voice: 'pan', chunks: [{ text: Array.from({ length: 80 }, () => 'word').join(' '), cache: false }] });
    await until(() => h.frames.some((f) => f.id === 10));
    h.msg({ t: 'speak', id: 11, voice: 'pan', chunks: [{ text: 'short', cache: false }] });
    await h.session.idle();
    expect(h.sent.slice(before).map((m) => m.t === 'audio_end' && m.id)).toEqual([11]);
  });

  test('cache is per chunk: cache:true chunks synthesise once per (voice, text); cache:false chunks never enter the cache', async () => {
    const calls: string[] = [];
    const base = fakeTts();
    const tts: TtsEngine = { model: 'counting', sampleRate: base.sampleRate, synthesize: (t, v, s) => (calls.push(t), base.synthesize(t, v, s)) };
    const cache = new SpeechCache();
    const h = harness({ tts, cache });
    const speak = (id: number, chunks: { text: string; cache: boolean }[]) => h.msg({ t: 'speak', id, voice: 'pan', chunks });
    speak(1, [{ text: 'One moment.', cache: true }, { text: 'Kiwi, K-I-W-I.', cache: false }]);
    await h.session.idle();
    const firstAudio = h.frames.filter((f) => f.id === 1).flatMap((f) => [...f.pcm]);
    speak(2, [{ text: 'One moment.', cache: true }, { text: 'Kiwi, K-I-W-I.', cache: false }]);
    await h.session.idle();
    expect(calls).toEqual(['One moment.', 'Kiwi, K-I-W-I.', 'Kiwi, K-I-W-I.']);
    expect(cache.size).toBe(1);
    expect(cache.has('northern_english_male', 'One moment.')).toBe(true);
    expect(cache.has('northern_english_male', 'Kiwi, K-I-W-I.')).toBe(false);
    // The cached replay sounds the same as the first synthesis.
    expect(h.frames.filter((f) => f.id === 2).flatMap((f) => [...f.pcm])).toEqual(firstAudio);
    expect(h.sent.filter((m) => m.t === 'audio_end')).toEqual([
      { t: 'audio_end', id: 1, audioMs: expect.any(Number) },
      { t: 'audio_end', id: 2, audioMs: expect.any(Number) },
    ]);

    // A cancelled cache:true chunk is never cached half-done.
    speak(3, [{ text: Array.from({ length: 80 }, () => 'long').join(' '), cache: true }]);
    await until(() => h.frames.some((f) => f.id === 3));
    h.msg({ t: 'cancel', id: 3 });
    await h.session.idle();
    expect(cache.size).toBe(1);

    // The cache is bounded: the oldest entry goes first.
    const small = new SpeechCache(2);
    small.set('v', 'a', new Int16Array(1));
    small.set('v', 'b', new Int16Array(1));
    small.set('v', 'c', new Int16Array(1));
    expect([small.has('v', 'a'), small.has('v', 'b'), small.has('v', 'c')]).toEqual([false, true, true]);
  });

  test('a throwing TTS engine sends failed tts with no audio_end; the session keeps working', async () => {
    const base = fakeTts();
    const tts: TtsEngine = {
      model: 'flaky',
      sampleRate: base.sampleRate,
      synthesize: async function* (text) {
        if (text === 'bad') throw new Error('tts failed on quagga-lentil-42');
        yield new Int16Array(441);
      },
    };
    const h = harness({ tts });
    h.msg({ t: 'speak', id: 1, voice: 'pan', chunks: [{ text: 'bad', cache: false }] });
    await h.session.idle();
    expect(h.sent.at(-1)).toEqual({ t: 'failed', id: 1, kind: 'tts' });
    h.msg({ t: 'speak', id: 2, voice: 'pan', chunks: [{ text: 'good', cache: false }] });
    await h.session.idle();
    expect(h.sent.at(-1)).toEqual({ t: 'audio_end', id: 2, audioMs: 20 });
  });
});

describe('Session: fix round 1 (review I1, M2)', () => {
  test('I1: a synchronously throwing STT engine gives failed stt and engine_error (no message); receive never throws, and the session keeps working', async () => {
    const logs: [string, unknown][] = [];
    const sent: UpstreamServerMsg[] = [];
    let calls = 0;
    const stt: SttEngine = {
      model: 'sync-thrower',
      transcribe: (pcm) => {
        if (calls++ === 0) throw new Error(`sync crash zebrapeanut71 ${Buffer.from(pcm.buffer, pcm.byteOffset, 16).toString('hex')}`);
        return Promise.resolve('second time lucky');
      },
    };
    const session = new Session({ stt, tts: fakeTts(), cast: CAST, cache: new SpeechCache(), log: (k, f) => logs.push([k, f]), io: { json: (m) => sent.push(m), frame: () => true, close: () => {} } });
    session.receive(JSON.stringify({ t: 'hello', v: 1 }), false);
    for (const id of [1, 2]) {
      session.receive(JSON.stringify({ t: 'listen', id, hint: [] }), false);
      session.receive(encodeFrame(id, new Int16Array(320).fill(0x4b51)), true);
      expect(() => session.receive(JSON.stringify({ t: 'end', id }), false)).not.toThrow();
      await session.idle();
    }
    expect(sent.slice(1)).toEqual([
      { t: 'failed', id: 1, kind: 'stt' },
      { t: 'transcript', id: 2, text: 'second time lucky' },
    ]);
    expect(logs[0]).toEqual(['engine_error', { stt: true }]);
    expect(JSON.stringify(logs)).not.toMatch(/zebrapeanut71|514b/);
  });

  test('I1: a TTS engine whose synthesize throws synchronously gives failed tts; receive never throws', async () => {
    const tts: TtsEngine = {
      model: 't',
      sampleRate: 22_050,
      synthesize: () => {
        throw new Error('sync tts crash quagga-lentil-42');
      },
    };
    const h = harness({ tts });
    expect(() => h.msg({ t: 'speak', id: 1, voice: 'pan', chunks: [{ text: 'hi', cache: false }] })).not.toThrow();
    await h.session.idle();
    expect(h.sent.at(-1)).toEqual({ t: 'failed', id: 1, kind: 'tts' });
  });

  test('M2 / N1: at most one transcription in flight and at most one waiting: while an engine ignores the abort, each newer utterance replaces the waiting one, which gets failed stt', async () => {
    let calls = 0;
    const stuck: SttEngine = { model: 'stuck', transcribe: () => (calls++, new Promise<string>(() => {})) };
    const h = harness({ stt: stuck });
    for (let id = 1; id <= 5; id++) {
      h.msg({ t: 'listen', id, hint: [] });
      h.frame(id, 320, 0x4b51);
      h.msg({ t: 'end', id });
      if (id === 1) await until(() => calls === 1);
    }
    expect(calls).toBe(1);
    // 1 was aborted by listen 2 while transcribing; 2, 3 and 4 each waited and were replaced; 5 waits. Each replaced
    // one is answered failed stt (fix round 3).
    expect(h.sent.slice(1)).toEqual([1, 2, 3, 4].map((id) => ({ t: 'failed', id, kind: 'stt' })));
    expect(h.session.inspect()).toMatchObject({ utterance: 5, bufferedSamples: 320 });
    // Only the waiting utterance still holds audio; 1 was zeroed when replaced, 2-4 when they failed.
    expect(h.buffers.map(allZero)).toEqual([true, true, true, true, false]);
  });

  test("N1 (the reviewer's 800 ms probe): a new utterance that ends while an aborted call is still running waits for it, then is transcribed; no failed", async () => {
    const calls: number[] = [];
    // 800 ms per call, and the abort is noticed only when the call finishes, as an uninterruptible decode would.
    const slow: SttEngine = {
      model: 'slow',
      transcribe: (pcm, _hint, signal) =>
        new Promise((resolve, reject) => {
          calls.push(pcm.length);
          setTimeout(() => (signal.aborted ? reject(new Error('aborted')) : resolve(`heard ${pcm.length}`)), 800);
        }),
    };
    const h = harness({ stt: slow });
    h.msg({ t: 'listen', id: 1, hint: [] });
    h.frame(1, 320);
    h.msg({ t: 'end', id: 1 });
    await new Promise((r) => setTimeout(r, 100));
    h.msg({ t: 'listen', id: 2, hint: [] });
    for (let i = 0; i < 20; i++) {
      h.frame(2, 320);
      await new Promise((r) => setTimeout(r, 20));
    }
    h.msg({ t: 'end', id: 2 });
    await until(() => h.sent.length > 1, 3000);
    await h.session.idle();
    // 1 was replaced while transcribing: answered failed at once, and nothing more when its call later settles.
    expect(h.sent.slice(1)).toEqual([
      { t: 'failed', id: 1, kind: 'stt' },
      { t: 'transcript', id: 2, text: 'heard 6400' },
    ]);
    expect(calls).toEqual([320, 6400]);
    expect(h.buffers.every(allZero)).toBe(true);
    expect(h.session.inspect()).toEqual({ utterance: null, hintWords: 0, bufferedSamples: 0, speech: null });
  });

  test('N1: a waiting utterance can be cancelled (no reply) and is zeroed on close', async () => {
    const stuck: SttEngine = { model: 'stuck', transcribe: () => new Promise<string>(() => {}) };
    const h = harness({ stt: stuck });
    h.msg({ t: 'listen', id: 1, hint: [] });
    h.frame(1, 320);
    h.msg({ t: 'end', id: 1 });
    await new Promise((r) => setTimeout(r, 5));
    for (const id of [2, 3]) {
      h.msg({ t: 'listen', id, hint: [] });
      h.frame(id, 320, 0x4b51);
      h.msg({ t: 'end', id });
    }
    expect(h.sent.slice(1)).toEqual([
      { t: 'failed', id: 1, kind: 'stt' },
      { t: 'failed', id: 2, kind: 'stt' },
    ]);
    h.msg({ t: 'cancel', id: 3 });
    expect(allZero(h.buffers[2])).toBe(true);
    expect(h.sent).toHaveLength(3);
    h.msg({ t: 'listen', id: 4, hint: [] });
    h.frame(4, 320, 0x4b51);
    h.msg({ t: 'end', id: 4 });
    h.session.close();
    expect(h.buffers.every(allZero)).toBe(true);
  });

  test('M2: backpressure: when the socket is congested the speech stops, with failed tts and no audio_end', async () => {
    const h = harness({ congestedAfter: 3 });
    h.msg({ t: 'speak', id: 1, voice: 'pan', chunks: [{ text: Array.from({ length: 40 }, () => 'word').join(' '), cache: false }] });
    await h.session.idle();
    expect(h.frames).toHaveLength(3);
    expect(h.sent.slice(1)).toEqual([{ t: 'failed', id: 1, kind: 'tts' }]);
    expect(h.session.inspect().speech).toBeNull();
  });

  test('M7: a frame after close or before hello is zeroed too', () => {
    const early = new Session({ stt: fakeStt(() => 'x'), tts: fakeTts(), cast: CAST, cache: new SpeechCache(), log: () => {}, io: { json: () => {}, frame: () => true, close: () => {} } });
    const raw = encodeFrame(1, new Int16Array(8).fill(0x4b51));
    early.receive(raw, true);
    expect(raw.every((b) => b === 0)).toBe(true);
    const h = harness();
    h.session.close();
    const late = encodeFrame(1, new Int16Array(8).fill(0x4b51));
    h.session.receive(late, true);
    expect(late.every((b) => b === 0)).toBe(true);
  });
});

describe('Session: fix round 3 (N1 ruling): no utterance goes unanswered', () => {
  test('an utterance replaced while being transcribed is answered failed stt at once, and its late result is never sent', async () => {
    let finish!: (s: string) => void;
    const slow: SttEngine = { model: 'slow', transcribe: () => new Promise<string>((r) => (finish = r)) };
    const h = harness({ stt: slow });
    h.msg({ t: 'listen', id: 1, hint: [] });
    h.frame(1, 320);
    h.msg({ t: 'end', id: 1 });
    await until(() => typeof finish === 'function');
    h.msg({ t: 'listen', id: 2, hint: [] });
    expect(h.sent.slice(1)).toEqual([{ t: 'failed', id: 1, kind: 'stt' }]);
    finish('late words');
    await h.session.idle();
    expect(h.sent.slice(1)).toEqual([{ t: 'failed', id: 1, kind: 'stt' }]);
  });

  test('an utterance replaced while still listening is answered failed stt; cancel and close stay silent (the API asked, or is gone)', async () => {
    const h = harness();
    h.msg({ t: 'listen', id: 1, hint: [] });
    h.frame(1, 320);
    h.msg({ t: 'listen', id: 2, hint: [] });
    expect(h.sent.slice(1)).toEqual([{ t: 'failed', id: 1, kind: 'stt' }]);
    h.msg({ t: 'cancel', id: 2 });
    h.msg({ t: 'listen', id: 3, hint: [] });
    h.session.close();
    await h.session.idle();
    expect(h.sent.slice(1)).toEqual([{ t: 'failed', id: 1, kind: 'stt' }]);
  });
});

describe('Session: Step 5 (G2): ids are fresh per listen', () => {
  test('a listen reusing the live utterance id is a bad message (4400): no failed and no transcript for that id, the buffer zeroed', async () => {
    const h = harness();
    h.msg({ t: 'listen', id: 1, hint: [] });
    h.frame(1, 320);
    h.msg({ t: 'listen', id: 1, hint: [] });
    h.frame(1, 320);
    h.msg({ t: 'end', id: 1 });
    await h.session.idle();
    expect(h.closed).toEqual([4400]);
    expect(h.sent.slice(1)).toEqual([]);
    expect(h.buffers.every(allZero)).toBe(true);
  });

  test('the same while it is being transcribed; a fresh id still replaces it with failed stt as before', async () => {
    let finish!: (s: string) => void;
    const slow: SttEngine = { model: 'slow', transcribe: () => new Promise<string>((r) => (finish = r)) };
    const h = harness({ stt: slow });
    h.msg({ t: 'listen', id: 1, hint: [] });
    h.frame(1, 320);
    h.msg({ t: 'end', id: 1 });
    await until(() => typeof finish === 'function');
    h.msg({ t: 'listen', id: 1, hint: [] });
    expect(h.closed).toEqual([4400]);
    finish('late words');
    await h.session.idle();
    expect(h.sent.slice(1)).toEqual([]);

    const k = harness();
    k.msg({ t: 'listen', id: 1, hint: [] });
    k.msg({ t: 'listen', id: 2, hint: [] });
    expect(k.closed).toEqual([]);
    expect(k.sent.slice(1)).toEqual([{ t: 'failed', id: 1, kind: 'stt' }]);
  });
});

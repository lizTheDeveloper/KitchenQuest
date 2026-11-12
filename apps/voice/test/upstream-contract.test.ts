// M7 P1: the API <-> voice service contract. A plain `ws` client replays core's shared fixture against the real server
// (fake engines scripted to the fixture), message for message. The API's wsUpstream test replays the same file (Step 5).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeFrame, parseUpstreamClientMsg, parseUpstreamServerMsg } from '@kitchenquest/core';
import { afterEach, expect, test } from 'vitest';
import type { SttEngine, TtsEngine } from '../src/engines/types';
import { createVoiceServer } from '../src/server';
import { connect, testConfig } from './helpers';

type Entry = { from: 'api' | 'service'; msg?: Record<string, unknown>; frame?: { id: number; samples: number } };
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/voice-upstream-session.json', import.meta.url)), 'utf8'),
) as { messages: Entry[] };

const ready = fixture.messages.find((m) => m.msg?.t === 'ready')!.msg as { stt: string; tts: string; sampleRate: number };
const transcript = fixture.messages.find((m) => m.msg?.t === 'transcript')!.msg as { text: string };

// Scripted to the fixture: the STT hears its transcript, and fails on an empty utterance (the service never calls it
// then, see session.ts); the TTS gives one 20 ms frame per chunk and fails on the check_screen line.
const stt: SttEngine = { model: ready.stt, transcribe: () => Promise.resolve(transcript.text) };
const tts: TtsEngine = {
  model: ready.tts,
  sampleRate: ready.sampleRate,
  synthesize: async function* (text) {
    if (text.startsWith("It's on the screen")) throw new Error('scripted failure');
    yield new Int16Array((ready.sampleRate * 20) / 1000);
  },
};

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

test('the real server answers the fixture session message for message (fake engines), each reply passing parseUpstreamServerMsg', async () => {
  const server = createVoiceServer({ config: testConfig(), stt, tts, log: () => {} });
  servers.push(server);
  const client = await connect(await server.listen(0));

  let replies = 0;
  for (const entry of fixture.messages) {
    if (entry.from === 'api') {
      if (entry.msg) {
        expect(parseUpstreamClientMsg(entry.msg), JSON.stringify(entry.msg)).not.toBeNull();
        client.send(entry.msg);
      } else client.send(encodeFrame(entry.frame!.id, new Int16Array(entry.frame!.samples)));
      continue;
    }
    const got = await client.next();
    replies++;
    if (entry.msg) {
      expect(got.kind).toBe('msg');
      if (got.kind !== 'msg') continue;
      expect(parseUpstreamServerMsg(got.raw)).toEqual(got.msg);
      expect(got.raw).toEqual(entry.msg);
    } else {
      expect(got.kind).toBe('frame');
      if (got.kind !== 'frame') continue;
      expect({ id: got.id, samples: got.pcm.length }).toEqual(entry.frame);
    }
  }
  expect(replies).toBe(fixture.messages.filter((m) => m.from === 'service').length);
  // Nothing more: the cancelled listen got no reply, and nothing trails the last failure.
  await new Promise((r) => setTimeout(r, 50));
  expect(client.received).toHaveLength(replies);
  client.ws.close();
  await client.closed;
});

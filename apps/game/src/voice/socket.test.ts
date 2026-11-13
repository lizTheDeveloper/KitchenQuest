import { decodeFrame, encodeFrame, VOICE_CLOSE_CODES, type ClientMsg } from '@kitchenquest/core/engine';
import { describe, expect, test } from 'vitest';
import { socketWin } from './fakes.fixture';
import { openVoiceSocket, VoiceSocketClosed } from './socket';

const HELLO: Extract<ClientMsg, { t: 'hello' }> = { t: 'hello', v: 1, conversationId: null, localDate: '2026-11-13', localTime: '18:05', familyTable: false };
const flush = () => new Promise((r) => setTimeout(r, 0));

async function opened() {
  const { win, sockets } = socketWin();
  const p = openVoiceSocket(win, HELLO);
  const ws = sockets[0];
  ws.open();
  ws.serverSend({ t: 'ready', state: { kind: 'available' } });
  return { socket: await p, ws };
}

describe('openVoiceSocket', () => {
  test('hello first, carrying familyTable from the store; binary frames carry the id; a malformed server message closes with bad_message', async () => {
    const { win, sockets } = socketWin();
    const p = openVoiceSocket(win, { ...HELLO, familyTable: false });
    const ws = sockets[0];
    expect(ws.url).toBe('wss://kq.example/api/voice');
    ws.open();
    expect(ws.json()).toEqual([{ ...HELLO, familyTable: false }]);
    ws.serverSend({ t: 'ready', state: { kind: 'resting_today' } });
    const socket = await p;
    expect(socket.state).toEqual({ kind: 'resting_today' });
    socket.send({ t: 'listen', id: 7, mode: 'hold' });
    const pcm = Int16Array.from([1, -2, 3]);
    socket.frame(7, pcm);
    const frame = decodeFrame(ws.frames()[0]);
    expect(frame?.id).toBe(7);
    expect([...frame!.pcm]).toEqual([1, -2, 3]);
    const msgs: unknown[] = [];
    socket.on((m) => msgs.push(m));
    const audio: [number, number[]][] = [];
    socket.onAudio((id, a) => audio.push([id, [...a]]));
    ws.serverSend({ t: 'transcript', id: 7, text: 'next step' });
    ws.serverBinary(encodeFrame(9, Int16Array.from([5, 6])));
    expect(msgs).toEqual([{ t: 'transcript', id: 7, text: 'next step' }]);
    expect(audio).toEqual([[9, [5, 6]]]);
    // A message the protocol does not know: the socket is closed with bad_message, and nothing more is sent.
    ws.serverSend({ t: 'transcript', id: 7, text: 'x', extra: true });
    await expect(socket.closed).resolves.toBe('bad_message');
    expect(ws.closedWith).toBe(VOICE_CLOSE_CODES.bad_message);
    const before = ws.sent.length;
    socket.send({ t: 'end', id: 7 });
    socket.frame(7, pcm);
    expect(ws.sent.length).toBe(before);
    // A binary frame too short for an id is malformed too.
    const other = await opened();
    other.ws.serverBinary(Uint8Array.from([1, 2]));
    await expect(other.socket.closed).resolves.toBe('bad_message');
  });

  test('a server close before ready rejects with its reason; after ready, the reason comes from `closed` or the close code, else network', async () => {
    const a = socketWin();
    const pa = openVoiceSocket(a.win, HELLO);
    a.sockets[0].open();
    a.sockets[0].serverSend({ t: 'closed', reason: 'consent_required' });
    a.sockets[0].serverClose(VOICE_CLOSE_CODES.consent_required);
    await expect(pa).rejects.toEqual(new VoiceSocketClosed('consent_required'));
    // The close code alone (the message was missed).
    const b = socketWin();
    const pb = openVoiceSocket(b.win, HELLO);
    b.sockets[0].open();
    b.sockets[0].serverClose(VOICE_CLOSE_CODES.family_table);
    await expect(pb).rejects.toMatchObject({ reason: 'family_table' });
    // After ready.
    const c = await opened();
    c.ws.serverClose(VOICE_CLOSE_CODES.child);
    await expect(c.socket.closed).resolves.toBe('child');
    const d = await opened();
    d.ws.serverClose(1006);
    await expect(d.socket.closed).resolves.toBe('network');
    // The device closing it.
    const e = await opened();
    e.socket.close();
    await flush();
    expect(e.ws.closedWith).toBe(1000);
    await expect(e.socket.closed).resolves.toBe('network');
  });
});

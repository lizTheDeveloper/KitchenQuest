// M7 Step 11: a scripted fake of the API for the voice e2e. `/api/**` is answered from memory and the voice socket
// (`/api/voice`) is scripted with `page.routeWebSocket`: hello → ready, a listen's `end` → the next scripted
// transcript, a speak → audio_start, two frames of silence, audio_end. Tests never touch the network, and the clips
// the fake microphone plays are synthetic tones (e2e/fixtures/voice/make.mjs): no human voice.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Request, Route, WebSocketRoute } from 'playwright';
import { buildRuleCard, encodeFrame, IngredientGraph, type RuleTerm, type ServerMsg, type VoiceState } from '@kitchenquest/core/engine';

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const data = (f: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../data/${f}`, import.meta.url)), 'utf8'));
export const graph = IngredientGraph.fromData(data('ingredients.json') as Parameters<typeof IngredientGraph.fromData>[0]);
export const ruleTerms = data('rule-terms.json') as RuleTerm[];

/** The fake microphone's clip: a tone-shaped utterance (see fixtures/voice/make.mjs). */
export const FAKE_WAV = fileURLToPath(new URL('./fixtures/voice/utterance.wav', import.meta.url));
/** Chromium's fake microphone and permission prompt, playing FAKE_WAV in a loop. */
export const FAKE_MIC_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${FAKE_WAV}`];

/** Counts getUserMedia calls on the page (the real one still runs) and keeps its streams, before any app script. */
export const GUM_SPY = `(() => {
  window.__gum = 0;
  const md = navigator.mediaDevices;
  if (!md) return;
  const real = md.getUserMedia.bind(md);
  window.__streams = [];
  md.getUserMedia = (c) => { window.__gum++; return real(c).then((s) => { window.__streams.push(s); return s; }); };
})();`;

export interface VoiceFake {
  /** Every /api request. */
  requests: Request[];
  /** Mentor turn bodies, in order. */
  turns: Record<string, unknown>[];
  /** Every client message on the voice socket (frames counted, not kept). */
  sent: Record<string, unknown>[];
  /** Binary frames the device sent (counted only: audio is never kept, here either). */
  frames: number;
  /** Sockets opened. */
  sockets: number;
  /** The next transcripts, in order, for each `end`. */
  transcripts: string[];
  /** The allowance state `ready` carries. */
  state: VoiceState;
  /** Voice consent granted (a POST /me/consents for it flips it). */
  voiceGranted: boolean;
  /** How long a mentor turn takes. */
  turnDelayMs: number;
  /** The open socket, for a scripted push (state, closed). */
  ws: WebSocketRoute | null;
  /** PUT /voice/family-table bodies. */
  familyTable: unknown[];
  /** The API's per-user block (Ruling 17): every hello is closed with it. */
  blocked: 'child' | 'family_table' | null;
}

export const newVoiceFake = (o: Partial<VoiceFake> = {}): VoiceFake => ({
  requests: [], turns: [], sent: [], frames: 0, sockets: 0, transcripts: [], state: { kind: 'available' }, voiceGranted: true,
  turnDelayMs: 0, ws: null, familyTable: [], blocked: null, ...o,
});

const consent = (purpose: string) => ({ purpose, noticeVersion: 'v1', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true });
const VOICE_NOTICE = { version: 'v1', text: 'Voice: your words are heard by our own speech service, in memory only. Audio is never stored.' };

/** The rule card the API makes for a confirmed "I'm allergic to <term>". */
export function ruleTurn(term: string, severity: 'allergy' | null = 'allergy') {
  const built = buildRuleCard({ term, severity }, graph, ruleTerms);
  if (!built.ok) throw new Error(`no rule card for ${term}`);
  return {
    conversationId: 'c1', route: 'ai', notice: null, toolTurn: true, actions: [], replyId: 'r1',
    parts: built.card.readback.map((line) => ({ kind: 'line', line })),
    cards: [{ proposalId: 'P1', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), card: built.card }],
  };
}

/** A plain reply (one scripted line). */
export const lineTurn = (trigger: string, vars: Record<string, string> = {}) => ({
  conversationId: 'c1', route: 'deterministic', notice: null, toolTurn: false, actions: [], replyId: 'r2', cards: [],
  parts: [{ kind: 'line', line: { trigger, vars } }],
});

export async function fakeVoiceApi(page: Page, fake: VoiceFake, opts: { turn?: (body: Record<string, unknown>) => unknown } = {}): Promise<void> {
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/') && !r.url().includes('/api/voice?')) fake.requests.push(r); });
  await page.route((u) => u.pathname.startsWith('/api/'), async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/, '');
    const m = req.method();
    if (path === '/me') return route.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] }));
    if (path === '/me/consents' && m === 'GET') {
      const purposes = ['health_data', 'ai_health', ...(fake.voiceGranted ? ['voice'] : [])];
      return route.fulfill(json(200, { consents: purposes.map(consent), needsReconsent: [], notices: { voice: VOICE_NOTICE } }));
    }
    if (path === '/me/consents' && m === 'POST') {
      const b = req.postDataJSON() as { purpose: string };
      if (b.purpose === 'voice') fake.voiceGranted = true;
      return route.fulfill(json(201, { consent: consent(b.purpose) }));
    }
    if (path.startsWith('/me/consents/') && m === 'DELETE') {
      if (path.endsWith('/voice')) fake.voiceGranted = false;
      return route.fulfill({ status: 204, body: '' });
    }
    if (path === '/rules') return route.fulfill(json(200, { rules: [] }));
    if (path === '/voice/status') return route.fulfill(json(200, { state: fake.state, accessibility: false, enabled: true }));
    if (path === '/voice/family-table') {
      fake.familyTable.push(req.postDataJSON());
      return route.fulfill({ status: 204, body: '' });
    }
    if (path === '/mentor/turn') {
      const body = req.postDataJSON() as Record<string, unknown>;
      fake.turns.push(body);
      if (fake.turnDelayMs > 0) await new Promise((r) => setTimeout(r, fake.turnDelayMs));
      return route.fulfill(json(200, opts.turn?.(body) ?? lineTurn('thanks')));
    }
    return route.fulfill(json(401, { error: { code: 'unauthorized', message: 'Sign in required' } }));
  });
  await page.routeWebSocket((u) => u.pathname === '/api/voice', (ws) => {
    fake.sockets++;
    fake.ws = ws;
    const send = (msg: ServerMsg) => { ws.send(JSON.stringify(msg)); };
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') { fake.frames++; return; }
      const msg = JSON.parse(raw) as Record<string, unknown>;
      fake.sent.push(msg);
      const id = msg.id as number;
      switch (msg.t) {
        case 'hello':
          if (msg.familyTable === true) fake.blocked = 'family_table';
          if (fake.blocked !== null) { send({ t: 'closed', reason: fake.blocked }); return ws.close({ code: fake.blocked === 'child' ? 4451 : 4452 }); }
          return send({ t: 'ready', state: fake.state });
        case 'end': {
          const text = fake.transcripts.shift() ?? '';
          return send({ t: 'transcript', id, text });
        }
        case 'speak':
          send({ t: 'audio_start', id, sampleRate: 22_050 });
          for (let i = 0; i < 2; i++) ws.send(Buffer.from(encodeFrame(id, new Int16Array(441))));
          // The Pan "talks" for a moment (barge-in can land), then ends.
          setTimeout(() => { try { send({ t: 'audio_end', id }); } catch { /* closed */ } }, 400);
          return;
        default:
          return;
      }
    });
  });
}

// M7 Step 5: the only public door to voice, `GET /voice`, a WebSocket the game reaches same-origin at `/api/voice`.
// It authenticates the session cookie and checks the Origin before anything else; checks the `voice` consent, the
// per-user voice block (Ruling 17) and the allowance; proxies audio to the private voice service under core's upstream
// protocol with the STT hint; meters seconds into `usage_events`; and speaks only what renderSpeak makes from
// server-held data (Ruling 15).
//
// C-18: audio lives in memory only, for as long as it is being forwarded: a frame is decoded, sent upstream and zeroed;
// nothing keeps a reference to one. A transcript is kept in this socket's memory (the last TRANSCRIPTS_KEPT, for
// `heard` speak items) and dropped on close. Nothing here logs a message body, frame, transcript or hint: only kinds
// and statuses.
import { readFileSync } from 'node:fs';
import {
  decodeFrame,
  encodeFrame,
  FRAME_MS,
  MAX_UTTERANCE_MS,
  parseClientMsg,
  parseTurnInput,
  VOICE_CLOSE_CODES,
  type ClientMsg,
  type ServerMsg,
  type VoiceCloseReason,
  type VoiceState,
} from '@kitchenquest/core';
import type {} from '@fastify/websocket';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { countSelfRead } from '../audit/self-reads.js';
import { requireUser } from '../auth/session.js';
import type { Catalog } from '../catalog.js';
import { hasConsent } from '../consent/ledger.js';
import type { PanBank } from '../mentor/lines.js';
import type { RecipeIndexSource } from '../recipes/recipe-index.js';
import { recordVoice, voiceState } from './allowance.js';
import { sttHint } from './hint.js';
import { localOffsetMinutes } from './local-clock.js';
import { voiceRegistry } from './registry.js';
import { cardReadback, renderSpeak, SPOKEN_TRIGGERS, stepCleared, type SpeakContext } from './speak.js';
import { VoiceUpstreamError, type UpstreamFailure, type VoiceLink, type VoiceUpstream } from './upstream.js';

/** The longest a client message may be: a 20 ms frame is 644 bytes, a speak a few hundred bytes of JSON. */
export const MAX_CLIENT_PAYLOAD = 16 * 1024;
/** An utterance's frames: MAX_UTTERANCE_MS of FRAME_MS each. One more is past the limit (`too_long`). */
const MAX_FRAMES = MAX_UTTERANCE_MS / FRAME_MS;
/** How many of this socket's own transcripts it keeps for `heard` items. */
export const TRANSCRIPTS_KEPT = 4;
/**
 * Messages waiting while an earlier one is handled: a whole utterance of frames and some (about 1 MB at most). More,
 * and the client is not a game: it is closed `bad_message`.
 */
const MAX_QUEUED = MAX_FRAMES + 100;
/** Above this many bytes queued to the browser, it is not reading: the speech stops (`failed tts`). */
const MAX_BUFFERED = 512 * 1024;
/** Carry 5: at most this many utterances in flight per player, on this server (one socket per player already). */
export const MAX_UTTERANCES_PER_USER = 1;
const MINUTE_MS = 60_000;

/** The voice role the API names upstream: the manifest's `cast.pan` (data/voice-models.json), resolved by the service. */
const MANIFEST = new URL('../../../../data/voice-models.json', import.meta.url);
function panRole(): string {
  const doc = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { cast?: Record<string, unknown> };
  if (doc.cast === undefined || typeof doc.cast.pan !== 'object' || doc.cast.pan === null) throw new Error('voice: data/voice-models.json has no cast.pan');
  return 'pan';
}

export interface VoiceRouteDeps {
  catalog: Catalog;
  recipes: RecipeIndexSource;
  bank: PanBank;
  upstream: VoiceUpstream;
}

type Auth = { ok: true; userId: string } | { ok: false; reason: VoiceCloseReason };

/** Utterances in flight per player (carry 5). */
const liveUtterances = new Map<string, number>();
function takeSlot(userId: string): boolean {
  const n = liveUtterances.get(userId) ?? 0;
  if (n >= MAX_UTTERANCES_PER_USER) return false;
  liveUtterances.set(userId, n + 1);
  return true;
}
function releaseSlot(userId: string): void {
  const n = (liveUtterances.get(userId) ?? 0) - 1;
  if (n <= 0) liveUtterances.delete(userId);
  else liveUtterances.set(userId, n);
}

/** What the route logs: a kind, and a status or close code. Never a body, frame, transcript, hint or error message. */
const logKind = (log: FastifyBaseLogger, kind: string, status?: number) => log.info({ kind, ...(status === undefined ? {} : { status }) }, 'voice');

/** The game's origin, as browsers send it in the Origin header (scheme://host[:port], no path). */
const originOf = (appOrigin: string) => appOrigin.replace(/\/+$/, '').toLowerCase();

interface Utterance {
  clientId: number;
  upId: number;
  frames: number;
  phase: 'listening' | 'ending';
  /** `too_long` was sent for it (past MAX_UTTERANCE_MS); the transcript still follows. */
  overLimit: boolean;
}

interface Speech {
  clientId: number;
  upId: number;
  started: boolean;
}

class VoiceSocket {
  private helloed = false;
  private offset = 0;
  private closed = false;
  private link: VoiceLink | null = null;
  private opening: Promise<VoiceLink> | null = null;
  private readonly abort = new AbortController();
  private utter: Utterance | null = null;
  private speech: Speech | null = null;
  private readonly transcripts = new Map<number, string>();
  private nextUpId = 1;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private readonly unregister: () => void;

  constructor(
    private readonly app: FastifyInstance,
    private readonly ws: WebSocket,
    private readonly userId: string,
    private readonly deps: VoiceRouteDeps,
    private readonly role: string,
    private readonly log: FastifyBaseLogger,
  ) {
    // Ruling 17: one socket per player; an older one closes with `another_tab`. A block closes this one.
    this.unregister = voiceRegistry.add(userId, { close: (reason) => this.close(reason) });
    ws.on('message', (data: RawData, binary: boolean) => this.enqueue(data, binary));
    ws.on('close', () => this.teardown());
    ws.on('error', () => this.teardown());
  }

  // --- the queue: one message at a time, in order (frames wait for their listen) ----------------------------------

  private enqueue(data: RawData, binary: boolean): void {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
    if (this.closed) {
      bytes.fill(0);
      return;
    }
    if (++this.queued > MAX_QUEUED) {
      bytes.fill(0);
      return this.close('bad_message');
    }
    const handle = async (): Promise<void> => {
      if (this.closed) {
        bytes.fill(0);
        return;
      }
      if (binary) return this.onFrame(bytes);
      return this.onText(bytes);
    };
    this.queue = this.queue
      .then(handle)
      .catch(() => this.internal())
      .finally(() => {
        this.queued--;
      });
  }

  private internal(): void {
    // An unexpected error: its message may hold anything, so it is never read or logged (Review Focus 2).
    logKind(this.log, 'voice_internal', 1011);
    if (this.closed) return;
    this.ws.close(1011);
    this.teardown();
  }

  private send(msg: ServerMsg): void {
    if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Closes with `closed { reason }` and its code (core VOICE_CLOSE_CODES). Idempotent. */
  close(reason: VoiceCloseReason): void {
    if (this.closed) return;
    this.send({ t: 'closed', reason });
    this.ws.close(VOICE_CLOSE_CODES[reason]);
    this.teardown();
  }

  /** Everything is dropped: the utterance, the speech, the transcripts and the upstream link. */
  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.utter !== null) this.dropUtterance();
    this.speech = null;
    this.transcripts.clear();
    this.link?.close();
    this.link = null;
    this.unregister();
  }

  // --- messages ----------------------------------------------------------------------------------------------------

  private onFrame(bytes: Buffer): void {
    const frame = decodeFrame(bytes);
    bytes.fill(0);
    if (frame === null || !this.helloed) {
      frame?.pcm.fill(0);
      return this.close('bad_message');
    }
    const u = this.utter;
    try {
      // Frames for any other id (stale, resting, ended) are dropped.
      if (u === null || u.phase !== 'listening' || u.clientId !== frame.id) return;
      if (u.frames >= MAX_FRAMES) {
        // Past MAX_UTTERANCE_MS: `too_long`, then the transcript of what came (the utterance ends here).
        u.overLimit = true;
        this.send({ t: 'too_long', id: u.clientId });
        return this.finish(u);
      }
      this.link?.frame(u.upId, frame.pcm);
      u.frames++;
    } finally {
      frame.pcm.fill(0);
    }
  }

  private async onText(bytes: Buffer): Promise<void> {
    let msg: ClientMsg | null = null;
    try {
      msg = parseClientMsg(JSON.parse(bytes.toString('utf8')));
    } catch {
      msg = null;
    }
    if (msg === null) return this.close('bad_message');
    // B5: nothing but hello before hello, and hello once.
    if (!this.helloed && msg.t !== 'hello') return this.close('bad_message');
    if (this.helloed && msg.t === 'hello') return this.close('bad_message');
    switch (msg.t) {
      case 'hello':
        return this.hello(msg);
      case 'listen':
        return this.listen(msg.id);
      case 'end':
        if (this.utter?.clientId === msg.id && this.utter.phase === 'listening') this.finish(this.utter);
        return;
      case 'cancel':
        return this.cancel(msg.id);
      case 'speak':
        return this.speak(msg.id, msg.items);
    }
  }

  /** Ruling 17: the user's block, or the socket closed with it. True when blocked (and so closed). */
  private blockedNow(): boolean {
    const reason = voiceRegistry.blocked(this.userId, this.app.deps.now().getTime());
    if (reason === null) return false;
    this.close(reason);
    return true;
  }

  /** The allowance on the player's calendar (carry 4: the clock dates it, never decides it). */
  private async state(): Promise<VoiceState> {
    const { db, config, now } = this.app.deps;
    const at = now();
    const v = await voiceState(db, config.keyring, this.userId, at, this.offset);
    // C-5: the player's own health data (the sealed accessibility need) read while health_data is in force.
    if (v.accessibilityRead) await countSelfRead(db, this.userId, 'voice', at);
    return v.state;
  }

  private async hello(msg: Extract<ClientMsg, { t: 'hello' }>): Promise<void> {
    try {
      // Carry 4: checked exactly as GET /voice/status checks them.
      this.offset = localOffsetMinutes(msg.localDate, msg.localTime, this.app.deps.now());
    } catch {
      return this.close('bad_message');
    }
    this.helloed = true;
    // Ruling 17: the device's Family Table report sets the server flag (and closes this socket with it).
    if (msg.familyTable) {
      voiceRegistry.setFamilyTable(this.userId, true);
      return this.close('family_table');
    }
    // Whatever the conversationId, null included: a child flag in any conversation, or a Family Table report, blocks.
    if (this.blockedNow()) return;
    const state = await this.state();
    if (this.closed) return;
    this.send({ t: 'ready', state });
  }

  /** The upstream link, opened on demand (and again after it went away). */
  private ensureLink(): Promise<VoiceLink> {
    if (this.link?.isOpen()) return Promise.resolve(this.link);
    this.opening ??= this.deps.upstream.open(this.abort.signal).then(
      (link) => {
        this.opening = null;
        if (this.closed) {
          link.close();
          throw new VoiceUpstreamError('cancelled');
        }
        this.link = link;
        return link;
      },
      (e: unknown) => {
        this.opening = null;
        throw e;
      },
    );
    return this.opening;
  }

  /** An upstream failure, as the player sees it: configuration closes voice (`unavailable`); the rest is `failed`. */
  private upstreamFailed(id: number, e: unknown, kind: 'stt' | 'tts' | 'upstream'): void {
    const failure: UpstreamFailure | 'other' = e instanceof VoiceUpstreamError ? e.kind : 'other';
    if (failure === 'cancelled') return;
    logKind(this.log, `voice_upstream_${failure}`);
    if (failure === 'auth' || failure === 'misrouted') return this.close('unavailable');
    this.send({ t: 'failed', id, kind: failure === 'stt' || failure === 'tts' ? failure : kind });
  }

  private dropUtterance(): void {
    const u = this.utter;
    if (u === null) return;
    this.utter = null;
    this.link?.cancel(u.upId);
    releaseSlot(this.userId);
  }

  private async listen(id: number): Promise<void> {
    if (this.blockedNow()) return;
    // One utterance at a time, and none goes unanswered (carry 2): a replaced one is `failed stt` at once, and its
    // upstream id is cancelled, so a late reply for it is never awaited.
    const old = this.utter;
    if (old !== null) {
      this.dropUtterance();
      this.send({ t: 'failed', id: old.clientId, kind: 'stt' });
    }
    // Carry 5: the allowance again before every utterance; the one in flight always finishes (Ruling 5).
    const state = await this.state();
    if (this.closed) return;
    if (state.kind !== 'available') return this.send({ t: 'state', state });
    if (!takeSlot(this.userId)) return this.send({ t: 'failed', id, kind: 'stt' });
    let slotHeld = true;
    try {
      const link = await this.ensureLink();
      const { db, config, now } = this.app.deps;
      const at = now();
      const today = new Date(at.getTime() + this.offset * MINUTE_MS).toISOString().slice(0, 10);
      const hint = await sttHint(db, config.keyring, this.deps.catalog, this.userId, at, today);
      if (this.closed || this.blockedNow()) return;
      // A fresh upstream id per listen (G2): the service never sees an id twice.
      const upId = this.nextUpId++;
      link.listen(upId, hint);
      hint.length = 0;
      this.utter = { clientId: id, upId, frames: 0, phase: 'listening', overLimit: false };
      slotHeld = false;
    } catch (e) {
      this.upstreamFailed(id, e, 'upstream');
    } finally {
      if (slotHeld) releaseSlot(this.userId);
    }
  }

  /** The utterance ends: wait for its transcript (by id), record its speech once, answer it once. */
  private finish(u: Utterance): void {
    u.phase = 'ending';
    const link = this.link;
    const speechMs = u.frames * FRAME_MS;
    const answered = link === null ? Promise.reject(new VoiceUpstreamError('down')) : link.end(u.upId);
    void answered
      .then(
        ({ text }) => {
          if (this.utter !== u) return null; // replaced or cancelled: already answered, or the client asked
          this.utter = null;
          releaseSlot(this.userId);
          // Carry 7: what is sent must be a valid turn input (core parseTurnInput): over MAX_TEXT → too_long, never
          // cut; blank → failed stt. Kept for `heard` items, never logged.
          const input = parseTurnInput({ kind: 'transcript', text });
          if (input === null) {
            const blank = text.trim() === '';
            if (blank) this.send({ t: 'failed', id: u.clientId, kind: 'stt' });
            else this.send({ t: 'too_long', id: u.clientId });
            return speechMs;
          }
          this.keepTranscript(u.clientId, input.text);
          this.send({ t: 'transcript', id: u.clientId, text: input.text });
          return speechMs;
        },
        (e: unknown) => {
          if (this.utter !== u) return null;
          this.utter = null;
          releaseSlot(this.userId);
          if (e instanceof VoiceUpstreamError && e.kind === 'too_long') this.send({ t: 'too_long', id: u.clientId });
          else this.upstreamFailed(u.clientId, e, 'upstream');
          return e instanceof VoiceUpstreamError && e.kind === 'cancelled' ? null : speechMs;
        },
      )
      .then(async (ms) => {
        // Carry 5: exactly once per answered utterance; a cancelled or replaced one is not recorded.
        if (ms === null) return;
        const { db, now } = this.app.deps;
        await recordVoice(db, this.userId, 'voice_stt', ms, now());
      })
      .catch(() => logKind(this.log, 'voice_record_failed'));
  }

  private keepTranscript(id: number, text: string): void {
    this.transcripts.delete(id);
    this.transcripts.set(id, text);
    while (this.transcripts.size > TRANSCRIPTS_KEPT) this.transcripts.delete(this.transcripts.keys().next().value!);
  }

  private cancel(id: number): void {
    if (this.utter?.clientId === id) this.dropUtterance();
    if (this.speech?.clientId === id) {
      const s = this.speech;
      this.speech = null;
      this.link?.cancel(s.upId);
    }
  }

  private async speak(id: number, items: Parameters<typeof renderSpeak>[0]): Promise<void> {
    if (this.blockedNow()) return;
    const state = await this.state();
    if (this.closed) return;
    if (state.kind !== 'available') return this.send({ t: 'state', state });
    const { db, config, now } = this.app.deps;
    const recipes = await this.deps.recipes.current(db);
    const ctx: SpeakContext = {
      userId: this.userId,
      bank: this.deps.bank,
      catalog: this.deps.catalog,
      lastTranscript: (utteranceId) => this.transcripts.get(utteranceId) ?? null,
      card: (proposalId) => cardReadback(db, config.keyring, this.userId, proposalId),
      stepOk: (slug, _step, localDate) => stepCleared(db, { keyring: config.keyring, catalog: this.deps.catalog, recipes }, this.userId, slug, localDate, now()),
      recipes,
      nowMs: now().getTime(),
    };
    let link: VoiceLink;
    let text: Awaited<ReturnType<typeof renderSpeak>>;
    try {
      text = await renderSpeak(items, ctx);
      link = await this.ensureLink();
    } catch (e) {
      return this.upstreamFailed(id, e, e instanceof VoiceUpstreamError ? 'upstream' : 'tts');
    }
    if (this.closed) return;
    // One speech at a time: a new speak replaces the old, which gets no audio_end (core upstream.ts).
    const old = this.speech;
    if (old !== null) {
      this.speech = null;
      link.cancel(old.upId);
    }
    const s: Speech = { clientId: id, upId: this.nextUpId++, started: false };
    this.speech = s;
    void link
      .speak(s.upId, this.role, text, (pcm, sampleRate) => {
        if (this.speech !== s || this.closed) return;
        if (!s.started) {
          s.started = true;
          this.send({ t: 'audio_start', id, sampleRate });
        }
        this.ws.send(encodeFrame(id, pcm), { binary: true });
        if (this.ws.bufferedAmount > MAX_BUFFERED) {
          // The browser is not reading: stop, and say so.
          this.speech = null;
          link.cancel(s.upId);
          this.send({ t: 'failed', id, kind: 'tts' });
        }
      })
      .then(
        async ({ audioMs }) => {
          if (this.speech !== s) return;
          this.speech = null;
          this.send({ t: 'audio_end', id });
          // The Pan's speech is recorded, never counted (Ruling 5).
          await recordVoice(db, this.userId, 'voice_tts', audioMs, now());
        },
        (e: unknown) => {
          if (this.speech !== s) return;
          this.speech = null;
          this.upstreamFailed(id, e, 'upstream');
        },
      )
      .catch(() => logKind(this.log, 'voice_record_failed'));
  }
}

/**
 * `GET /voice` (WebSocket). Before any message is read: no live session → `closed signed_out` (4401); a missing or
 * foreign Origin → `bad_origin` (4403), checked first, before the cookie is even looked up; no `voice` grant →
 * `consent_required`. Then the protocol (core ClientMsg / ServerMsg): `hello` (with the player's clock; a Family
 * Table report or the per-user block closes it), `listen` / frames / `end` → `transcript`, `cancel`, `speak` →
 * `audio_start` / frames / `audio_end`. The upstream down → `failed { kind: 'upstream' }`, and the socket stays open.
 */
export async function voiceRoutes(app: FastifyInstance, deps: VoiceRouteDeps): Promise<void> {
  const role = panRole();
  for (const [trigger, vars] of Object.entries(SPOKEN_TRIGGERS)) {
    if (!deps.bank.hasTrigger(trigger) || deps.bank.varsOf(trigger).join() !== [...vars].sort().join()) {
      throw new Error(`voice: pan.yaml must have ${trigger} taking exactly {${vars.join('}, {')}}`);
    }
  }
  const auths = new WeakMap<FastifyRequest, Auth>();
  const appOrigin = originOf(app.deps.config.appOrigin);

  const authorise = async (req: FastifyRequest, reply: FastifyReply): Promise<Auth> => {
    const origin = req.headers.origin;
    // Cross-site WebSocket hijacking: the browser always sends Origin; a missing one is no browser of ours.
    if (typeof origin !== 'string' || origin.toLowerCase() !== appOrigin) return { ok: false, reason: 'bad_origin' };
    try {
      await requireUser(req, reply);
    } catch {
      return { ok: false, reason: 'signed_out' };
    }
    if (app.deps.config.voice === null) return { ok: false, reason: 'unavailable' };
    if (!(await hasConsent(app.deps.db, req.user.id, 'voice', app.deps.now()))) return { ok: false, reason: 'consent_required' };
    return { ok: true, userId: req.user.id };
  };

  app.get(
    '/voice',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        auths.set(req, await authorise(req, reply));
      },
    },
    (socket, req) => {
      const auth = auths.get(req) ?? { ok: false, reason: 'signed_out' };
      auths.delete(req);
      if (!auth.ok) {
        logKind(req.log, `voice_refused_${auth.reason}`, VOICE_CLOSE_CODES[auth.reason]);
        socket.on('message', (data: RawData) => {
          if (Buffer.isBuffer(data)) data.fill(0);
        });
        socket.send(JSON.stringify({ t: 'closed', reason: auth.reason } satisfies ServerMsg));
        socket.close(VOICE_CLOSE_CODES[auth.reason]);
        return;
      }
      new VoiceSocket(app, socket, auth.userId, deps, role, req.log);
    },
  );
}

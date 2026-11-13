// M7 Step 5: the only public door to voice, `GET /voice`, a WebSocket the game reaches same-origin at `/api/voice`.
// It authenticates the session cookie and checks the Origin before anything else; checks the `voice` consent, the
// per-user voice block (Ruling 17) and the allowance; proxies audio to the private voice service under core's upstream
// protocol with the STT hint; meters seconds into `usage_events`; and speaks only what renderSpeak makes from
// server-held data (Ruling 15).
//
// Fix round 1 (I1): the session and the `voice` consent are checked again before every listen and speak, and
// sign-out, account delete and consent withdrawals close every voice socket of the player (`voiceRegistry.closeUser`).
//
// C-18: audio lives in memory only, for as long as it is being forwarded: a frame is decoded, sent upstream and zeroed;
// nothing keeps a reference to one. A transcript is kept in this socket's memory (the last TRANSCRIPTS_KEPT, for
// `heard` speak items) and dropped on close. Nothing here logs a message body, frame, transcript or hint: only kinds
// and statuses.
//
// This process holds the voice block, the utterance slots and the rate limits in memory: the API runs as exactly one
// process while that is so (docs/compliance/ROADMAP.md, M7 deploy note; review m1).
import { readFileSync } from 'node:fs';
import {
  CHILD_PATTERNS,
  decodeFrame,
  encodeFrame,
  normalizeText,
  stripPageEventsFull,
  FRAME_MS,
  MAX_TEXT,
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
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { countSelfRead } from '../audit/self-reads.js';
import { SlidingWindowLimiter, sweepPeriodically } from '../auth/rate-limit.js';
import { requireUser, SESSION_COOKIE } from '../auth/session.js';
import { hashToken, isTokenShaped } from '../auth/tokens.js';
import type { Catalog } from '../catalog.js';
import { hasConsent } from '../consent/ledger.js';
import { sessions, users } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { PanBank } from '../mentor/lines.js';
import type { RecipeIndexSource } from '../recipes/recipe-index.js';
import { recordVoice, voiceState } from './allowance.js';
import { sttHint } from './hint.js';
import { localOffsetMinutes } from './local-clock.js';
import { voiceRegistry } from './registry.js';
import { cardReadback, renderSpeak, SPOKEN_TRIGGERS, stepCleared, type SpeakContext } from './speak.js';
import { OVER_CAP_SCAN_UNITS, VoiceUpstreamError, type UpstreamFailure, type VoiceLink, type VoiceUpstream } from './upstream.js';

/** The longest a client message may be: a 20 ms frame is 644 bytes, a speak a few hundred bytes of JSON. */
export const MAX_CLIENT_PAYLOAD = 16 * 1024;
/** An utterance's frames: MAX_UTTERANCE_MS of FRAME_MS each. One more is past the limit (`too_long`). */
const MAX_FRAMES = MAX_UTTERANCE_MS / FRAME_MS;
/** How many of this socket's own transcripts it keeps for `heard` items. */
export const TRANSCRIPTS_KEPT = 4;
/** Messages waiting while an earlier one is handled: a whole utterance of frames and some. More is no game. */
const MAX_QUEUED = MAX_FRAMES + 100;
/**
 * Fix round 1 (m10): and at most this many bytes of them (a whole utterance is under 1 MB of frames), so a client
 * cannot park MAX_QUEUED × MAX_CLIENT_PAYLOAD in memory while a listen waits on the database.
 */
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
/** Above this many bytes queued to the browser, it is not reading: the speech stops (`failed tts`). */
const MAX_BUFFERED = 512 * 1024;
/** Carry 5: at most this many utterances in flight per player, on this server (one socket per player already). */
export const MAX_UTTERANCES_PER_USER = 1;
/** Fix round 1 (m10): voice socket opens per player per minute (a game opens one per session; abuse only). */
export const VOICE_OPENS_PER_MINUTE = 30;
/** Fix round 1 (m9): the heartbeat. A peer that has not answered the last ping by the next one is terminated. */
const VOICE_PING_MS = 30_000;
const MINUTE_MS = 60_000;
/** Upstream failures that charge nothing: the service never finished hearing it (I2 ruling: down or a timeout). */
const UNCHARGED: readonly (UpstreamFailure | 'other')[] = ['down', 'timeout', 'idle', 'bad_message', 'not_ready', 'busy', 'auth', 'misrouted', 'cancelled'];

/**
 * The voice role the API names upstream is the literal `pan`; the service resolves it to its cast (apps/voice
 * session.ts). The manifest is read only to fail boot if it has no `cast.pan` for the service to resolve (m11).
 */
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
  /** The heartbeat interval (tests only; VOICE_PING_MS by default). */
  pingMs?: number;
}

type Auth = { ok: true; userId: string; token: string } | { ok: false; reason: VoiceCloseReason };

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
  /** `too_long` was sent for it (m4: never twice). */
  tooLongSent: boolean;
  /** I2: its one charge, once `end` went upstream; started once, awaited before the next listen passes (m3). */
  charge: Promise<void> | null;
  /** Its utterance slot was given back. */
  released: boolean;
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
  private queuedBytes = 0;
  private alive = true;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unregister: () => void;

  constructor(
    private readonly app: FastifyInstance,
    private readonly ws: WebSocket,
    private readonly userId: string,
    /** The session cookie, in memory only, to re-check the session before every listen and speak (I1). */
    private readonly token: string,
    private readonly deps: VoiceRouteDeps,
    private readonly role: string,
    private readonly log: FastifyBaseLogger,
  ) {
    // Ruling 17: one socket per player; an older one closes with `another_tab`. A block closes this one.
    this.unregister = voiceRegistry.add(userId, { close: (reason) => this.close(reason) });
    ws.on('message', (data: RawData, binary: boolean) => this.enqueue(data, binary));
    ws.on('close', () => this.teardown());
    ws.on('error', () => this.teardown());
    // m9: a dead peer would otherwise keep its registry entry, slot and upstream link until TCP gives up.
    ws.on('pong', () => (this.alive = true));
    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        logKind(this.log, 'voice_heartbeat_lost');
        ws.terminate();
        return this.teardown();
      }
      this.alive = false;
      ws.ping();
    }, deps.pingMs ?? VOICE_PING_MS);
    this.heartbeat.unref();
  }

  // --- the queue: one message at a time, in order (frames wait for their listen) ----------------------------------

  private enqueue(data: RawData, binary: boolean): void {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
    this.alive = true;
    if (this.closed) {
      bytes.fill(0);
      return;
    }
    const size = bytes.length;
    if (++this.queued > MAX_QUEUED || (this.queuedBytes += size) > MAX_QUEUED_BYTES) {
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
        this.queuedBytes -= size;
      });
  }

  private internal(): void {
    // An unexpected error: its message may hold anything, so it is never read or logged (Review Focus 2). The game is
    // told, with a code it knows (m7): voice is unavailable for now.
    logKind(this.log, 'voice_internal', VOICE_CLOSE_CODES.unavailable);
    this.close('unavailable');
  }

  private send(msg: ServerMsg): void {
    if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Read through a call: an await may have closed the socket meanwhile (no narrowing across awaits). */
  private isClosed(): boolean {
    return this.closed;
  }

  /** Closes with `closed { reason }` and its code (core VOICE_CLOSE_CODES). Idempotent. */
  close(reason: VoiceCloseReason): void {
    if (this.closed) return;
    this.send({ t: 'closed', reason });
    this.ws.close(VOICE_CLOSE_CODES[reason]);
    this.teardown();
  }

  /** Everything is dropped: the utterance (charged if it was ending, I2), the speech, the transcripts and the link. */
  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.abort.abort();
    void this.dropUtterance();
    this.speech = null;
    this.transcripts.clear();
    this.link?.close();
    this.link = null;
    this.unregister();
  }

  // --- utterance bookkeeping (I2, m3) ------------------------------------------------------------------------------

  /** The utterance's one charge (I2): its frames' seconds, recorded once whatever happens after. */
  private charge(u: Utterance): Promise<void> {
    const { db, now } = this.app.deps;
    u.charge ??= recordVoice(db, this.userId, 'voice_stt', u.frames * FRAME_MS, now()).catch(() => logKind(this.log, 'voice_record_failed'));
    return u.charge;
  }

  private release(u: Utterance): void {
    if (u.released) return;
    u.released = true;
    releaseSlot(this.userId);
  }

  /**
   * Drops the current utterance (cancel, replace, close). Upstream it is cancelled, so a late reply is never awaited.
   * One still listening is not charged (a cancelled utterance is not recorded); one whose `end` went upstream is (I2:
   * the service decodes it whatever we say), and the charge is written before the slot is given back (m3).
   */
  private async dropUtterance(): Promise<void> {
    const u = this.utter;
    if (u === null) return;
    this.utter = null;
    this.link?.cancel(u.upId);
    if (u.phase === 'ending') await this.charge(u);
    this.release(u);
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
        u.tooLongSent = true;
        this.send({ t: 'too_long', id: u.clientId });
        return this.finish(u);
      }
      // Counted only when forwarded: speechMs is frames forwarded × FRAME_MS (P1).
      if (this.link?.isOpen() !== true) return;
      this.link.frame(u.upId, frame.pcm);
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

  /**
   * I1: the session is still live (not signed out, revoked or expired; the account still there) and the `voice` grant
   * still current; otherwise the socket closes with `signed_out` or `consent_required`. True when still allowed.
   */
  private async stillAllowed(): Promise<boolean> {
    const { db, now } = this.app.deps;
    const at = now();
    const live = await db
      .select({ id: users.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hashToken(this.token)), eq(sessions.userId, this.userId), gt(sessions.expiresAt, at)));
    if (live.length === 0) {
      this.close('signed_out');
      return false;
    }
    if (!(await hasConsent(db, this.userId, 'voice', at))) {
      this.close('consent_required');
      return false;
    }
    return !this.isClosed();
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

  /** The player's local date now, by hello's clock (m5: steps are checked on it, as the hint's run week is). */
  private localToday(): string {
    return new Date(this.app.deps.now().getTime() + this.offset * MINUTE_MS).toISOString().slice(0, 10);
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
    if (this.isClosed()) return;
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

  private async listen(id: number): Promise<void> {
    if (this.blockedNow()) return;
    // One utterance at a time, and none goes unanswered (carry 2): a replaced one is `failed stt` at once, and its
    // upstream id is cancelled, so a late reply for it is never awaited. Its charge (if its end went upstream) is
    // written before this listen reads the allowance (m3).
    const old = this.utter;
    if (old !== null) {
      this.send({ t: 'failed', id: old.clientId, kind: 'stt' });
      await this.dropUtterance();
    }
    if (!(await this.stillAllowed())) return;
    // Carry 5: the allowance again before every utterance; the one in flight always finishes (Ruling 5).
    const state = await this.state();
    if (this.isClosed()) return;
    if (state.kind !== 'available') return this.send({ t: 'state', state });
    if (!takeSlot(this.userId)) return this.send({ t: 'failed', id, kind: 'stt' });
    let slotHeld = true;
    try {
      const link = await this.ensureLink();
      const { db, config, now } = this.app.deps;
      const hint = await sttHint(db, config.keyring, this.deps.catalog, this.userId, now(), this.localToday());
      if (this.isClosed() || this.blockedNow()) return;
      // A fresh upstream id per listen (G2): the service never sees an id twice.
      const upId = this.nextUpId++;
      link.listen(upId, hint);
      hint.length = 0;
      this.utter = { clientId: id, upId, frames: 0, phase: 'listening', tooLongSent: false, charge: null, released: false };
      slotHeld = false;
    } catch (e) {
      this.upstreamFailed(id, e, 'upstream');
    } finally {
      if (slotHeld) releaseSlot(this.userId);
    }
  }

  /**
   * The utterance ends and `end` goes upstream: from here it is charged once on any outcome but the service down or
   * slow (I2). The charge is written before the answer is sent and before the slot is given back (m3). Every utterance
   * is answered once (`too_long` at most once, m4).
   */
  private finish(u: Utterance): void {
    u.phase = 'ending';
    const link = this.link;
    const answered = link === null || !link.isOpen() ? Promise.reject(new VoiceUpstreamError('down')) : link.end(u.upId);
    void answered
      .then(
        async ({ text }) => {
          if (this.utter !== u) return; // replaced, cancelled or closed: that path answered and charged it
          await this.charge(u);
          if (this.utter !== u) return;
          this.utter = null;
          this.release(u);
          // Carry 7: what is sent must be a valid turn input (core parseTurnInput): over MAX_TEXT → too_long, never
          // cut; nothing readable → failed stt. Kept for `heard` items, never logged.
          const input = parseTurnInput({ kind: 'transcript', text });
          if (input === null) {
            if ([...text].length <= MAX_TEXT) this.send({ t: 'failed', id: u.clientId, kind: 'stt' });
            else {
              if (!u.tooLongSent) this.send({ t: 'too_long', id: u.clientId });
              this.childCheck(text.slice(0, OVER_CAP_SCAN_UNITS));
            }
            return;
          }
          this.keepTranscript(u.clientId, input.text);
          this.send({ t: 'transcript', id: u.clientId, text: input.text });
          // m-1: past MAX_UTTERANCE_MS the device takes no turn from it, so its child words are checked here.
          if (u.tooLongSent) this.childCheck(input.text);
        },
        async (e: unknown) => {
          if (this.utter !== u) return;
          const failure: UpstreamFailure | 'other' = e instanceof VoiceUpstreamError ? e.kind : 'other';
          if (!UNCHARGED.includes(failure)) {
            await this.charge(u);
            if (this.utter !== u) return;
          }
          this.utter = null;
          this.release(u);
          if (failure === 'too_long') {
            if (!u.tooLongSent) this.send({ t: 'too_long', id: u.clientId });
            if (e instanceof VoiceUpstreamError && e.overCap !== undefined) this.childCheck(e.overCap);
          } else this.upstreamFailed(u.clientId, e, 'upstream');
        },
      )
      .catch(() => logKind(this.log, 'voice_answer_failed'));
  }

  /**
   * M7 Step 10 fix round 5 (F4-1 child half, m-1; controller ruling): a transcript the device will not send as a turn
   * (refused as too long, or after `too_long`) is scanned whole, uncapped, with core's child detection, as the
   * device's own over-long scan reads it. A child sets the per-user block and closes every socket of the user
   * (Ruling 17), as a child flag set by a turn does. Nothing is kept or logged. The emergency half needs a protocol
   * field (core, hashed): carried to Step 11.
   */
  private childCheck(text: string): void {
    const full = normalizeText(stripPageEventsFull(text).text);
    if (CHILD_PATTERNS.some((p) => p.test(full))) voiceRegistry.childFlagged(this.userId, this.app.deps.now().getTime());
  }

  private keepTranscript(id: number, text: string): void {
    this.transcripts.delete(id);
    this.transcripts.set(id, text);
    while (this.transcripts.size > TRANSCRIPTS_KEPT) this.transcripts.delete(this.transcripts.keys().next().value!);
  }

  private async cancel(id: number): Promise<void> {
    if (this.speech?.clientId === id) {
      const s = this.speech;
      this.speech = null;
      this.link?.cancel(s.upId);
    }
    if (this.utter?.clientId === id) await this.dropUtterance();
  }

  private async speak(id: number, items: Parameters<typeof renderSpeak>[0]): Promise<void> {
    if (this.blockedNow()) return;
    if (!(await this.stillAllowed())) return;
    const state = await this.state();
    if (this.isClosed()) return;
    if (state.kind !== 'available') return this.send({ t: 'state', state });
    const { db, config, now } = this.app.deps;
    const recipes = await this.deps.recipes.current(db);
    const today = this.localToday();
    const ctx: SpeakContext = {
      userId: this.userId,
      bank: this.deps.bank,
      catalog: this.deps.catalog,
      lastTranscript: (utteranceId) => this.transcripts.get(utteranceId) ?? null,
      card: (proposalId) => cardReadback(db, config.keyring, this.userId, proposalId),
      // m5: the socket's own date (hello's clock), not the one the item carries.
      stepOk: (slug) => stepCleared(db, { keyring: config.keyring, catalog: this.deps.catalog, recipes }, this.userId, slug, today, now()),
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
    if (this.isClosed()) return;
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
 * `consent_required`; more than VOICE_OPENS_PER_MINUTE opens a minute → HTTP 429 before the upgrade. Then the
 * protocol (core ClientMsg / ServerMsg): `hello` (with the player's clock; a Family Table report or the per-user block
 * closes it), `listen` / frames / `end` → `transcript`, `cancel`, `speak` → `audio_start` / frames / `audio_end`. The
 * session and the grant are re-checked before every listen and speak (I1). The upstream down → `failed { kind:
 * 'upstream' }`, and the socket stays open.
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
  const opens = new SlidingWindowLimiter(VOICE_OPENS_PER_MINUTE, 60_000);
  const stopSweeping = sweepPeriodically([opens], () => app.deps.now().getTime());
  app.addHook('onClose', (_app, done) => {
    stopSweeping();
    done();
  });

  const authorise = async (req: FastifyRequest, reply: FastifyReply): Promise<Auth> => {
    const origin = req.headers.origin;
    // Cross-site WebSocket hijacking: the browser always sends Origin; a missing one is no browser of ours.
    if (typeof origin !== 'string' || origin.toLowerCase() !== appOrigin) return { ok: false, reason: 'bad_origin' };
    try {
      await requireUser(req, reply);
    } catch (e) {
      // Only "no live session" is signed out; anything else (the database down) is a 500, logged by kind (app.ts).
      if (e instanceof ApiError && e.status === 401) return { ok: false, reason: 'signed_out' };
      throw e;
    }
    const t = app.deps.now().getTime();
    const wait = opens.waitMs(req.user.id, t);
    if (wait > 0) {
      reply.header('retry-after', String(Math.ceil(wait / 1000)));
      throw new ApiError(429, 'rate_limited', 'Too many requests; try again shortly', { retryAfterSeconds: Math.ceil(wait / 1000) });
    }
    opens.hit(req.user.id, t);
    if (app.deps.config.voice === null) return { ok: false, reason: 'unavailable' };
    if (!(await hasConsent(app.deps.db, req.user.id, 'voice', app.deps.now()))) return { ok: false, reason: 'consent_required' };
    const token: unknown = req.cookies[SESSION_COOKIE];
    if (!isTokenShaped(token)) return { ok: false, reason: 'signed_out' };
    return { ok: true, userId: req.user.id, token };
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
      new VoiceSocket(app, socket, auth.userId, auth.token, deps, role, req.log);
    },
  );
}

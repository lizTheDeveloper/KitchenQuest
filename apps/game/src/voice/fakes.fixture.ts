// Test doubles for the browser's audio and socket APIs (M7 Step 8). Never a real microphone or network (Global
// Constraints): every test drives these by hand.
interface FakeTrack { stopped: boolean; stop(): void }

class FakePort {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  close() { this.closed = true; }
  /** The worklet sends a frame. */
  emit(pcm: Int16Array, db: number) { if (!this.closed) this.onmessage?.({ data: { pcm, db } }); }
}

export interface FakeAudio {
  win: Window;
  getUserMedia: { calls: MediaStreamConstraints[] };
  tracks: FakeTrack[];
  contexts: FakeAudioContext[];
  nodes: { port: FakePort; disconnected: boolean }[];
  /** Fails the next getUserMedia (the player said no) or addModule. */
  fail: { gum?: Error; addModule?: Error };
  /** Contexts made from now on start suspended. */
  startSuspended?: boolean;
  /** Their resume() never settles (no user activation: Web Audio keeps it pending). */
  resumeHangs?: boolean;
  /** Holds getUserMedia until `release()`. */
  hold(): () => void;
}

class FakeSource {
  started: number | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  buffer: { duration: number } | null = null;
  constructor(private readonly ctx: FakeAudioContext) {}
  connect() {}
  disconnect() {}
  start(at = 0) { this.started = at; this.ctx.sources.push(this); }
  stop() { if (this.stopped) return; this.stopped = true; this.onended?.(); }
  /** The source plays to its end. */
  finish() { if (!this.stopped) { this.stopped = true; this.onended?.(); } }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  sampleRate = 48_000;
  state: 'running' | 'suspended' | 'closed' = 'running';
  resumed = 0;
  destination = {};
  sources: FakeSource[] = [];
  modules: string[] = [];
  failAddModule: Error | undefined;
  audioWorklet = { addModule: (url: string) => { this.modules.push(url); return this.failAddModule ? Promise.reject(this.failAddModule) : Promise.resolve(); } };
  constructor() { FakeAudioContext.instances.push(this); }
  createMediaStreamSource() { return { connect: () => undefined, disconnect: () => undefined }; }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { duration: length / sampleRate, length, sampleRate, getChannelData: () => data };
  }
  createBufferSource() { return new FakeSource(this); }
  createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  hangResume = false;
  resume() { this.resumed++; if (this.hangResume) return new Promise<void>(() => undefined); this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

export function fakeAudio(extra: Record<string, unknown> = {}): FakeAudio {
  const out: FakeAudio = {
    win: undefined as unknown as Window,
    getUserMedia: { calls: [] },
    tracks: [],
    contexts: [],
    nodes: [],
    fail: {},
    hold: () => () => undefined,
  };
  let gate: Promise<void> | null = null;
  out.hold = () => {
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    return () => { gate = null; open(); };
  };
  class Ctx extends FakeAudioContext {
    constructor() {
      super();
      out.contexts.push(this);
      if (out.startSuspended) this.state = 'suspended';
      if (out.resumeHangs) this.hangResume = true;
      if (out.fail.addModule) this.failAddModule = out.fail.addModule;
    }
  }
  class Node {
    port = new FakePort();
    disconnected = false;
    constructor() { out.nodes.push(this); }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  const getUserMedia = async (c: MediaStreamConstraints) => {
    out.getUserMedia.calls.push(c);
    if (gate) await gate;
    if (out.fail.gum) throw out.fail.gum;
    const tracks: FakeTrack[] = [0, 1].map((): FakeTrack => ({ stopped: false, stop() { this.stopped = true; } }));
    out.tracks.push(...tracks);
    return { getTracks: () => tracks };
  };
  out.win = { navigator: { mediaDevices: { getUserMedia } }, AudioContext: Ctx, AudioWorkletNode: Node, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t), ...extra } as unknown as Window;
  return out;
}

/** A WebSocket the test plays the server for. */
export class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(data: string | ArrayBufferView) {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(typeof data === 'string' ? data : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.closedWith = code;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  // --- the server's side ---
  open() { this.readyState = 1; this.onopen?.(); }
  serverSend(msg: unknown) { this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }); }
  serverBinary(bytes: Uint8Array) { this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code }); }
  /** The JSON messages sent, parsed. */
  json(): Record<string, unknown>[] { return this.sent.filter((m): m is string => typeof m === 'string').map((m) => JSON.parse(m) as Record<string, unknown>); }
  frames(): Uint8Array[] { return this.sent.filter((m): m is Uint8Array => typeof m !== 'string'); }
}

/** A window with a fake WebSocket constructor and a page origin. */
export function socketWin(base: Partial<Record<string, unknown>> = {}): { win: Window; sockets: FakeWebSocket[] } {
  const sockets: FakeWebSocket[] = [];
  class WS extends FakeWebSocket { constructor(url: string) { super(url); sockets.push(this); } }
  const win = {
    location: { protocol: 'https:', host: 'kq.example' },
    WebSocket: WS,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    ...base,
  } as unknown as Window;
  return { win, sockets };
}

// M7 spec §9: the voice service's configuration, from the environment. Every model must be `allowed` in the licence
// manifest (Ruling 2); production also refuses the fake engine, a short token and a model with no recorded files.
import { isIP } from 'node:net';
import { availableParallelism } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedModel, castable, type ModelEntry, type VoiceManifest } from './models.js';

export interface VoiceConfig {
  production: boolean;
  port: number;
  /** VOICE_SERVICE_TOKEN: the bearer secret the API presents. Never logged. */
  token: Buffer;
  engine: 'worker' | 'fake';
  sttModel: string;
  /** The Pan's voice: a TTS model and one of its voices. */
  cast: { model: string; voice: string };
  maxConnections: number;
  /** VOICE_HOST: the address the service binds, loopback or private only (C-38). */
  host: string;
  /** VOICE_WORKER_ENGINE (Step 3): `real` engines, or the stdlib-only `echo` engine for dev and CI. */
  workerEngine: 'echo' | 'real';
  /** VOICE_MODELS_DIR: where the pinned model files are; a relative path is under the repo root. */
  modelsDir: string;
  /** VOICE_PYTHON: the interpreter the workers run on (the operator's venv in production). */
  python: string;
  /** VOICE_WORKERS: worker processes per engine (STT and TTS each). */
  workers: number;
  /** VOICE_ACCEPT_LATENCY_MISS: the date of a benchmark miss the founder accepted (Ruling 3). */
  acceptLatencyMiss: string | undefined;
}

const DEFAULT_PORT = 3100;
const DEFAULT_STT = 'faster-whisper-base.en';
const DEFAULT_MAX_CONNECTIONS = 50;
const MIN_PRODUCTION_TOKEN_BYTES = 32;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MODELS_DIR = 'apps/voice/models';
const MAX_WORKERS = 64;
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * C-38: an IP literal on loopback or a private network: 127/8, 10/8, 172.16/12, 192.168/16, 100.64/10 (carrier-grade
 * NAT, as private overlays use), ::1 and fc00::/7. Never the wildcard, a public address or a hostname.
 */
function isPrivateAddress(host: string): boolean {
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const h = host.toLowerCase();
    return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h);
  }
  return false;
}

function intVar(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a whole number`);
  const n = Number(raw.trim());
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

const value = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

export function loadVoiceConfig(env: NodeJS.ProcessEnv, manifest: VoiceManifest): VoiceConfig {
  const production = env.NODE_ENV === 'production';
  // Fix round 1 (M8): never 0, a random port the API could never find. Tests pass a config, not an env.
  const port = intVar(env, 'VOICE_PORT', DEFAULT_PORT, 1, 65_535);
  const maxConnections = intVar(env, 'VOICE_MAX_CONNECTIONS', DEFAULT_MAX_CONNECTIONS, 1, 10_000);

  const rawToken = env.VOICE_SERVICE_TOKEN ?? '';
  if (rawToken === '') throw new Error('VOICE_SERVICE_TOKEN is required: the secret the API presents (openssl rand -base64 32)');
  const token = Buffer.from(rawToken, 'utf8');
  if (production && token.length < MIN_PRODUCTION_TOKEN_BYTES) throw new Error(`VOICE_SERVICE_TOKEN must be at least ${MIN_PRODUCTION_TOKEN_BYTES} bytes in production`);

  const engine = value(env, 'VOICE_ENGINE') ?? 'fake';
  if (engine !== 'worker' && engine !== 'fake') throw new Error('VOICE_ENGINE must be worker or fake');
  if (production && engine === 'fake') throw new Error('VOICE_ENGINE=fake is refused in production');

  const sttModel = value(env, 'VOICE_STT_MODEL') ?? DEFAULT_STT;
  const stt = named('VOICE_STT_MODEL', () => allowedModel(manifest, sttModel, 'stt'));
  const cast = { model: value(env, 'VOICE_TTS_MODEL') ?? manifest.cast.pan.model, voice: value(env, 'VOICE_PAN_VOICE') ?? manifest.cast.pan.voice };
  const tts = named('VOICE_TTS_MODEL', () => castable(manifest, cast.model, cast.voice));

  if (production) requireFiles([tts, stt]);

  const host = value(env, 'VOICE_HOST') ?? DEFAULT_HOST;
  if (!isPrivateAddress(host)) throw new Error('VOICE_HOST must be a loopback or private IP address (C-38), never 0.0.0.0, a public address or a hostname');
  const workerEngine = value(env, 'VOICE_WORKER_ENGINE') ?? 'real';
  if (workerEngine !== 'echo' && workerEngine !== 'real') throw new Error('VOICE_WORKER_ENGINE must be echo or real');
  if (production && workerEngine === 'echo') throw new Error('VOICE_WORKER_ENGINE=echo is refused in production');
  const dir = value(env, 'VOICE_MODELS_DIR') ?? DEFAULT_MODELS_DIR;
  const modelsDir = isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir);
  const python = value(env, 'VOICE_PYTHON') ?? 'python3';
  const workers = intVar(env, 'VOICE_WORKERS', Math.min(MAX_WORKERS, availableParallelism()), 1, MAX_WORKERS);
  const acceptLatencyMiss = value(env, 'VOICE_ACCEPT_LATENCY_MISS');
  if (acceptLatencyMiss !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(acceptLatencyMiss)) throw new Error('VOICE_ACCEPT_LATENCY_MISS must be the YYYY-MM-DD date of the benchmark run it accepts');

  return { production, port, token, engine, sttModel, cast, maxConnections, host, workerEngine, modelsDir, python, workers, acceptLatencyMiss };
}

function named(variable: string, check: () => ModelEntry): ModelEntry {
  try {
    return check();
  } catch (e) {
    throw new Error(`${variable}: ${(e as Error).message}`);
  }
}

function requireFiles(models: ModelEntry[]): void {
  const empty = models.filter((m) => m.files.length === 0).map((m) => m.id);
  if (empty.length > 0) throw new Error(`voice model ${empty.join(', ')}: no files recorded in data/voice-models.json; production needs them pinned`);
}

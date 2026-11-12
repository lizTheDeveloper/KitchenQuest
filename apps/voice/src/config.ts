// M7 spec §9: the voice service's configuration, from the environment. Every model must be `allowed` in the licence
// manifest (Ruling 2); production also refuses the fake engine, a short token and a model with no recorded files.
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
}

const DEFAULT_PORT = 3100;
const DEFAULT_STT = 'faster-whisper-base.en';
const DEFAULT_MAX_CONNECTIONS = 50;
const MIN_PRODUCTION_TOKEN_BYTES = 32;

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
  const port = intVar(env, 'VOICE_PORT', DEFAULT_PORT, 0, 65_535);
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

  return { production, port, token, engine, sttModel, cast, maxConnections };
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
  if (empty.length > 0) throw new Error(`voice model ${empty.join(', ')}: no files recorded in data/voice-models.json; production needs them (M7 Step 3)`);
}

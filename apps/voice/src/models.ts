// M7 Rulings 2 and 14: the checked licence manifest, data/voice-models.json. Every speech model and engine the service
// may load is listed with its licence; nothing that is not `allowed` can be cast or configured.
import { readFileSync } from 'node:fs';

export interface ModelEntry {
  id: string;
  kind: 'stt' | 'tts';
  engine: string;
  source: string;
  licence: string;
  commercial: boolean;
  attribution: string | null;
  status: 'allowed' | 'excluded' | 'unverified';
  reason?: string;
  voices?: string[];
  files: { path: string; sha256: string }[];
}

export interface EngineEntry {
  id: string;
  licence: string;
  boundary: 'in-process' | 'in-worker-process' | 'separate-process';
  /** The licence is still to be re-checked against the published package. */
  verify?: boolean;
}

type CastEntry = { model: string; voice: string };

export interface VoiceManifest {
  models: ModelEntry[];
  engines: EngineEntry[];
  /** The CPU default (C1): Piper northern_english_male. */
  cast: { pan: CastEntry };
  /** Once on GPU: Kokoro bm_fable. */
  gpuCast: { pan: CastEntry };
}

/** SPDX ids a model may carry and still be cast. Never an NC or ND licence. */
export const ALLOWED_LICENCES: ReadonlySet<string> = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC-BY-4.0', 'CC-BY-SA-4.0']);

const MANIFEST_URL = new URL('../../../data/voice-models.json', import.meta.url);

export function loadManifest(file: URL = MANIFEST_URL): VoiceManifest {
  return parseManifest(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isStrList = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);

function bad(what: string): never {
  throw new Error(`data/voice-models.json: ${what}`);
}

function parseModel(x: unknown, i: number): ModelEntry {
  if (!isObj(x)) bad(`models[${i}] is not an object`);
  const where = `models[${i}] (${String(x.id)})`;
  if (!isStr(x.id)) bad(`models[${i}] has no id`);
  if (x.kind !== 'stt' && x.kind !== 'tts') bad(`${where}: kind must be stt or tts`);
  if (!isStr(x.engine) || !isStr(x.source) || !isStr(x.licence)) bad(`${where}: engine, source and licence are required`);
  if (typeof x.commercial !== 'boolean') bad(`${where}: commercial must be a boolean`);
  if (x.attribution !== null && !isStr(x.attribution)) bad(`${where}: attribution must be a string or null`);
  if (x.status !== 'allowed' && x.status !== 'excluded' && x.status !== 'unverified') bad(`${where}: unknown status ${String(x.status)}`);
  if (x.reason !== undefined && !isStr(x.reason)) bad(`${where}: reason must be a string`);
  if (x.voices !== undefined && !isStrList(x.voices)) bad(`${where}: voices must be a list of names`);
  if (!Array.isArray(x.files)) bad(`${where}: files must be a list`);
  const files = (x.files as unknown[]).map((f, j) => {
    if (!isObj(f) || !isStr(f.path) || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) bad(`${where}: files[${j}] needs a path and a sha256`);
    return { path: f.path, sha256: f.sha256 };
  });
  return {
    id: x.id,
    kind: x.kind,
    engine: x.engine,
    source: x.source,
    licence: x.licence,
    commercial: x.commercial,
    attribution: x.attribution,
    status: x.status,
    ...(x.reason === undefined ? {} : { reason: x.reason }),
    ...(x.voices === undefined ? {} : { voices: [...x.voices] }),
    files,
  };
}

function parseEngine(x: unknown, i: number): EngineEntry {
  if (!isObj(x) || !isStr(x.id) || !isStr(x.licence)) bad(`engines[${i}] needs an id and a licence`);
  if (x.boundary !== 'in-process' && x.boundary !== 'in-worker-process' && x.boundary !== 'separate-process') bad(`engines[${i}] (${x.id}): unknown boundary`);
  if (x.verify !== undefined && typeof x.verify !== 'boolean') bad(`engines[${i}] (${x.id}): verify must be a boolean`);
  return { id: x.id, licence: x.licence, boundary: x.boundary, ...(x.verify === undefined ? {} : { verify: x.verify }) };
}

function parseCast(x: unknown, name: string): { pan: CastEntry } {
  if (!isObj(x) || !isObj(x.pan) || !isStr(x.pan.model) || !isStr(x.pan.voice)) bad(`${name}.pan needs a model and a voice`);
  return { pan: { model: x.pan.model, voice: x.pan.voice } };
}

/** The manifest, checked for shape. Licensing rules are enforced by castable, loadVoiceConfig and licences.test.ts. */
export function parseManifest(x: unknown): VoiceManifest {
  if (!isObj(x) || !Array.isArray(x.models) || !Array.isArray(x.engines)) bad('needs models and engines lists');
  const models = (x.models as unknown[]).map(parseModel);
  const engines = (x.engines as unknown[]).map(parseEngine);
  const ids = new Set<string>();
  for (const m of models) {
    if (ids.has(m.id)) bad(`model ${m.id} is listed twice`);
    ids.add(m.id);
  }
  return { models, engines, cast: parseCast(x.cast, 'cast'), gpuCast: parseCast(x.gpuCast, 'gpuCast') };
}

/** The manifest entry for an allowed model, of `kind`; throws naming the model otherwise. */
export function allowedModel(m: VoiceManifest, model: string, kind: 'stt' | 'tts'): ModelEntry {
  const entry = m.models.find((x) => x.id === model);
  if (!entry) throw new Error(`voice model ${model} is not in data/voice-models.json`);
  if (entry.status !== 'allowed') throw new Error(`voice model ${model} is ${entry.status}${entry.reason ? ` (${entry.reason})` : ''} and cannot be used`);
  if (!ALLOWED_LICENCES.has(entry.licence) || !entry.commercial) throw new Error(`voice model ${model}: licence ${entry.licence} is not allowed for commercial use`);
  if (entry.kind !== kind) throw new Error(`voice model ${model} is a ${entry.kind} model, not ${kind}`);
  return entry;
}

/** The TTS model entry for a cast (model, voice): throws unless the model is allowed and lists the voice. */
export function castable(m: VoiceManifest, model: string, voice: string): ModelEntry {
  const entry = allowedModel(m, model, 'tts');
  if (!entry.voices?.includes(voice)) throw new Error(`voice model ${model} has no voice ${voice}`);
  return entry;
}

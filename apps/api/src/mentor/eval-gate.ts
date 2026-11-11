import { existsSync, readFileSync } from 'node:fs';
import type { AiConfig } from '../ai/openrouter.js';
import { loadPanBank } from './lines.js';
import { loadPanPrompt, promptFingerprint } from './prompt.js';
import { MENTOR_TOOLS } from './tools.js';

/** The recorded passing eval (`npm run eval:mentor` writes it; spec §7.6b.9). */
export const LAST_PASS = new URL('../../eval/last-pass.json', import.meta.url);

/**
 * M4 final I-3: the eval gate at production boot. The CI gate proves only that the repo's defaults were evaluated;
 * this compares the LIVE config (model, provider order, prompt, tools, request parameters) with the recorded
 * passing eval. On a mismatch (or no record) the AI stays off: the scripted mentor answers every turn, as with the
 * DPA gate (fail closed, never a refused boot). Outside production the config is returned as is. The warning is
 * content-free: the two fingerprints and the model and providers, never a prompt.
 */
export function evaluatedAi(
  ai: AiConfig | null,
  nodeEnv: string | undefined,
  log: { error: (obj: object, msg: string) => void },
  lastPass: URL = LAST_PASS,
): AiConfig | null {
  if (ai === null || nodeEnv !== 'production') return ai;
  const live = promptFingerprint(loadPanPrompt(loadPanBank()), MENTOR_TOOLS, ai.model, ai.providers);
  let recorded: string | null = null;
  try {
    if (existsSync(lastPass)) recorded = (JSON.parse(readFileSync(lastPass, 'utf8')) as { fingerprint?: unknown }).fingerprint as string;
  } catch {
    recorded = null;
  }
  if (recorded === live) return ai;
  log.error(
    { ai: 'eval_gate', live, recorded, model: ai.model, providers: ai.providers },
    'AI OFF: the live AI config (model, providers, prompt, tools or request parameters) was never evaluated; run `npm run eval:mentor` with this config and deploy its eval/last-pass.json (spec §7.6b.9)',
  );
  return null;
}

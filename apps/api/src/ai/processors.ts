import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * P-11 / N-9: no processor receives user data until its DPA is signed. The
 * register is docs/compliance/processors.json, read at call time so a signed
 * DPA needs no code change. config.ts calls this before AI can be enabled in production.
 */
export const AI_PROCESSOR_IDS = ['openrouter', 'openrouter-model-providers'] as const;

const REGISTER = new URL('../../../../docs/compliance/processors.json', import.meta.url);

const Register = z.object({
  processors: z.array(z.object({ id: z.string(), dpa_status: z.string() }).loose()),
});

/**
 * The ids whose `dpa_status` is not "signed". An id missing from the register,
 * or a register that cannot be read or parsed, counts as not ready (fail closed).
 */
export function processorsNotReady(ids: readonly string[], registerPath: URL = REGISTER): string[] {
  let signed: Set<string>;
  try {
    const doc = Register.parse(JSON.parse(readFileSync(registerPath, 'utf8')));
    signed = new Set(doc.processors.filter((p) => p.dpa_status === 'signed').map((p) => p.id));
  } catch {
    return [...ids];
  }
  return ids.filter((id) => !signed.has(id));
}

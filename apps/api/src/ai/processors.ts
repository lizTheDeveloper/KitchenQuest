import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * P-11 / N-9: no processor receives user data until its DPA is signed. The
 * register is docs/compliance/processors.json, read at call time so a signed
 * DPA needs no code change. config.ts calls this, with the processor ids a feature sends data to, before that
 * feature can be enabled in production: AI (AI_PROCESSOR_IDS) and, M7 Step 5 (B5), live voice (VOICE_PROCESSOR_IDS).
 */
export const AI_PROCESSOR_IDS = ['openrouter', 'openrouter-model-providers'] as const;
/** M7: the self-hosted voice service runs on the hosting provider's boxes, which then hold audio in memory (C-18). */
export const VOICE_PROCESSOR_IDS = ['hetzner'] as const;

/** The register as committed; config.ts takes another path in tests only. */
export const PROCESSORS_REGISTER = new URL('../../../../docs/compliance/processors.json', import.meta.url);


const Register = z.object({
  processors: z.array(z.object({ id: z.string(), dpa_status: z.string() }).loose()),
});

/**
 * The processor ids among `ids` (any processor, B5) whose `dpa_status` is not "signed". An id missing from the register,
 * or a register that cannot be read, parsed or has a duplicated id, counts as
 * not ready (fail closed).
 */
export function processorsNotReady(ids: readonly string[], registerPath: URL = PROCESSORS_REGISTER): string[] {
  let signed: Set<string>;
  try {
    const doc = Register.parse(JSON.parse(readFileSync(registerPath, 'utf8')));
    // A duplicated id makes the register ambiguous: treat it as malformed.
    if (new Set(doc.processors.map((p) => p.id)).size !== doc.processors.length) return [...ids];
    signed = new Set(doc.processors.filter((p) => p.dpa_status === 'signed').map((p) => p.id));
  } catch {
    return [...ids];
  }
  return ids.filter((id) => !signed.has(id));
}

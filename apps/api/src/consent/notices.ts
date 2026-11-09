import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ConsentPurpose } from './ledger.js';

export interface Notice {
  version: string;
  /** Exactly what the player is shown; its SHA-256 is stored with each grant. */
  text: string;
}

const NOTICE_TEXT = /<!-- notice-text:start -->\n\n([\s\S]+?)\n\n<!-- notice-text:end -->/;
const DECLARED_SHA256 = /^- SHA-256 of the notice text: `([0-9a-f]{64})`$/m;

/**
 * A notice kept as a versioned file, `docs/compliance/notices/<purpose>-<version>.md`:
 * its text is what lies between the `notice-text` markers, exactly, and the
 * file declares that text's SHA-256. Read at import, so a missing file, a
 * malformed one, or text edited without a new version stops the server at boot.
 */
function noticeFile(purpose: ConsentPurpose, version: string): Notice {
  const file = new URL(`../../../../docs/compliance/notices/${purpose}-${version}.md`, import.meta.url);
  const doc = readFileSync(file, 'utf8');
  const text = NOTICE_TEXT.exec(doc)?.[1];
  if (!text)
    throw new Error(`${file.pathname}: no text between <!-- notice-text:start --> and <!-- notice-text:end -->`);
  const declared = DECLARED_SHA256.exec(doc)?.[1];
  const actual = noticeSha256({ version, text }).toString('hex');
  if (declared !== actual) {
    throw new Error(
      `${file.pathname}: the notice text's SHA-256 is ${actual}, but the file declares ${declared ?? 'none'}; changed text needs a new version`,
    );
  }
  return { version, text };
}

/**
 * The current consent notice per purpose (C-1). A grant must name the current
 * version, so the ledger records exactly which text the player agreed to.
 * Changing a text means a new version. `health_data` is v1, read from its
 * file (N-7: it names religious and cultural diets); the others are still
 * inline. `research` is reserved and has no notice, so it cannot be granted.
 * DRAFT wording, pending lawyer review (C-30).
 */
export const NOTICES: Partial<Record<ConsentPurpose, Notice>> = {
  health_data: noticeFile('health_data', 'v1'),
  ai_health: {
    version: '2026-11-09',
    text:
      'Let the AI characters see your allergies and diet rules so their suggestions fit you. Only what a reply ' +
      'needs is sent, without your email or name, to an AI provider that may not keep or train on it. Without ' +
      'this, the AI works without your rules and every suggestion is still checked against them on our side.',
  },
  voice: {
    version: '2026-11-09',
    text:
      'Use your microphone to talk to the cooks. Your voice is turned into text on our own servers; we do not ' +
      'keep the audio.',
  },
  pantry_location: {
    version: '2026-11-09',
    text: 'Share your country and region with the Pantry so you see ingredients and posts from near you. Never your exact location.',
  },
};

export function noticeSha256(n: Notice): Buffer {
  return createHash('sha256').update(n.text, 'utf8').digest();
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CONSENT_PURPOSES } from '../db/schema.js';

// From the schema, not ledger.ts, which imports this module.
type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

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
 * Changing a text means a new version. `health_data` is v3 (M5 Step 7: it adds
 * margin notes and the weekly plan and market list; v2 named the meals kept and the 30-day Pan conversations, C-12;
 * v1 named religious and cultural diets, N-7), `ai_health` is v1 (it names the Pan, meals and the
 * scripted fallback) and `voice` is v1 (M7 Step 4, C-18: the microphone's use, speech turned into text on our own EU
 * servers and never stored, no voiceprint, kept only as conversation text, text always works, never for children),
 * each read from its file; `pantry_location` is still inline.
 * `research` is reserved and has no notice, so it cannot be granted.
 * DRAFT wording, pending lawyer review (C-30).
 */
export const NOTICES: Partial<Record<ConsentPurpose, Notice>> = {
  health_data: noticeFile('health_data', 'v3'),
  ai_health: noticeFile('ai_health', 'v1'),
  voice: noticeFile('voice', 'v1'),
  pantry_location: {
    version: '2026-11-09',
    text: 'Share your country and region with the Pantry so you see ingredients and posts from near you. Never your exact location.',
  },
};

/**
 * The notice versions whose grants still count, per purpose. A purpose listed
 * here counts only grants under one of these versions: when its notice changes
 * in substance (health_data v3 names margin notes and plans, v2 the meals and Pan conversations kept;
 * ai_health v1 names the Pan and meals; voice v1 says no voiceprint is made and what is kept), older grants stop counting and the
 * player is asked again
 * (`needsReconsent` in GET /me/consents). A purpose not listed counts a grant
 * under any version. Keep the current version in the list.
 */
const ACCEPTED_VERSIONS: Partial<Record<ConsentPurpose, readonly string[]>> = {
  health_data: ['v3'],
  ai_health: ['v1'],
  voice: ['v1'],
};

/** The versions that count for `purpose`, or `undefined` when any version does. */
export function acceptedVersions(purpose: ConsentPurpose): readonly string[] | undefined {
  return ACCEPTED_VERSIONS[purpose];
}

export function noticeSha256(n: Notice): Buffer {
  return createHash('sha256').update(n.text, 'utf8').digest();
}

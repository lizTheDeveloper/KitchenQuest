import { createHash } from 'node:crypto';
import type { ConsentPurpose } from './ledger.js';

export interface Notice {
  version: string;
  /** Exactly what the player is shown; its SHA-256 is stored with each grant. */
  text: string;
}

/**
 * The current consent notice per purpose (C-1). A grant must name the current
 * version, so the ledger records exactly which text the player agreed to.
 * Changing a text means a new version. `research` is reserved and has no
 * notice, so it cannot be granted. DRAFT wording, pending lawyer review (C-30).
 */
export const NOTICES: Partial<Record<ConsentPurpose, Notice>> = {
  health_data: {
    version: '2026-11-09',
    text:
      'Kitchen Quest can store your allergies, diet rules and, later, your food journeys, symptoms and meal logs, ' +
      'so it can check recipes for you. This is health information. We encrypt it, never sell it, never use it ' +
      'for ads, and never share it with an employer, school or insurer. You can withdraw this at any time, and ' +
      'you can play without it.',
  },
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

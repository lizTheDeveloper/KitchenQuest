import { eq } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import { hasConsent, lockConsentIn } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { openFor, sealFor, type SealContext } from '../crypto/userkeys.js';
import { VOICE_SETTINGS_PLAIN_BYTES, voiceSettings } from '../db/schema.js';
import type { Db } from '../types.js';

/**
 * P-5 (M7 Step 4, README Ruling 6, C-19): the player's self-declared accessibility need for voice. Health data (it
 * implies a disability, GDPR Art. 9, WA MHMDA): sealed S-U, written only under `health_data`, exported, erased by a
 * `health_data` withdraw-with-delete and by account delete. No proof is asked (business doc §B.11). It never reaches a
 * prompt, a log, an audit event or analytics, and it reads no entitlement (it is not one: the plain
 * `accessibility_voice` entitlement is retired).
 */

/** One row per player, so the row id is the user id. */
const sealContext = (userId: string): SealContext => ({ table: 'voice_settings', userId, rowId: userId });

/** The sealed value: `{ accessibility }` and a pad, so `true` and `false` seal to one length (B4). */
interface Stored {
  accessibility: boolean;
  pad: string;
}

function stored(accessibility: boolean): Stored {
  const bare = JSON.stringify({ accessibility, pad: '' }).length;
  if (bare > VOICE_SETTINGS_PLAIN_BYTES) throw new Error('voice_settings: the value outgrew VOICE_SETTINGS_PLAIN_BYTES');
  return { accessibility, pad: ' '.repeat(VOICE_SETTINGS_PLAIN_BYTES - bare) };
}

async function opened(db: Pick<Db, 'select'>, keyring: Keyring, userId: string, sealed: Buffer): Promise<boolean> {
  const v = await openFor<Partial<Stored> | null>(db, keyring, sealContext(userId), sealed);
  if (typeof v?.accessibility !== 'boolean') throw new Error('voice_settings: the sealed value is malformed');
  return v.accessibility;
}

/** The stored setting; `false` when the player never touched it (no row). Throws on a blob that won't open. */
export async function readAccessibility(db: Pick<Db, 'select'>, keyring: Keyring, userId: string): Promise<boolean> {
  const row = (await db.select({ sealed: voiceSettings.sealed }).from(voiceSettings).where(eq(voiceSettings.userId, userId))).at(0);
  return row === undefined ? false : opened(db, keyring, userId, row.sealed);
}

/**
 * Whether the need counts at `now` (`on`): the stored setting, read only while `health_data` is in force. After a
 * "keep" withdrawal the row stays but is not used, so the player has the free allowance (Ruling 6: declining
 * `health_data` means the free allowance), and the blob is not even opened. `read` says whether the health data was
 * looked at (consent in force), so a route can count the player's self-read (C-5).
 */
export async function accessibilityInForce(db: Pick<Db, 'select'>, keyring: Keyring, userId: string, now: Date): Promise<{ on: boolean; read: boolean }> {
  if (!(await hasConsent(db, userId, 'health_data', now))) return { on: false, read: false };
  return { on: await readAccessibility(db, keyring, userId), read: true };
}

/**
 * Turns the need on or off. One transaction in the README lock order: the live user (401 when the account is gone),
 * then the `health_data` grant, share-locked (403 `consent_required` without it; a concurrent withdraw-with-delete
 * then waits and erases this row too), then the row. The row is upserted with the value sealed, `false` included:
 * it is kept when off (B4), so its existence reveals nothing. The audit event is the neutral `voice.settings`, with no
 * value and no target (fix round 1, m5: the action name itself says nothing about a disability accommodation).
 * Turning it off needs `health_data` too: after a "keep" withdrawal the kept row is not read anyway, and the way to
 * remove it is a withdraw-with-delete (m8; Step 9's copy offers that, not an "off" toggle, in that state).
 */
export async function setAccessibility(db: Db, keyring: Keyring, userId: string, on: boolean, now: Date, requestId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockLiveUser(tx, userId);
    await lockConsentIn(tx, userId, 'health_data', now);
    const sealed = await sealFor(tx, keyring, sealContext(userId), stored(on), now);
    await tx
      .insert(voiceSettings)
      .values({ userId, sealed, updatedAt: now })
      .onConflictDoUpdate({ target: voiceSettings.userId, set: { sealed, updatedAt: now } });
    await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'voice.settings', requestId }, now);
  });
}

/** For the export (C-7): the setting decrypted with when it was last set, or null when the player never touched it. */
export async function loadVoiceSettingsForExport(tx: Pick<Db, 'select'>, keyring: Keyring, userId: string): Promise<{ accessibility: boolean; updatedAt: Date } | null> {
  const row = (await tx.select({ sealed: voiceSettings.sealed, updatedAt: voiceSettings.updatedAt }).from(voiceSettings).where(eq(voiceSettings.userId, userId))).at(0);
  return row !== undefined ? { accessibility: await opened(tx, keyring, userId, row.sealed), updatedAt: row.updatedAt } : null;
}


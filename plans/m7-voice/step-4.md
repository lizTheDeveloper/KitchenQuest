# Step 4 — API: voice consent, the sealed accessibility need (C-19), the voice allowance and usage

This step adds the account side of voice:
- the `voice` consent notice as a versioned file (C-18 "separate `voice` consent on first mic use");
- the self-declared accessibility need, sealed (Ruling 6, C-19; spec §16 "unlimited voice for players who need it for accessibility");
- the allowance as a state (Ruling 5);
- the content-free usage writers Step 5 calls.

It touches `EVAL_FILES` (`consent/notices.ts`, `entitlements/entitlements.ts`, `app.ts`, `usage/usage.ts` if changed).

**Files:**
- Create:
  - `apps/api/src/voice/constants.ts` (README API constants);
  - `apps/api/src/voice/settings.ts` (the sealed row);
  - `apps/api/src/voice/allowance.ts`;
  - `apps/api/src/voice/status-routes.ts`;
  - `docs/compliance/notices/voice-v1.md`;
  - the next generated migration: `voice_settings`, and `DELETE FROM entitlements WHERE kind = 'accessibility_voice'`;
  - `apps/api/test/voice-settings.test.ts`, `apps/api/test/voice-allowance.test.ts`.
- Modify:
  - `apps/api/src/db/schema.ts`: `voiceSettings(user_id uuid pk → users cascade, sealed bytea not null, updated_at)`;
  - `apps/api/src/entitlements/entitlements.ts`: `grant` throws `accessibility_voice is a sealed setting (C-19)`; keep the kind in `ENTITLEMENT_KINDS` only so old rows parse, and comment it as retired;
  - `apps/api/scripts/grant.ts`: refuses it with the same message;
  - `apps/api/src/mentor/allowance.ts`: comment only;
  - `apps/api/src/consent/notices.ts`: `voice: noticeFile('voice', 'v1')`, `ACCEPTED_VERSIONS.voice = ['v1']`;
  - `apps/api/src/consent/health-data.ts`: `voice_settings` joins the erase (it's health data, not in `HEALTH_TABLES`' row-id shape: delete by `user_id`);
  - `apps/api/src/account/routes.ts`: export `voice: { accessibility }` decrypted, delete by cascade (C-7, C-8);
  - `apps/api/src/app.ts`: register `voiceStatusRoutes`;
  - `apps/api/src/errors.ts` doc comment;
  - tests `entitlements-boundary`, `account`, `consent`, `inventory`, `free-forever`;
  - `docs/compliance/data-inventory.md`: P-5 becomes `voice_settings`, built M7; V-4 writes; the §6 column index.

**Interfaces:**
- Consumes: `hasConsent`, `lockLiveUser`, `lockConsentIn`, `seal` / `open` with AAD `{ table, userId, rowId }`, `activeEntitlements`, `GUILD_KINDS`, `usageSince`, `recordUsage` (`voice_stt`, `voice_tts` already in `USAGE_FEATURES`); core `VoiceState`.
- Produces:
```ts
// voice/settings.ts — sealed S-U, AAD { table: 'voice_settings', userId, rowId: userId }
export async function readAccessibility(db: Db, keyring: Keyring, userId: string): Promise<boolean>;   // false when no row
export async function setAccessibility(db: Db, keyring: Keyring, userId: string, on: boolean, now: Date, requestId: string): Promise<void>;
//   under lockLiveUser → lockConsentIn('health_data'): throws ApiError(403, 'consent_required', { purpose: 'health_data' }) without it;
//   off deletes the row (nothing kept); audit 'voice.accessibility' with no value in the event.
// voice/allowance.ts
export async function voiceState(db: Db, keyring: Keyring, userId: string, now: Date): Promise<{ state: VoiceState; unmetered: boolean }>;
//   abuse ceiling first (everyone): voice_stt seconds in the last 24 h ≥ VOICE_ABUSE_SECONDS_PER_DAY → resting until (oldest counted row + 24 h)'s UTC date;
//   then unmetered = accessibility || any GUILD_KINDS → available;
//   else seconds in the last 30 days ≥ FREE_VOICE_SECONDS_PER_30_DAYS → resting until the UTC date on which enough of the oldest rows leave the window.
export async function recordVoice(db: Pick<Db, 'insert'>, userId: string, feature: 'voice_stt' | 'voice_tts', ms: number, now: Date): Promise<void>;
//   units = ceil(ms / 1000), cost = units × VOICE_COST_MICROUSD_PER_SECOND; skipped when ms = 0. Counts only (U-1, V-4).
// voice/status-routes.ts
//   GET /voice/status → 200 { state: VoiceState, accessibility: boolean, enabled: boolean }      (requireUser)
//   PUT /voice/accessibility { on: boolean } (zod-strict) → 204 | 403 consent_required
```
- The `voice-v1.md` notice states, in plain words (DRAFT, pending lawyer, C-30):
  - what the microphone is used for;
  - that audio is turned into text on our own servers (Hetzner, EU) and never stored or recorded;
  - that no voiceprint is ever made;
  - that what you say is kept as conversation text only as typed text is (30 days with `health_data`, memory otherwise);
  - that text always works;
  - that children never use the microphone.

  It never says "HIPAA".

- [ ] **4.1 Write the failing tests.**
```ts
// voice-settings.test.ts (real Postgres)
test('PUT /voice/accessibility {on:true} without health_data → 403 consent_required; with it → 204 and the row is sealed (no "accessibility" or "true" in the bytea, AAD-bound: a copied row under another user fails to open)', ...);
test('off deletes the row; GET /voice/status reflects both', ...);
test('a health_data withdraw-with-delete erases voice_settings; with keep it stays', ...);
test('export includes voice: { accessibility: true } decrypted; DELETE /me removes the row', ...);
test('grant(…, "accessibility_voice", …) throws; the migration leaves no accessibility_voice entitlement', ...);
test('the audit event and logs carry no value of the setting', ...);
// voice-allowance.test.ts (injected clock)
test('free: 3599 s in 30 days → available; 3600 → resting until the date the oldest rows age out', ...);
test('Guild or accessibility → available at 50 000 s in 30 days; everyone (accessibility too) rests at 21 600 s in 24 h', ...);
test('voice_tts usage never counts toward the state', ...);
test('recordVoice writes units = ceil(seconds) and cost; a usage_events row has only id, user_id, feature, units, cost_microusd, created_at', ...);
// free-forever.test.ts (extended)
test('zero entitlements + accessibility on: voice is available after 10 hours of speech in 30 days; the setting itself needs no entitlement', ...);
// consent.test.ts (extended)
test('GET /me/consents returns notices.voice at v1, read from the file; a grant under 2026-11-09 is in needsReconsent', ...);
// inventory.test.ts (N-8): voice_settings columns listed
```
- [ ] **4.2 Run** `npm test -w @kitchenquest/api -- voice-settings voice-allowance free-forever consent inventory account entitlements` → FAIL.
- [ ] **4.3 Implement.** Generate the migration with `drizzle-kit generate`. Then write the data-inventory rows: P-5, V-4 and the §6 index.
- [ ] **4.4 Run** `npm test -w @kitchenquest/api` → only `eval-gate.test.ts` fails. `npm run typecheck` → PASS.
- [ ] **4.5 Commit** `feat(api): voice consent v1, the sealed accessibility need (C-19), voice allowance and usage`

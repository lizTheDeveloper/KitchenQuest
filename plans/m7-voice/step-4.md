# Step 4 — API: voice consent, the sealed accessibility need (C-19), the voice allowance and usage

This step adds the account side of voice:
- the `voice` consent notice as a versioned file (C-18: "separate `voice` consent on first mic use");
- the self-declared accessibility need, sealed (Ruling 6, C-19; spec §16 "unlimited voice for players who need it for accessibility");
- the allowance as a state (Ruling 5);
- the content-free usage writers Step 5 calls.

It touches `EVAL_FILES` (`consent/notices.ts`, `entitlements/entitlements.ts`, `app.ts`).

**Files:**
- Create:
  - `apps/api/src/voice/{constants,settings,allowance,status-routes}.ts`;
  - `docs/compliance/notices/voice-v1.md`;
  - the next generated migration: `voice_settings`, and `DELETE FROM entitlements WHERE kind = 'accessibility_voice'`;
  - `apps/api/test/{voice-settings,voice-allowance}.test.ts`.
- Modify:
  - `apps/api/src/db/schema.ts`: `voiceSettings(user_id uuid pk → users cascade, sealed bytea not null, updated_at)`;
  - `apps/api/src/entitlements/entitlements.ts`: `grant` throws `accessibility_voice is a sealed setting (C-19)`. The kind stays in `ENTITLEMENT_KINDS`, commented as retired, so old rows parse;
  - `apps/api/scripts/grant.ts`: refuses the kind with the same message;
  - `apps/api/src/mentor/allowance.ts`: comment only;
  - `apps/api/src/consent/notices.ts`: `voice: noticeFile('voice', 'v1')`, `ACCEPTED_VERSIONS.voice = ['v1']`;
  - `apps/api/src/consent/health-data.ts`: a withdraw-with-delete also deletes the `voice_settings` row, by `user_id`;
  - `apps/api/src/account/routes.ts`: export `voice: { accessibility }` decrypted; delete by cascade;
  - `apps/api/src/app.ts`: register `voiceStatusRoutes`; add `Deps.voiceEnabled?: boolean`, default `false`, which Step 5 wires (P6);
  - `apps/api/src/errors.ts`: the doc comment;
  - tests `entitlements-boundary`, `account`, `consent`, `inventory`, `free-forever`;
  - `docs/compliance/data-inventory.md`: P-5 → `voice_settings`, built M7; V-4 writes; the §6 index;
  - `docs/business/2026-11-09-value-chain-monetization.md`: the accessibility setting (§B.11 and wherever `profiles.accessibility_voice` or an accessibility entitlement is named) is now the sealed `voice_settings` row (C7).

**Interfaces:**
- Consumes: `hasConsent`, `lockLiveUser`, `lockConsentIn`, `seal` / `open` with AAD `{ table, userId, rowId }`, `activeEntitlements`, `GUILD_KINDS`, `usageSince`, `recordUsage`; core `VoiceState`.
- Produces:
```ts
// voice/settings.ts — sealed S-U, AAD { table: 'voice_settings', userId, rowId: userId }
export async function readAccessibility(db: Db, keyring: Keyring, userId: string): Promise<boolean>;      // false when no row
export async function setAccessibility(db: Db, keyring: Keyring, userId: string, on: boolean, now: Date, requestId: string): Promise<void>;
//   under lockLiveUser → lockConsentIn('health_data'); 403 consent_required without it.
//   UPSERTS { accessibility: on } sealed: the row is kept when off (B4), so its existence reveals nothing.
//   audit 'voice.accessibility' carries no value.
// voice/allowance.ts
export async function voiceState(db: Db, keyring: Keyring, userId: string, now: Date): Promise<{ state: VoiceState; unmetered: boolean }>;
//   1. everyone: voice_stt seconds in 24 h ≥ VOICE_ABUSE_SECONDS_PER_DAY → resting until (oldest counted row + 24 h):
//      { kind: 'resting_today' } when that is the same player-local date as now (Step 4 fix round 1 ruling: local, not UTC), else { kind: 'resting', until } (B4)
//   2. unmetered = accessibility || any GUILD_KINDS → available
//   3. free: seconds in 30 days ≥ FREE_VOICE_SECONDS_PER_30_DAYS → resting until the player-local date enough old rows leave the window
export async function recordVoice(db: Pick<Db, 'insert'>, userId: string, feature: 'voice_stt' | 'voice_tts', ms: number, now: Date): Promise<void>;
//   units = ceil(ms / 1000); cost = units × VOICE_COST_MICROUSD_PER_SECOND; skipped at 0 ms
// voice/status-routes.ts
//   GET /voice/status → 200 { state, accessibility, enabled: deps.voiceEnabled ?? false }
//   PUT /voice/accessibility { on: boolean } (zod-strict) → 204 | 403 consent_required
```
- **The `voice-v1.md` notice** (DRAFT, pending lawyer, C-30) states, plainly:
  - what the microphone is used for;
  - that audio is turned into text on our own servers (Hetzner, EU) and never stored;
  - that no voiceprint is made;
  - that what you say is kept as conversation text only as typed text is;
  - that text always works;
  - that children never use the microphone.

  It never says "HIPAA".

- [ ] **4.1 Write the failing tests.**
```ts
// voice-settings.test.ts (real Postgres)
test('PUT {on:true} without health_data → 403 consent_required; with it → 204; the bytea holds neither "accessibility" nor "true"; a row copied to another user fails to open (AAD)', ...);
test('PUT {on:false} keeps the row (sealed false) and GET reports false; the row count and length do not tell on from off (B4)', ...);
test('a health_data withdraw-with-delete erases the row; with keep it stays', ...);
test('export has voice: { accessibility } decrypted; DELETE /me removes the row', ...);
test('grant(…, "accessibility_voice", …) throws; after the migration no such entitlement row exists', ...);
test('audit events and captured logs carry no value of the setting', ...);
// voice-allowance.test.ts (injected clock)
test('free: 3599 s in 30 days → available; 3600 → resting until the date the oldest rows age out', ...);
test('Guild or accessibility → available at 50 000 s in 30 days; everyone, accessibility included, rests at 21 600 s in 24 h', ...);
test('an abuse rest that lifts later the same UTC day → resting_today, never "until <today>"', ...);
test('voice_tts usage never counts; recordVoice writes units = ceil(seconds) and cost; the row has only id, user_id, feature, units, cost_microusd, created_at', ...);
test('GET /voice/status → enabled false by default; true when Deps.voiceEnabled is true', ...);
// free-forever.test.ts
test('zero entitlements + accessibility on: available after 10 h of speech in 30 days; the setting needs no entitlement', ...);
// consent.test.ts
test('GET /me/consents returns notices.voice at v1 from the file; a grant under 2026-11-09 is in needsReconsent', ...);
// inventory.test.ts (N-8): voice_settings columns listed
```
- [ ] **4.2 Run** `npm test -w @kitchenquest/api -- voice-settings voice-allowance free-forever consent inventory account entitlements` → FAIL.
- [ ] **4.3 Implement.** Generate the migration with `drizzle-kit generate`. Then write the inventory rows and the business-doc line.
- [ ] **4.4 Run** `npm test -w @kitchenquest/api` → only `eval-gate.test.ts` fails. `npm run typecheck` → PASS.
- [ ] **4.5 Commit** `feat(api): voice consent v1, the sealed accessibility need (C-19), voice allowance and usage`

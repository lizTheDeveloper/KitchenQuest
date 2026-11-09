# Step 2c — Health-data compliance safeguards (must land before Step 5 stores the first rule)

Source: `docs/compliance/2026-11-09-health-data-compliance.md` §6 table. Implement requirements **C-1, C-2, C-3, C-4, C-5, C-6, C-9, C-10** exactly as written in rows `C-1` through `C-10` of that table. Each table row is binding; read them in full. C-7, C-8 and C-11 amend Steps 7 and 8; see below.

**Files (expected):**
- `apps/api/src/consent/` (ledger, routes)
- `apps/api/src/crypto/keyring.ts`
- `apps/api/src/crypto/userkeys.ts`
- `apps/api/src/audit/audit.ts`
- `apps/api/src/jobs/retention.ts`
- `apps/api/src/logging/redact.ts`
- `apps/api/scripts/rekey.ts`
- a new generated migration
- `docs/compliance/processors.json`
- `docs/compliance/key-management.md`
- matching tests

**Interfaces (later steps rely on these exact names):**
```ts
// consent (C-1)
export type ConsentPurpose = 'health_data'|'ai_health'|'voice'|'pantry_location'|'research';
export async function grantConsent(db, userId, purpose, noticeVersion, noticeSha256: Buffer, method: 'tap'|'api', now): Promise<void>;
export async function withdrawConsent(db, userId, purpose, now): Promise<void>;
export async function hasConsent(db, userId, purpose, now): Promise<boolean>;
// sealing with context + per-user keys (C-2/C-3/C-4)
export interface SealContext { table: string; userId: string; rowId: string; }
export async function sealFor(db, keyring, ctx: SealContext, value: unknown): Promise<Buffer>;   // uses the user's data key (created on first use, wrapped by the active ring key)
export async function openFor<T>(db, keyring, ctx: SealContext, sealed: Buffer): Promise<T>;
// audit (C-5)
export async function audit(db, e: { actorKind: 'user'|'system'|'operator'|'script'; actorId?: string; subjectUserId?: string; action: string; target?: string; requestId?: string }, now): Promise<void>;
// retention (C-6)
export function registerRetention(policy: { table: string; run(db, now): Promise<number> }): void;
export async function runRetention(db, now): Promise<Record<string, number>>;
```

**Config:** `DATA_KEYS` (`id:base64,id:base64`) and `DATA_KEY_ID` replace `DATA_KEY`. Boot fails naming the variable if the active id is missing or any key isn't 32 bytes. Update `.env.example` and the test helpers.

**Global-constraint additions (copy into README Global Constraints):**
- C-10 org/health separation.
- Error code `consent_required` (403).
- Never market the app as "HIPAA compliant".
- Health data is never sent to the AI without `ai_health` consent (enforced in M3).

**Tests (in addition to those named in each C-row):**
- C-2: rotation (seal under k1 → rotate → open; rekey → drop k1 → open).
- C-3: a blob copied to another user's row or another table fails to open.
- C-4: delete the user, then the sealed blob can't be opened even with the ring.
- C-5: the app role can't UPDATE or DELETE `audit_events`; sign-in writes an event.
- C-6: retention with the injected clock deletes exactly the expired `login_tokens`/`sessions`.
- C-9: a `GET /ingredients/search?q=peanut`-style request and a body containing "peanut" leave no "peanut" in the captured log stream. Use an existing route if search doesn't exist yet, and leave a test hook for Step 5.

- [ ] **2c.1 Write failing tests.** **2c.2 Run** → FAIL. **2c.3 Implement.** **2c.4 Run** → PASS (root `npm test`, `npm run typecheck`).
- [ ] **2c.5 Commit** `feat(api): consent ledger, key ring, per-user keys, context-bound sealing, audit log, retention, log redaction`

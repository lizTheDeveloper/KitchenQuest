# Step 3 — API carry-overs: rule service, per-user rule lock, 401 before 403

These are the lines M2 parked for the rule-entry milestone (`.superpowers/sdd/README-m2-api/progress.md`, last line):
- Serialize rule writes per user, so the 200-rule cap and cross-rule validation are strict under concurrency.
- Run the consent check after `lockLiveUser`, so a deleted user gets 401, not 403.
- Note that deploy must set `TRUST_PROXY`.

The confirm path (Step 8) needs the rule write as a function, not only as a route, so this step also extracts it.

**Files:**
- Create: `apps/api/src/rules/service.ts`
- Modify: `apps/api/src/rules/routes.ts` (POST and PUT call the service; `parseWrite` no longer calls `requireConsent`), `.env.example` (TRUST_PROXY comment), `docs/compliance/data-inventory.md` §3.14 (one line: the search, export and mentor turn limiters key on `req.ip`, so `TRUST_PROXY` must name the reverse proxy in deploy)
- Test: `apps/api/test/rules.test.ts` (extend), `apps/api/test/rules-service.test.ts` (new)

**Interfaces:**
- Consumes: `lockLiveUser`, `lockConsentIn`, `loadRules`, `sealFor`, `audit`, `validateRules` (M2).
- Produces (Step 8 and the routes use these):
```ts
// rules/service.ts
export const MAX_RULES_PER_USER = 200;   // moved here from routes.ts and re-exported there
/** pg_advisory_xact_lock(hashtextextended('rules:' || userId, 0)). Call right after lockLiveUser, before lockConsentIn. */
export async function lockUserRules(tx: Tx, userId: string): Promise<void>;
/** Lock order: live user (401) → user rules → health_data consent (403) → cap (400 too_many_rules) → core validation (400 bad_request) → seal → insert → audit 'rules.create'. */
export async function createRuleIn(tx: Tx, deps: { keyring: Keyring; catalog: Catalog }, userId: string, value: StoredRule, at: Date, requestId?: string): Promise<Rule>;
export async function updateRuleIn(tx: Tx, deps: { keyring: Keyring; catalog: Catalog }, userId: string, rowId: string, value: StoredRule, at: Date, requestId?: string): Promise<Rule>;   // 404 when not the user's
export async function deleteRuleIn(tx: Tx, userId: string, rowId: string, at: Date, requestId?: string): Promise<void>;        // live user, then user rules lock; no consent (M2 rule)
```
- Behaviour that stays the same:
  - `confirmed: true` is still checked before any database work (400 `confirmation_required`).
  - Bodies keep their M2 strict shape.
  - Responses are unchanged.
  - The fast pre-transaction `requireConsent` is removed: the locked check inside the transaction is the only consent check, and it runs after the live-user check.
- Lock order across the API becomes: user row (`lockLiveUser`) → `rules:<id>` advisory lock → consent row. Account delete takes the user row first, so it still serializes ahead. Document this in the `lockUserRules` comment and the `lockLiveUser` comment.

- [ ] **3.1 Write the failing tests:**
```ts
test('two concurrent creates at 199 rules: exactly one succeeds, the cap holds', async () => {
  // seed 199 rules for the user; fire two POST /rules in parallel (Promise.all)
  expect(statuses.sort()).toEqual([201, 400]);
  expect(bodies.find((b) => b.error)?.error.code).toBe('too_many_rules');
  expect(await countRules(userId)).toBe(200);
});
test('two concurrent creates both see each other for validation', ...);   // two POSTs in parallel against a user with 0 rules → both 201, and loadRules returns 2 rules with distinct ids (no lost write)
test('createRuleIn for a user that no longer exists → 401, never 403', async () => {
  await expect(db.transaction((tx) => createRuleIn(tx, deps, deletedUserId, rule, now))).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
});
test('createRuleIn without consent → 403 and nothing stored', ...);
test('POST /rules without confirmed is still 400 confirmation_required before any DB read', ...);   // spy: no query when confirmed is missing (count queries via a drizzle logger)
test('M2 rule tests still pass unchanged', ...);   // the existing rules.test.ts suite is the regression net
```
- [ ] **3.2 Run** `npm test -w @kitchenquest/api -- rules` → FAIL (the cap test sees 2 × 201 or 201 rules; the 401 test sees 403).
- [ ] **3.3 Implement** `service.ts` and switch the routes to it. `.env.example`: above `TRUST_PROXY`, add `# Deploy MUST set this to the reverse proxy (hop count or its addresses): the search, export and mentor limiters key on the client IP.`
- [ ] **3.4 Run** `npm test -w @kitchenquest/api` → PASS (the full API suite: lock order changes can deadlock elsewhere).
- [ ] **3.5 Commit** `fix(api): per-user rule lock makes the cap strict; consent checked after the live-user lock`

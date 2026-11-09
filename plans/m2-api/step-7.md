# Step 7 — Export and delete account

**Files:** Create `apps/api/src/account/routes.ts`, `apps/api/test/account.test.ts`

- `GET /me/export` → `application/json` attachment `kitchen-quest-export.json`: `{ exportedAt, user: { email, createdAt, ageConfirmedAt }, profile, rules (decrypted), entitlements, usage (per-feature totals) }`. Must include every stored user field (when later milestones add tables, they extend this).
- `DELETE /me { confirm: "delete my account" }` → deletes the user (cascade), clears the cookie, 204. Wrong/missing phrase → 400 `confirmation_required`.

- [ ] **7.1 Tests:** export contains decrypted rules and the profile; delete with wrong phrase → 400 and nothing deleted; delete → 204, then the user's id appears in no table (query every table in the schema for the id/email) (Review Focus 5), and the old session cookie → 401.
- [ ] **7.2 Run** → FAIL. **7.3 Implement.** **7.4 Run** → PASS.
- [ ] **7.5 Commit** `feat(api): data export and account deletion`

**Compliance amendments (C-7, C-8):** export adds `consents` (full history), `processors` (from `docs/compliance/processors.json`) and the user's `audit_events`; delete also removes `login_tokens` by email, revokes sessions, deletes `user_keys`, pseudonymizes `audit_events`, and writes audit events for export/delete. Delete order, all in one transaction: write the `account.delete` audit event (subject = the user's id) **first**, then delete the user, then `pseudonymizeAudit(tx, config.pseudonymKey, userId)`, so the delete event is pseudonymized along with the rest. The database refuses to pseudonymize while the user row exists. The 'no table contains the id or email' test includes `login_tokens`.

**Carried from Task 5:** export includes `self_read_counts` (per-day counts); register `self_read_counts` with the retention job at 24 months.

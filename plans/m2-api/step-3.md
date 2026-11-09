# Step 3 — Magic-link sign-in and sessions

**Files:**
- Create: `apps/api/src/auth/tokens.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/auth/session.ts` (Fastify `preHandler` `requireUser`), `apps/api/src/mail/mailer.ts` (`LogMailer`, `SmtpMailer`, test `CaptureMailer`), `apps/api/test/auth.test.ts`

**Interfaces:**
- Produces: `requireUser` decorator giving `request.user: { id: string; email: string }`; `CaptureMailer` with `.sent: {to,subject,text}[]`.
- Routes:
  - `POST /auth/request { email, ageConfirmed? }` → always 202 `{ ok: true }` (no account enumeration). Creates a login token and mails a link `${appOrigin}/auth/verify?token=<token>`. Rate limit: 5 per hour per email and 20 per hour per IP → 429 `rate_limited`.
  - `POST /auth/verify { token, ageConfirmed? }` → on a valid unused unexpired token: marks it used (atomically: `UPDATE … WHERE used_at IS NULL AND expires_at > now RETURNING`), creates the user if new (requires `ageConfirmed: true`, else 400 `bad_request` with code detail `age_confirmation_required` and the token is NOT consumed), creates a session, sets the cookie, returns `{ user: { id, email } }`. Otherwise 401 `unauthorized`.
  - `POST /auth/logout` → deletes the session, clears the cookie, 204.
  - `GET /me` → `{ id, email }` or 401.

- [ ] **3.1 Tests** (CaptureMailer, injected clock):
  - full flow: request → mail captured → verify → cookie flags exactly `HttpOnly; Secure; SameSite=Lax; Path=/` → `/me` returns the email.
  - the database holds only hashes: no row contains the raw token.
  - single use: second verify → 401; two concurrent verifies → exactly one 200 (Review Focus 2).
  - expiry: advance clock 15 min + 1 s → 401.
  - new user without `ageConfirmed` → 400 and the token still works afterward with `ageConfirmed: true`.
  - unknown email gets the same 202 as a known one.
  - logout → `/me` 401; expired session (30 days + 1 s) → 401.
  - rate limit: 6th request for one email within an hour → 429.
- [ ] **3.2 Run** → FAIL. **3.3 Implement.** **3.4 Run** → PASS.
- [ ] **3.5 Commit** `feat(api): magic-link sign-in and sessions`

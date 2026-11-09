# Milestone 2: API & Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own step file.

**Goal:** A tested TypeScript API (`apps/api`) with Postgres storage, email magic-link sign-in, encrypted health data, profile and allergy-rule endpoints, canon recipe sync, recipe endpoints that run the M1 safety check per player, and one-click export/delete.

**Architecture:** Fastify app built by a factory `buildApp(deps)` so tests inject a real Postgres connection, a capturing mailer and a fixed clock. Drizzle ORM over `postgres` (postgres.js) with committed SQL migrations. All allergy/diet logic stays in `@kitchenquest/core`; the API only stores, validates through core, and serves. The ingredient graph and substitutions load once from `data/` at startup.

**Tech Stack:** Node 22, TypeScript, Fastify 5.12, `@fastify/cookie`, `@fastify/rate-limit`, zod 4, drizzle-orm 0.45 + drizzle-kit 0.31, `postgres` driver, Vitest, Postgres 16.

**Spec:** `docs/superpowers/specs/2026-11-09-kitchenquest-design.md` (§2 principles, §4.4 rules, §7.0 confirmations, §9 architecture/privacy, §10 canon, §12 testing).

## Global Constraints

- The API never decides safety itself: rule validation is `validateRules` and recipe status is `check` from `@kitchenquest/core`.
- Health data (rules now; meal logs and symptoms in later milestones) is encrypted at rest with AES-256-GCM in the application; the database never holds it in plaintext. Key from env `DATA_KEY` (32 bytes, base64); ciphertext stores a key id so keys can rotate.
- A rule is saved only with `confirmed: true` in the request body (spec §7.0: writes affecting health or safety need an explicit yes). Missing or false → 400 `confirmation_required`.
- Sign-in: email magic link only. Login tokens: 32 random bytes, only the SHA-256 hash stored, single use, expire after 15 minutes. Sessions: 32 random bytes, hash stored, 30-day expiry, cookie `kq_session` with `HttpOnly; Secure; SameSite=Lax; Path=/`.
- Age gate: creating an account requires `ageConfirmed: true` (16+, spec §1.2); store `age_confirmed_at`, never a birthday.
- Data minimisation: no location beyond country/region, no names required, email is the only identifier.
- Error body shape everywhere: `{ "error": { "code": string, "message": string, "details"?: unknown } }`. Codes used: `bad_request`, `confirmation_required`, `unauthorized`, `not_found`, `rate_limited`, `conflict`.
- Dates in requests are ISO `YYYY-MM-DD`; the server's "today" comes from the injected clock.
- Fail loudly: invalid config stops the server at boot with a message naming the variable.
- Tests run against real Postgres 16 (`TEST_DATABASE_URL`); each test file gets its own schema. No mocked database.

- Compliance (docs/compliance/2026-11-09-health-data-compliance.md): Kitchen Quest stays outside HIPAA by design (product rules P-1–P-14); never market it as "HIPAA compliant". Health data requires `health_data` consent (403 `consent_required`); org data is never joined to health data (C-10).

## Review Focus

1. A request with another user's rule or recipe id must get 404, never their data. → Tasks 5, 6, 7 tests.
2. A replayed, expired or tampered login token must fail, and a token must work exactly once even under two concurrent verifies. → Task 3.
3. Rules stored in the database must be unreadable without `DATA_KEY` (no plaintext ingredient ids in the table). → Tasks 2, 5.
4. A rule body that core rejects (unknown id, inverted phase, bad enum) must return 400 with core's problem messages, never be stored. → Task 5.
5. A player with no entitlements must still get every "free forever" feature (spec §16): sign-in, rules, recipe checks, export, delete. → Task 8.
6. Account deletion must leave no row anywhere referencing the user, and export must include every stored field decrypted. → Task 7.

## Tasks

- [x] [Step 0 — Carry-over core safety fixes](step-0.md)
- [x] [Step 1 — API skeleton, config, test harness, local Postgres, CI](step-1.md)
- [x] [Step 2 — Schema, migrations, encryption helper](step-2.md)
- [x] [Step 2b — Entitlements and usage metering](step-2b.md)
- [x] [Step 3 — Magic-link sign-in and sessions](step-3.md)
- [x] [Step 4 — Profile](step-4.md)
- [ ] [Step 5 — Ingredient search and allergy/diet rules](step-5.md)
- [ ] [Step 6 — Canon recipe sync and recipe endpoints](step-6.md)
- [ ] [Step 7 — Export and delete account](step-7.md)
- [ ] [Step 8 — End-to-end safety test](step-8.md)
- [ ] [Step 9 — Compliance follow-ups](step-9.md)

**Deferred, on purpose:** meal logs, plans, market, AI (later milestones); passkeys; real SMTP delivery config beyond an SMTP-URL mailer; deployment (milestone 11).

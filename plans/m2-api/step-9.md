# Step 9 — Compliance follow-ups (N-1, N-2, N-7, N-8)

Source: `docs/compliance/risk-register.md` §6 and `docs/compliance/ROADMAP.md`.

1. **N-7, ruling:** meal-window `name` becomes an enum `breakfast | lunch | dinner | snack | other`, not free text. Update the profile validation and tests, and migrate (generated) if the column shape changes. Cap every remaining free-text field in the API at its documented max. The `health_data` consent notice text (versioned under `docs/compliance/notices/health_data-v1.md`) explicitly names religious and cultural dietary rules as covered. The consent ledger stores that notice's version and sha256.
2. **N-8:** a test (`apps/api/test/inventory.test.ts`) parses `apps/api/src/db/schema.ts` table and column names, or reads them from the database's `information_schema` after migrate. It fails if any `table.column` isn't mentioned in `docs/compliance/data-inventory.md`. Update the inventory so it passes.
3. **N-1:**
   - The SMTP mailer sends plain-text magic-link emails with no tracking pixels and no HTML link-wrapping.
   - Add a doc `docs/compliance/mail-provider.md` listing provider settings (tracking off, link rewriting off, log retention, SPF/DKIM/DMARC).
   - Add a test that the email body has exactly one URL, the verify link, and no health content.
4. **N-2:**
   - Document that rate-limit state is in-memory, IP-keyed and swept within an hour.
   - Set the Fastify access log to route patterns only (already C-9).
   - Register access-log retention guidance in `docs/compliance/data-inventory.md`.

- [ ] Tests first, then implement. Run root `npm test` (with `TEST_DATABASE_URL`) and `npm run typecheck`.
- [ ] Commit `feat(api): compliance follow-ups N-1, N-2, N-7, N-8`

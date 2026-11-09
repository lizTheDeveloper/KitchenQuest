# Step 6 — Canon recipe sync and recipe endpoints

**Files:**
- Create: `apps/api/src/recipes/sync.ts` (+ CLI `apps/api/src/recipes/sync-cli.ts`, script `npm run sync:recipes -w @kitchenquest/api`), `apps/api/src/recipes/routes.ts`, `apps/api/test/recipes.test.ts`

**Interfaces:**
```ts
export async function syncCanon(db: Db, recipesDir: string, graph: IngredientGraph): Promise<{ added: number; updated: number; removed: number; unchanged: number }>;
```
- Front matter gains optional `contributors: string[]` (stable contributor ids, e.g. GitHub handles) for the §16 contributor revenue share; store them in a `contributors text[] not null default '{}'` column on `canon_recipes` (migration in this step).
- Reads every `recipes/**/*.cook`, parses with core `parseRecipe`, slug = path without extension (`india/kerala/parippu`), `content_hash` = sha256 of source. All-or-nothing in one transaction: any parse error aborts the whole sync with the file path in the message. Rows for deleted files are removed.

**Routes (auth required, uses the player's decrypted rules and today's date from the clock):**
- `GET /recipes` → `{ recipes: { slug, title, country, region, status, check: { status, severe, disclaimer } }[] }` ordered by country, title.
- `GET /recipes/:slug` → `{ slug, title, meta, source, ingredients, check: CheckResult, nutrition: NutritionResult }`; slugs contain `/` so use a wildcard route; unknown → 404.

- [ ] **6.1 Tests:** sync against a temp dir with two recipes → added 2; re-run → unchanged 2; edit one → updated 1; delete one → removed 1; a malformed file → throws naming the path and the DB is unchanged. Endpoints: with a severe coconut rule, parippu reports `blocked` and the disclaimer; with no rules, the three real canon recipes (sync the real `recipes/` dir) report `ok`; detail includes nutrition per serving.
- [ ] **6.2 Run** → FAIL. **6.3 Implement.** **6.4 Run** → PASS.
- [ ] **6.5 Commit** `feat(api): canon recipe sync and per-player recipe checks`

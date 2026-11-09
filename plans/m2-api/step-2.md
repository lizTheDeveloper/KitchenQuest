# Step 2 — Schema, migrations, encryption helper

**Files:**
- Create: `apps/api/src/db/schema.ts`, `apps/api/src/db/client.ts`, `apps/api/drizzle.config.ts`, `apps/api/migrations/*` (generated), `apps/api/src/crypto/seal.ts`, `apps/api/src/crypto/seal.test.ts`, `apps/api/test/schema.test.ts`

**Interfaces:**
- Produces:
```ts
export type Db = PostgresJsDatabase<typeof schema>;
export function createDb(url: string, opts?: { schema?: string }): { db: Db; sql: Sql };
export async function migrate(db: Db, sql: Sql, schemaName?: string): Promise<void>;
// crypto
export function seal(plain: unknown, key: Buffer, keyId: string): Buffer;   // JSON → [keyIdLen][keyId][12B iv][16B tag][ciphertext]
export function open<T>(sealed: Buffer, keys: Record<string, Buffer>): T;   // throws on tamper / unknown key id
```
Tables (snake_case columns, `uuid` ids via `gen_random_uuid()`, `timestamptz` times):
- `users(id, email citext unique not null, age_confirmed_at, created_at)`
- `login_tokens(id, email citext not null, token_hash bytea unique not null, expires_at, used_at, created_at)`
- `sessions(id, user_id → users on delete cascade, token_hash bytea unique, expires_at, created_at)`
- `profiles(user_id pk → users cascade, market_days smallint[] not null default '{}', meals_per_week smallint, country text, region text, meal_windows jsonb not null default '[]', updated_at)`
- `rules(id, user_id → users cascade, sealed bytea not null, created_at, updated_at)` — the whole core `Rule` minus `id` is sealed; the row id is the rule id.
- `canon_recipes(path text pk, slug text unique, title, country, region, status, source text not null, content_hash text not null, synced_at)`

- [ ] **2.1 Tests:** `seal.test.ts` — round-trip an object; tampering any byte → throws; unknown key id → throws naming it; two seals of the same input differ (random IV). `schema.test.ts` (real Postgres) — migrations apply to a fresh schema; deleting a user cascades to sessions, profiles, rules; `citext` makes `A@x.com` and `a@x.com` collide.
- [ ] **2.2 Run** → FAIL.
- [ ] **2.3 Implement** schema, `createDb`, generated migrations (`drizzle-kit generate`; enable `citext` and `pgcrypto` extensions in the first migration), `seal`/`open` with `node:crypto` AES-256-GCM.
- [ ] **2.4 Run** → PASS (root `npm test`, `npm run typecheck`).
- [ ] **2.5 Commit** `feat(api): schema, migrations, sealed health data`

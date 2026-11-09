# Step 1 — API skeleton, config, test harness, local Postgres, CI

**Files:**
- Create: `apps/api/package.json` (name `@kitchenquest/api`, ESM), `apps/api/tsconfig.json`, `apps/api/src/config.ts`, `apps/api/src/app.ts`, `apps/api/src/errors.ts`, `apps/api/src/server.ts`, `apps/api/test/helpers/db.ts`, `apps/api/test/health.test.ts`
- Create: `scripts/dev-db.sh`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.env.example`
- Modify: root `README.md` (running the API), `.gitignore` (`.data/`)

**Interfaces:**
- Produces:
```ts
// config.ts
export interface Config { databaseUrl: string; dataKey: Buffer; dataKeyId: string; appOrigin: string; mailer: 'log' | 'smtp'; smtpUrl?: string; port: number; }
export function loadConfig(env: NodeJS.ProcessEnv): Config;   // throws naming the bad variable
// app.ts
export interface Deps { config: Config; db: Db; mailer: Mailer; now: () => Date; }
export function buildApp(deps: Deps): Promise<FastifyInstance>;
// errors.ts
export class ApiError extends Error { constructor(status: number, code: string, message: string, details?: unknown) }
// test/helpers/db.ts
export async function testDb(): Promise<{ db: Db; sql: Sql; close(): Promise<void> }>;  // fresh schema per call, migrated
```
(`Db`, `Mailer` come from Steps 2 and 3; in this step `Deps` may use placeholders typed as `unknown` that Step 2/3 narrow — or define the `Mailer` interface here: `{ send(msg: { to: string; subject: string; text: string }): Promise<void> }`.)

- [ ] **1.1 Tests:** `health.test.ts` — `GET /health` → 200 `{ ok: true }`; an unknown route → 404 with the error body shape; `loadConfig` throws a message containing `DATA_KEY` when it is missing or not 32 bytes base64, containing `DATABASE_URL` when missing.
- [ ] **1.2 Run** `npm test -w @kitchenquest/api` → FAIL.
- [ ] **1.3 Implement** config (zod over env), `buildApp` with the error handler producing the shape in Global Constraints (zod errors → 400 `bad_request` with field details; `ApiError` → its status/code; anything else → 500 `internal` without leaking the message), `server.ts` entry (`node --import tsx src/server.ts` via `npm run dev -w @kitchenquest/api`).
- [ ] **1.4 Local Postgres:** `scripts/dev-db.sh start|stop|url` runs a private Postgres 16 cluster under `.data/pg` (initdb with `/usr/lib/postgresql/16/bin` when present, else falls back to telling the user to use docker compose) on port 54329 and prints `postgres://...` URLs for `kitchenquest` and `kitchenquest_test`. `docker-compose.yml` offers the same with the `postgres:16` image. The test helper creates a uniquely named schema per test file, runs migrations into it, and drops it in `close()`.
- [ ] **1.5 CI:** `.github/workflows/ci.yml` on push/PR: Node 22, `npm ci`, Postgres 16 service, `npm run typecheck`, `npm test` with `TEST_DATABASE_URL` set.
- [ ] **1.6 Run** `scripts/dev-db.sh start`, then `npm test` and `npm run typecheck` from root → PASS.
- [ ] **1.7 Commit** `feat(api): Fastify skeleton, config, test harness, local Postgres, CI`

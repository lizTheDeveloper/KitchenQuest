# Step 11 — API client, sign-in pages, account rules

This step adds a typed client for the M2 endpoints, the sign-in request form in Settings, and the `/auth/verify` page the magic link opens. When the player is signed in, their account rules replace device rules for checks. The game reaches the API same-origin under `/api`: the Vite dev and preview servers proxy it, and in production the reverse proxy does.

M2's profile, rules and recipe routes may still be in progress (M2 steps 4–6). The client is typed against `plans/m2-api/step-3.md`–`step-6.md` and tested with a fake `fetch`. E2E tests mock `/api/**` with `page.route`.

**Files:**
- Create: `apps/game/src/api/types.ts`, `apps/game/src/api/client.ts` (+ `client.test.ts`), `apps/game/src/api/account.ts` (+ `account.test.ts`), `apps/game/src/settings/account-section.ts`
- Create: `apps/game/auth/verify/index.html`, `apps/game/src/auth/verify-page.ts`
- Create: `apps/game/build/headers-plugin.ts` (+ `headers-plugin.test.ts`), `apps/game/deploy/security-headers.conf`
- Modify: `apps/game/vite.config.ts` (input `verify: 'auth/verify/index.html'`; `kqSecurityHeaders()`; `server.proxy` and `preview.proxy` `'/api'` → `process.env.KQ_API_ORIGIN ?? 'http://localhost:3000'` with `rewrite: p => p.replace(/^\/api/, '')`), `apps/game/src/main.ts`, `apps/game/src/settings/settings-screen.ts`
- Test: `apps/game/e2e/signin.e2e.test.ts`

**Interfaces:**
- Consumes: `PlayerStore` (Step 3); `activeRules` (Step 6, unchanged: it already prefers `accountRules`).
- Produces:
```ts
// api/types.ts (mirrors M2)
export interface ApiErrorBody { code: string; message: string; details?: unknown }
export interface Me { id: string; email: string; entitlements: string[] }
export interface Profile { marketDays: number[]; mealsPerWeek: number | null; country: string | null; region: string | null; mealWindows: { name: string; start: string; end: string }[] }
export interface RecipeSummary { slug: string; title: string; country: string; region: string; status: string; check: { status: CheckStatus; severe: boolean; disclaimer: string | null } }
export interface RecipeDetail { slug: string; title: string; meta: RecipeMeta; source: string; ingredients: RecipeIngredient[]; check: CheckResult; nutrition: NutritionResult }
export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiErrorBody };   // status 0 + code 'network' when fetch rejects
// api/client.ts
export interface ApiClient {
  requestLink(email: string): Promise<ApiResult<{ ok: true }>>;                       // POST /auth/request
  verify(token: string, ageConfirmed?: true): Promise<ApiResult<{ user: { id: string; email: string } }>>;   // POST /auth/verify
  logout(): Promise<ApiResult<null>>;                                                  // POST /auth/logout (204)
  me(): Promise<ApiResult<Me>>;
  getProfile(): Promise<ApiResult<Profile>>; putProfile(p: Partial<Profile>): Promise<ApiResult<Profile>>;
  listRules(): Promise<ApiResult<{ rules: Rule[] }>>;
  createRule(rule: Omit<Rule, 'id'>, confirmed: true): Promise<ApiResult<{ rule: Rule }>>;
  updateRule(id: string, rule: Omit<Rule, 'id'>, confirmed: true): Promise<ApiResult<{ rule: Rule }>>;
  deleteRule(id: string): Promise<ApiResult<null>>;
  listRecipes(): Promise<ApiResult<{ recipes: RecipeSummary[] }>>;
  getRecipe(slug: string): Promise<ApiResult<RecipeDetail>>;   // each slug segment encodeURIComponent'd, joined by '/'
}
export function createApiClient(opts?: { baseUrl?: string; fetch?: typeof fetch }): ApiClient;   // baseUrl default '/api'
// api/account.ts
export async function refreshAccount(client: ApiClient, store: PlayerStore): Promise<'signed-in' | 'signed-out' | 'offline'>;
export async function signOut(client: ApiClient, store: PlayerStore): Promise<void>;
// auth/verify-page.ts
export function startVerifyPage(opts: { doc: Document; location: Location; history: History; client: ApiClient }): void;
// build/headers-plugin.ts
export function isVerifyPath(pathname: string): boolean;   // '/auth/verify', '/auth/verify/', '/auth/verify/index.html'
export function kqSecurityHeaders(): Plugin;   // dev + preview middleware: on verify paths set 'Referrer-Policy: no-referrer' and 'Cache-Control: no-store'
```
- Client:
  - every request uses `credentials: 'same-origin'`
  - bodies are JSON with `content-type: application/json` (M2 rejects `text/plain`)
  - rule writes send `{ rule, confirmed: true }`
  - an error body of M2's shape `{ error: {...} }` becomes `error`
  - a non-JSON error response becomes `{ code: 'http_<status>', message: statusText }`
  - a rejected fetch becomes `{ ok: false, status: 0, error: { code: 'network', message } }`
  - no method retries
  - no method is called on page load except `me()` and `listRules()` inside `refreshAccount`
- `refreshAccount`:
  - `me()` 200 → `account = { email }`, then `listRules()`: 200 → `accountRules = rules`, otherwise keep the cached `accountRules`
  - `me()` 401 → `account = null` and `accountRules = null`
  - status 0 → no change, returns `'offline'`
  - `activeRules` validates whatever is stored, so invalid account rules surface as the ❓ error state, never ✅ (Review Focus 2)
  - it runs on app start and on `online` events
- `signOut`: `logout()`, then `account = null` and `accountRules = null`, even when the call fails offline. Device `localRules` are untouched. Account rules are never copied into device rules.
- Settings → Account:
  - signed out: an email field plus "Send me a sign-in link". After any 202 or 429 the response is the same text: "If that address can sign in, a link is on its way. It works once, for 15 minutes." (no account enumeration). The only other message is a network error.
  - signed in: "Signed in as {email}" and "Sign out".
- **`/auth/verify` page** (`auth/verify/index.html`):
  - The first element in `<head>` is `<meta name="referrer" content="no-referrer">`, before any `<link>` or `<script>`. The page loads only same-origin files (its own script and CSS).
  - On load, `startVerifyPage` reads `token` from `location.search` into a closure variable, then immediately calls `history.replaceState(null, '', location.pathname)`. The token is never written to storage, logged or put into the DOM.
  - With no token: "This sign-in link is incomplete." plus a link to `/#/settings`.
  - Otherwise: h1 "Sign in to Kitchen Quest", "Tap the button to finish signing in on this device.", and `<button id="verify">Sign me in</button>`. **Nothing is sent until that button is clicked.** There is no `autofocus`-plus-auto-submit, no `<form>` that Enter could submit on load, and no timer.
  - On click: disable the button, then `client.verify(token)`.
    - 200 → "Signed in as {email}." plus a link "Into the kitchen" to `/#/kitchen`.
    - 400 with `details.code === 'age_confirmation_required'` → reveal a required checkbox "I'm 16 or older" and a button "Create my account". The button stays disabled until the box is ticked, then calls `verify(token, true)`.
    - 401 → "This link has expired or has already been used." plus a link to `/#/settings` to request a new one.
    - 429 or 5xx → "The Bureau couldn't finish that just now. Try again in a moment.", and re-enable the button.
    - Network → "Couldn't reach the Bureau. Check your connection and try again.", and re-enable the button.
  - At most one request is in flight.
- `deploy/security-headers.conf`: an nginx `location ^~ /auth/verify { add_header Referrer-Policy "no-referrer" always; add_header Cache-Control "no-store" always; try_files $uri $uri/ /auth/verify/index.html; }` block, with a comment pointing at this step. Deployment itself is a later milestone.

- [ ] **11.1 Tests:**
```ts
// client.test.ts: fake fetch records (url, init) and returns scripted Responses
test('createRule sends confirmed: true as JSON', async () => {
  await client.createRule(rule, true);
  expect(calls[0]).toMatchObject({ url: '/api/rules', init: { method: 'POST', credentials: 'same-origin' } });
  expect(headers(calls[0]).get('content-type')).toBe('application/json');
  expect(JSON.parse(calls[0].init.body)).toEqual({ rule, confirmed: true });
});
test('getRecipe keeps slug slashes', ...);         // '/api/recipes/india/kerala/parippu'
test('M2 error body is surfaced', ...);             // 400 { error: { code: 'confirmation_required', message: 'x' } } → ok false, error.code 'confirmation_required'
test('non-JSON 502 → http_502', ...);
test('rejected fetch → status 0, network', ...);
test('verify with and without ageConfirmed', ...);  // bodies { token } and { token, ageConfirmed: true }
test('logout 204 → ok with data null', ...);
// account.test.ts
test('signed in loads account rules', ...); test('401 clears account and account rules', ...);
test('offline keeps cached account rules', ...); test('signOut clears even when logout fails offline', ...);
test('invalid account rules make activeRules an error', ...);
// headers-plugin.test.ts
test.each(['/auth/verify', '/auth/verify/', '/auth/verify/index.html'])('%s is a verify path', ...);
test('other paths are not', ...);   // '/', '/auth/verifyx', '/assets/a.js'
```
`signin.e2e.test.ts` (`page.route('**/api/auth/verify', ...)` records requests):
  - `const res = await page.goto(base + '/auth/verify?token=T0K3N')`. Then: `res.headers()['referrer-policy'] === 'no-referrer'`; `page.locator('head > meta[name="referrer"]').first()` has `content="no-referrer"` and is `head`'s first element child; `page.url()` does not contain `T0K3N`.
  - **No auto-submit:** wait 2000 ms, press Enter on `body`, and wait again → 0 verify requests.
  - Click "Sign me in", double-click it → exactly 1 request: `method POST`, `content-type: application/json`, body `{ token: 'T0K3N' }`. The button was disabled while pending.
  - 400 `age_confirmation_required`: the checkbox appears; "Create my account" stays disabled until it is ticked; the second request body is `{ token: 'T0K3N', ageConfirmed: true }`.
  - 401 → the "expired or has already been used" text and a link to `/#/settings`.
  - `offOrigin(requests)` is empty. The page's only script is same-origin. `expectNoA11yViolations`.
  - Main app: opening `/#/kitchen?token=X` makes no request to `/api/auth/verify`.
  - Settings: the request form (mocked 202) shows the neutral text, and a mocked 429 shows the same text. Signed in (mock `/api/me` 200 and `/api/rules` with the severe coconut rule) → `#/recipe/india/kerala/parippu` is blocked. Mock `/api/rules` returning a rule with an unknown id → "Couldn't check this dish". "Sign out" (mock 204) → the card is back to ok.
- [ ] **11.2 Run** `npm test -w @kitchenquest/game -- api build/headers` and `npm run test:e2e -w @kitchenquest/game -- e2e/signin.e2e.test.ts` → FAIL.
- [ ] **11.3 Implement.**
- [ ] **11.4 Run** both → PASS. Then manually against a running M2 API (when available): `npm run dev -w @kitchenquest/api` and `npm run dev -w @kitchenquest/game`; request a link in Settings; open the logged link → the page waits for the click → signed in.
- [ ] **11.5 Commit** `feat(game): typed API client, click-to-verify sign-in page, account rules`

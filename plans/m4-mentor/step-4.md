# Step 4 — API: AiProvider, OpenRouter policy, processor gate, no content logging

One interface for every AI call (spec §7). OpenRouter is the only implementation, and the data policy is pinned in code (C-14). The processor register gates whether AI can be switched on at all (P-11, N-9). Nothing the model reads or writes reaches a log (C-15). No test touches the network.

**Files:**
- Create: `apps/api/src/ai/provider.ts`, `apps/api/src/ai/openrouter.ts` (+ `openrouter.test.ts`), `apps/api/src/ai/processors.ts` (+ `processors-gate.test.ts`), `apps/api/test/helpers/fake-ai.ts`
- Modify: `apps/api/src/config.ts` (AI env), `apps/api/src/app.ts` (`Deps.ai: AiProvider | null`), `apps/api/src/server.ts` (build the provider from config), `apps/api/test/helpers/config.ts` (AI off by default), `apps/api/test/processors.test.ts` (N-9 schema), `docs/compliance/processors.json` (the policy the code pins, under `openrouter.retention` and `.training_use`; `status` is left alone, Step 12 owns it), `.env.example`
- Test: `apps/api/test/config.test.ts` (new; the existing `describe('loadConfig')` block moves here from `apps/api/test/health.test.ts`)
- Modify: `apps/api/package.json` (no new runtime dependency here; `fetch` is Node 22's)

**Interfaces:**
- Produces:
```ts
// ai/provider.ts
export type AiMessage =
  | { role: 'system'; content: string } | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: AiToolCall[] };
export interface AiTool { name: string; description: string; parameters: Record<string, unknown> }   // JSON schema
export interface AiToolCall { id: string; name: string; arguments: string }                           // raw JSON text, validated by the caller
export interface AiRequest { messages: AiMessage[]; tools: AiTool[]; signal?: AbortSignal }
export type AiFailure = 'timeout' | 'network' | 'http_4xx' | 'http_5xx' | 'invalid_response';
export type AiResult =
  | { ok: true; text: string; toolCalls: AiToolCall[]; finish: 'stop' | 'tool_calls' | 'length' | 'other'; usage: { inputTokens: number; outputTokens: number; costMicroUsd: number } }
  | { ok: false; failure: AiFailure; status?: number };
export interface AiProvider { readonly model: string; complete(req: AiRequest): Promise<AiResult> }   // never throws
// ai/openrouter.ts
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export interface AiConfig { apiKey: string; model: string; providers: string[]; timeoutMs: number; dailyBudgetMicroUsd: number }
export function buildRequestBody(cfg: AiConfig, req: AiRequest): Record<string, unknown>;
export function createOpenRouterProvider(cfg: AiConfig, deps: { fetch: typeof fetch; log: Pick<FastifyBaseLogger, 'warn'> }): AiProvider;
// ai/processors.ts
export const AI_PROCESSOR_IDS = ['openrouter', 'openrouter-model-providers'] as const;
export function processorsNotReady(ids: readonly string[], registerPath?: URL): string[];   // ids whose dpa_status !== 'signed'
// test/helpers/fake-ai.ts
export type FakeStep = AiResult | ((req: AiRequest) => AiResult);
export function fakeAi(steps: FakeStep[]): AiProvider & { requests: AiRequest[] };   // runs out → { ok: false, failure: 'network' }
export const reply = (text: string): AiResult;                                     // ok, finish 'stop', usage { 100, 10, 60 }
export const toolCall = (name: string, args: object, text?: string): AiResult;     // ok, finish 'tool_calls'
```
- `Config` gains `ai: AiConfig | null`. Env:
  - `AI_ENABLED`: `true` or `false`, default `false`. When false, `ai` is null and no other AI variable is read.
  - `OPENROUTER_API_KEY`: required when enabled.
  - `AI_MODEL`: default `qwen/qwen3.8-27b`. It must not end in `:free` (C-14), with the error "AI_MODEL: never use a :free variant for health-adjacent calls (C-14)".
  - `AI_PROVIDERS`: required when enabled. A comma list of OpenRouter provider slugs, non-empty, e.g. `tenstorrent,modelrun`. A comment points at spike §6.6: "re-check the order monthly from /models/qwen/qwen3.8-27b/endpoints; exclude fp4 providers".
  - `AI_DAILY_BUDGET_USD`: required when enabled, a number > 0, stored as micro-USD.
  - `AI_TIMEOUT_MS`: default `10000`, 1000–30000.
  - Production gate: when `NODE_ENV === 'production'` and enabled, `processorsNotReady(AI_PROCESSOR_IDS)` must be empty. Otherwise boot fails with "AI_ENABLED: OpenRouter's DPA is not signed in docs/compliance/processors.json (P-11, C-34). Leave AI_ENABLED=false until it is." Outside production, `server.ts` logs one warning line ("AI enabled outside production: synthetic data only (P-11)").
- `buildRequestBody` returns exactly these keys (C-14 and spike §6.6):
```json
{ "model": cfg.model, "messages": [...], "tools": [{ "type": "function", "function": { "name", "description", "parameters" } }],
  "tool_choice": "auto", "temperature": 0.3, "max_tokens": 200, "reasoning": { "enabled": false },
  "usage": { "include": true }, "stream": false,
  "provider": { "only": cfg.providers, "order": cfg.providers, "allow_fallbacks": true,
                "data_collection": "deny", "zdr": true, "require_parameters": true } }
```
  - It never sends `user`, `metadata`, `transforms`, `HTTP-Referer` or `X-Title`.
  - Headers are `authorization: Bearer <key>` and `content-type: application/json` only.
  - When `tools` is empty, omit `tools` and `tool_choice`.
  - `// VERIFY:` comment, from C-14: confirm the current OpenRouter names of `data_collection`, `zdr` and `only` before enabling in production; the processor review (Step 12) records the check.
- `complete`:
  - One `fetch` with an `AbortController` timeout of `cfg.timeoutMs`.
  - It retries once only on `network` or `http_5xx`, after 300 ms, and never on a timeout, a 4xx or an invalid response.
  - It parses `choices[0].message.content`, `.tool_calls`, `finish_reason` and `usage.prompt_tokens`, `usage.completion_tokens` and `usage.cost` (USD). `costMicroUsd = Math.round(cost * 1e6)`, and 0 when absent.
  - Anything malformed gives `invalid_response`.
  - It never throws.
  - On failure it logs one `warn` line, `{ ai: 'openrouter', failure, status }`, and **never** the request or response body or the error message, which may echo the prompt (C-15).
- `processors.test.ts` (N-9):
  - Every processor has `id`, `name`, `purpose`, `country`, `contact`, `status`, a non-empty `data_categories`, and `dpa_status` ∈ `unknown | needed | signed`.
  - Ids are unique.
  - Every outbound host in `apps/api/src/**/*.ts` maps to a processor id. Scan for `https://` literals: the only allowed host is `openrouter.ai`, mapped to `openrouter`.
  - Every module that names such a host also imports `processorsNotReady` or is `ai/openrouter.ts`, whose provider is built only behind the config gate.

- [ ] **4.1 Write the failing tests:**
```ts
// openrouter.test.ts (fetch is a fake recording (url, init); no network)
test('every request carries the pinned data policy and no identifiers', async () => {
  await provider.complete({ messages: [{ role: 'user', content: 'hello' }], tools: [] });
  const body = JSON.parse(calls[0].init.body);
  expect(body.provider).toEqual({ only: ['tenstorrent', 'modelrun'], order: ['tenstorrent', 'modelrun'], allow_fallbacks: true, data_collection: 'deny', zdr: true, require_parameters: true });
  expect(body).toMatchObject({ model: 'qwen/qwen3.8-27b', temperature: 0.3, max_tokens: 200, reasoning: { enabled: false } });
  expect(Object.keys(body)).not.toContain('user');
  expect(Object.keys(calls[0].init.headers).map((h) => h.toLowerCase()).sort()).toEqual(['authorization', 'content-type']);
});
test('parses text, tool calls, finish and cost', ...);           // usage.cost 0.00062 → costMicroUsd 620
test('5xx is retried once, then fails as http_5xx', ...);        // 2 fetch calls
test('timeout fails once, without retry', ...);                  // fake fetch that waits for the abort signal; 1 call; failure 'timeout'
test('4xx and malformed JSON are not retried', ...);
test('a failing call logs no content even when the error body echoes the prompt', async () => {
  // fake fetch → 400 with body '{"error":{"message":"bad request: I am allergic to peanut"}}'
  expect(logs.text()).not.toMatch(/peanut/i);
  expect(logs.text()).toMatch(/"failure":"http_4xx"/);
});
// config.test.ts (the loadConfig tests moved from health.test.ts, plus these)
test('AI off by default and no AI variable needed', ...);
test.each([['OPENROUTER_API_KEY'], ['AI_PROVIDERS'], ['AI_DAILY_BUDGET_USD']])('AI_ENABLED=true without %s fails naming it', ...);
test('a :free model is refused', ...);                           // AI_MODEL=qwen/qwen3.8-27b:free → error names C-14
test('production refuses AI while the OpenRouter DPA is not signed', ...);   // processors.json as committed (dpa_status unknown) → throws naming P-11
// processors-gate.test.ts
test('processorsNotReady lists unsigned ids', ...);              // a temp register file with openrouter 'signed', providers 'unknown' → ['openrouter-model-providers']
```
- [ ] **4.2 Run** `npm test -w @kitchenquest/api -- ai config processors` → FAIL.
- [ ] **4.3 Implement.** `buildApp` takes `deps.ai` as given, with `null` meaning AI off. `server.ts` builds it with `createOpenRouterProvider(config.ai, { fetch, log: app.log })` when `config.ai` is set. `.env.example` lists the AI variables with `AI_ENABLED=false` and, exactly, `AI_PROVIDERS=tenstorrent,modelrun` (Step 12's eval fingerprint reads this line), `AI_MODEL=qwen/qwen3.8-27b`, `# OPENROUTER_API_KEY=`, `# AI_DAILY_BUDGET_USD=`.
- [ ] **4.4 Run** `npm test -w @kitchenquest/api` and `npm run typecheck -w @kitchenquest/api` → PASS.
- [ ] **4.5 Commit** `feat(api): AiProvider over OpenRouter with pinned no-retention routing, DPA gate and content-free logging`

import { MENTOR_CLIENT_TIMEOUT_MS, type Plan, type ProgressEvent, type Rule, type Severity } from '@kitchenquest/core/engine';
import type {
  ApiErrorBody, ApiResult, ConfirmRequest, ConfirmResponse, ConsentPurpose, Consents, ConsentRecord, CurrentPlanResponse, MarketRunResponse, MealEntry, Me,
  PantryItem, PlanSaveResponse, Profile, ProgressPostResponse, ProgressResponse, RecipeDetail, RecipeSummary, ReplyPart, TurnRequest, TurnResponse,
} from './types';

/**
 * A typed client for the M2 API, reached same-origin under `/api` (the Vite servers proxy it; in production
 * the reverse proxy does). Every call resolves to an `ApiResult`, never throws, and never retries.
 */
export interface ApiClient {
  requestLink(email: string): Promise<ApiResult<{ ok: true }>>;                                            // POST /auth/request (202)
  verify(token: string, ageConfirmed?: true): Promise<ApiResult<{ user: { id: string; email: string } }>>; // POST /auth/verify
  logout(): Promise<ApiResult<null>>;                                                                      // POST /auth/logout (204)
  me(): Promise<ApiResult<Me>>;
  getProfile(): Promise<ApiResult<Profile>>;
  putProfile(p: Partial<Profile>): Promise<ApiResult<Profile>>;
  /** `versions`: each rule's write version, by id (M4 final N4), for a conditional `updateRule`. */
  listRules(): Promise<ApiResult<{ rules: Rule[]; versions?: Record<string, number> }>>;
  /** §7.0 "Writes need a yes": `confirmed` is the literal `true`, sent only after a read-back. Needs health_data consent (403 consent_required). */
  createRule(rule: Omit<Rule, 'id'>, confirmed: true): Promise<ApiResult<{ rule: Rule }>>;
  /** With `version` (If-Match, N4) the write lands only over that version: another one since is 409 `rule_changed`. */
  updateRule(id: string, rule: Omit<Rule, 'id'>, confirmed: true, version?: number): Promise<ApiResult<{ rule: Rule; version?: number }>>;
  deleteRule(id: string): Promise<ApiResult<null>>;
  /** 409 `rules_need_review` when stored rules no longer validate: treat every dish as unchecked. */
  listRecipes(): Promise<ApiResult<{ recipes: RecipeSummary[] }>>;
  getRecipe(slug: string): Promise<ApiResult<RecipeDetail>>;
  consents(): Promise<ApiResult<Consents>>;                                                                   // GET /me/consents
  grantConsent(purpose: ConsentPurpose, noticeVersion: string): Promise<ApiResult<{ consent: ConsentRecord }>>; // POST /me/consents (201)
  exportAccount(): Promise<ApiResult<unknown>>;                                                               // GET /me/export
  deleteAccount(confirm: 'delete my account'): Promise<ApiResult<null>>;                                     // DELETE /me (204)
  /** M4. The player's text rides in the POST body only, never in the URL (P-5). */
  mentorTurn(req: TurnRequest): Promise<ApiResult<TurnResponse>>;                                              // POST /mentor/turn
  /** A tap on a server card: the body is `{ channel: 'tap', edits? }`; the type has no other channel (§7.6b.1). */
  /** `today`: the player's local date, sent with every week write (a plan card's week window, Step 6 I2). */
  confirmProposal(id: string, edits?: { severity?: Severity }, conversationId?: string | null, today?: string): Promise<ApiResult<ConfirmResponse>>; // POST /mentor/proposals/:id/confirm
  rejectProposal(id: string): Promise<ApiResult<{ parts: ReplyPart[] }>>;                                      // POST /mentor/proposals/:id/reject
  undoWrite(id: string): Promise<ApiResult<{ parts: ReplyPart[]; undone: boolean }>>;                                        // POST /mentor/writes/:id/undo
  forgetConversations(): Promise<ApiResult<null>>;                                                            // DELETE /mentor/conversations (204)
  withdrawConsent(purpose: ConsentPurpose, healthData?: 'delete' | 'keep'): Promise<ApiResult<null>>;         // DELETE /me/consents/:purpose (204)
  /** Needs health_data consent (403 consent_required). */
  createMeal(meal: MealEntry, confirmed: true): Promise<ApiResult<{ meal: MealEntry & { id: string } }>>;    // POST /meals (201)
  deleteMeal(id: string): Promise<ApiResult<null>>;                                                           // DELETE /meals/:id (204)
  getPantry(): Promise<ApiResult<{ items: (PantryItem & { id: string })[] }>>;                                // GET /pantry
  changePantry(
    change: { add: PantryItem[]; removeNames: string[]; removeIds: string[] }, confirmed: true,
  ): Promise<ApiResult<{ items: (PantryItem & { id: string })[]; removed: (PantryItem & { id: string })[]; addedIds: string[] }>>; // POST /pantry/changes
  /** M5 Step 5: the account's progress view. */
  getProgress(): Promise<ApiResult<ProgressResponse>>;                                                         // GET /progress
  /**
   * M5 Step 5: at most 100 content-free events (the server computes what they earn). `upload` marks the sign-in
   * upload of the device log (Ruling 8): older dates and `imported` events are accepted. 429 `rate_limited` carries
   * `retryAfterSeconds`.
   */
  postProgressEvents(events: ProgressEvent[], upload?: true): Promise<ApiResult<ProgressPostResponse>>;        // POST /progress/events
  /**
   * M5 Step 6, the week. Every call sends `today`, the player's local date (I2): the server reads the plan week from it.
   * Plans and runs are health data (Step 6 ruling): writes are 403 `consent_required` without `health_data`.
   */
  getPlan(today: string): Promise<ApiResult<CurrentPlanResponse>>;                                              // GET /plans/current?today=
  /** §7.0: `confirmed: true` goes only after the player's tap. 400 `plan_invalid` (a ⛔ item, a bad week) writes nothing. */
  putPlan(plan: Plan, today: string): Promise<ApiResult<PlanSaveResponse>>;                                      // PUT /plans/:weekStart
  deletePlan(weekStart: string): Promise<ApiResult<null>>;                                                       // DELETE /plans/:weekStart (204)
  openRun(weekStart: string, today: string): Promise<ApiResult<MarketRunResponse>>;                              // POST /market-runs
  /** §7.0 "None (undoable)": no `confirmed`; unticking is the undo. 409 `run_closed` once the run is done. */
  tick(runId: string, key: string, ticked: boolean, today: string): Promise<ApiResult<MarketRunResponse>>;      // POST /market-runs/:id/ticks
  /** "That's the shop done": a tap, so `confirmed: true`. */
  finishRun(runId: string, today: string): Promise<ApiResult<MarketRunResponse>>;                                // POST /market-runs/:id/finish
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** M2's `{ error: { code, message, details? } }`, or null when the body has some other shape. */
function m2Error(body: unknown): ApiErrorBody | null {
  if (!isObj(body) || !isObj(body.error)) return null;
  const { code, message, details } = body.error;
  if (typeof code !== 'string') return null;
  return { code, message: typeof message === 'string' ? message : '', ...(details === undefined ? {} : { details }) };
}

/**
 * How long a mentor turn or a consents read may take before it counts as unreachable (status 0), so a stalled
 * connection never holds the Pan's turn queue (fix round 5, H1). Core's MENTOR_CLIENT_TIMEOUT_MS: above the server's
 * own turn deadline (MENTOR_TURN_DEADLINE_MS, M4 final J2), so the server always answers first.
 */
const MENTOR_TIMEOUT_MS = MENTOR_CLIENT_TIMEOUT_MS;

export function createApiClient(opts: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): ApiClient {
  const timeoutMs = opts.timeoutMs ?? MENTOR_TIMEOUT_MS;
  const base = (opts.baseUrl ?? '/api').replace(/\/+$/, '');
  // Bound, so a bare `window.fetch` reference is not called with the wrong `this`.
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, timeout?: number, headers: Record<string, string> = {},
  ): Promise<ApiResult<T>> {
    const init: RequestInit = { method, credentials: 'same-origin' };
    // A timed call that runs out (headers or body) reads as unreachable: status 0, never a pending promise.
    if (timeout !== undefined) init.signal = AbortSignal.timeout(timeout);
    if (method !== 'GET') {
      // JSON only: M2 refuses text/plain. Fastify also refuses an empty application/json body, so send {}.
      init.headers = { 'content-type': 'application/json', ...headers };
      init.body = JSON.stringify(body ?? {});
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, init);
    } catch (err) {
      return { ok: false, status: 0, error: { code: init.signal?.aborted ? 'timeout' : 'network', message: err instanceof Error ? err.message : String(err) } };
    }
    if (res.status === 204) return res.ok ? { ok: true, status: 204, data: null as T } : httpError(res);
    let parsed: unknown;
    let isJson = true;
    try { parsed = await res.json(); } catch {
      if (init.signal?.aborted) return { ok: false, status: 0, error: { code: 'timeout', message: 'The response did not arrive in time' } };
      isJson = false;
    }
    if (res.ok) {
      return isJson
        ? { ok: true, status: res.status, data: parsed as T }
        : { ok: false, status: res.status, error: { code: 'bad_response', message: 'The response was not JSON' } };
    }
    const error = (isJson ? m2Error(parsed) : null) ?? httpError(res).error;
    const retry = Number(res.headers.get('retry-after'));
    if (res.status === 429 && res.headers.has('retry-after') && Number.isFinite(retry)) error.retryAfter = retry;
    return { ok: false, status: res.status, error };
  }

  const httpError = (res: Response): { ok: false; status: number; error: ApiErrorBody } =>
    ({ ok: false, status: res.status, error: { code: `http_${res.status}`, message: res.statusText } });

  const enc = encodeURIComponent;

  return {
    requestLink: (email) => call('POST', '/auth/request', { email }),
    verify: (token, ageConfirmed) => call('POST', '/auth/verify', ageConfirmed ? { token, ageConfirmed } : { token }),
    logout: () => call('POST', '/auth/logout'),
    me: () => call('GET', '/me'),
    getProfile: () => call('GET', '/profile'),
    putProfile: (p) => call('PUT', '/profile', p),
    listRules: () => call('GET', '/rules'),
    createRule: (rule, confirmed) => call('POST', '/rules', { rule, confirmed }),
    updateRule: (id, rule, confirmed, version) =>
      call('PUT', `/rules/${enc(id)}`, { rule, confirmed }, undefined, version === undefined ? {} : { 'if-match': `"${version}"` }),
    deleteRule: (id) => call('DELETE', `/rules/${enc(id)}`),
    listRecipes: () => call('GET', '/recipes'),
    getRecipe: (slug) => call('GET', `/recipes/${slug.split('/').map(enc).join('/')}`),
    consents: () => call('GET', '/me/consents', undefined, timeoutMs),
    grantConsent: (purpose, noticeVersion) => call('POST', '/me/consents', { purpose, noticeVersion, method: 'tap' }),
    exportAccount: () => call('GET', '/me/export'),
    deleteAccount: (confirm) => call('DELETE', '/me', { confirm }),
    mentorTurn: (req) => call('POST', '/mentor/turn', req, timeoutMs),
    confirmProposal: (id, edits, conversationId, today) => {
      const body: ConfirmRequest = {
        channel: 'tap', ...(edits === undefined ? {} : { edits }), ...(conversationId === undefined ? {} : { conversationId }),
        ...(today === undefined ? {} : { today }),
      };
      return call('POST', `/mentor/proposals/${enc(id)}/confirm`, body);
    },
    rejectProposal: (id) => call('POST', `/mentor/proposals/${enc(id)}/reject`),
    undoWrite: (id) => call('POST', `/mentor/writes/${enc(id)}/undo`),
    forgetConversations: () => call('DELETE', '/mentor/conversations'),
    withdrawConsent: (purpose, healthData) => call('DELETE', `/me/consents/${enc(purpose)}`, healthData === undefined ? {} : { healthData }),
    createMeal: (meal, confirmed) => call('POST', '/meals', { meal, confirmed }),
    deleteMeal: (id) => call('DELETE', `/meals/${enc(id)}`),
    getPantry: () => call('GET', '/pantry'),
    changePantry: (change, confirmed) => call('POST', '/pantry/changes', { ...change, confirmed }),
    getProgress: () => call('GET', '/progress', undefined, timeoutMs),
    postProgressEvents: (events, upload) => call('POST', '/progress/events', upload ? { events, upload } : { events }, timeoutMs),
    getPlan: (today) => call('GET', `/plans/current?today=${enc(today)}`),
    putPlan: (plan, today) => call('PUT', `/plans/${enc(plan.weekStart)}`, { plan, confirmed: true, today }),
    deletePlan: (weekStart) => call('DELETE', `/plans/${enc(weekStart)}`),
    openRun: (weekStart, today) => call('POST', '/market-runs', { weekStart, today }),
    tick: (runId, key, ticked, today) => call('POST', `/market-runs/${enc(runId)}/ticks`, { key, ticked, today }),
    finishRun: (runId, today) => call('POST', `/market-runs/${enc(runId)}/finish`, { confirmed: true, today }),
  };
}

/**
 * Whether the player may save health data (rules) now. 'reconsent' when their grant is under a notice
 * version that no longer counts: show the current notice again. A stale grant never counts as granted.
 */
export function healthConsent(c: Consents): 'granted' | 'reconsent' | 'missing' {
  const active = c.consents.filter((x) => x.purpose === 'health_data' && x.withdrawnAt === null);
  if (c.needsReconsent.includes('health_data') || active.some((x) => !x.current)) return 'reconsent';
  return active.length > 0 ? 'granted' : 'missing';
}

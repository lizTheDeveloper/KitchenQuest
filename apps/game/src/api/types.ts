/**
 * The M2 API's shapes, typed against the route code in apps/api/src (auth, profile, rules, recipes, consent,
 * account). The game never trusts these at runtime for safety: rules are re-validated by core's
 * `validateRules` (through `activeRules`) before any check uses them.
 */
import type { CheckResult, CheckStatus, NutritionResult, RecipeIngredient, RecipeMeta } from '@kitchenquest/core/engine';

/**
 * M2 errors are `{ error: { code, message, details? } }` (apps/api/src/app.ts). `retryAfter` (seconds) is
 * read from a 429's `retry-after` header. The client also makes three codes of its own: `network` (fetch
 * rejected, status 0), `http_<status>` (an error response that isn't M2 JSON) and `bad_response` (a 2xx whose
 * body isn't JSON).
 */
export interface ApiErrorBody { code: string; message: string; details?: unknown; retryAfter?: number }

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiErrorBody };

/** GET /me */
export interface Me { id: string; email: string; entitlements: string[] }

/** N-7: a meal window's name is one of a fixed set (apps/api/src/profile/store.ts). */
export type MealWindowName = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other';
export interface MealWindow { name: MealWindowName; start: string; end: string }   // HH:MM, start < end
/** GET/PUT /profile. PUT takes any subset; omitted fields are left unchanged. */
export interface Profile { marketDays: number[]; mealsPerWeek: number | null; country: string | null; region: string | null; mealWindows: MealWindow[] }

/** GET /recipes, one entry. */
export interface RecipeSummary {
  slug: string; title: string; country: string; region: string; status: string;
  check: { status: CheckStatus; severe: boolean; disclaimer: string | null };
}
/** GET /recipes/<slug>. `meta` omits the parsed contributors. */
export interface RecipeDetail {
  slug: string; title: string; meta: Omit<RecipeMeta, 'contributors'>; source: string;
  ingredients: RecipeIngredient[]; check: CheckResult; nutrition: NutritionResult;
}

export type ConsentPurpose = 'health_data' | 'ai_health' | 'voice' | 'pantry_location' | 'research';
export interface ConsentRecord {
  purpose: ConsentPurpose; noticeVersion: string; noticeSha256: string; method: 'tap' | 'api';
  grantedAt: string; withdrawnAt: string | null; endedReason: 'withdrawn' | 'superseded' | null;
  /** False when the grant was under a notice version that no longer counts. */
  current: boolean;
}
/** GET /me/consents. `needsReconsent`: purposes whose active grant is under a stale notice: show it again. */
export interface Consents {
  consents: ConsentRecord[]; needsReconsent: ConsentPurpose[];
  notices: Partial<Record<ConsentPurpose, { version: string; text: string }>>;
}


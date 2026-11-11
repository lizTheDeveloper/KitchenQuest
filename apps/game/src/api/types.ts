/**
 * The M2 API's shapes, typed against the route code in apps/api/src (auth, profile, rules, recipes, consent,
 * account). The game never trusts these at runtime for safety: rules are re-validated by core's
 * `validateRules` (through `activeRules`) before any check uses them.
 */
import type {
  CheckResult, CheckStatus, MarginNote, MarketRunView, NutritionResult, Plan, PlanItemCheck, ProgressView, RecipeIngredient, RecipeMeta, RewardGrant,
} from '@kitchenquest/core/engine';

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
type MealWindowName = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other';
interface MealWindow { name: MealWindowName; start: string; end: string }   // HH:MM, start < end
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


/** The mentor wire protocol and card shapes, from core, so the game and the API never drift (M4). */
export type { ConfirmRequest, ConfirmResponse, MealEntry, PantryItem, ReplyPart, TurnRequest, TurnResponse } from '@kitchenquest/core/engine';

/** GET /progress (Step 5): the account's view, derived by the server from its two ledgers. */
export interface ProgressResponse { view: ProgressView }
/**
 * POST /progress/events (Step 5). `accepted` grants are computed by the server with core (no `createdAt`: a grant
 * carries only its kind, amount and day). `duplicate`: ids already recorded (a replay). `rejected`: core's problems,
 * plus the API's own (`bad_event`, `bad_date`, `upload_only`, `consent_required`, `unknown_meal_log`). `warnings`:
 * accepted events with something set aside (`stand_in_dropped`).
 */
export interface ProgressPostResponse {
  accepted: { clientId: string; grants: RewardGrant[] }[];
  duplicate: string[];
  rejected: { clientId: string; problems: string[] }[];
  warnings: { clientId: string; warnings: string[] }[];
  view: ProgressView;
}

/**
 * GET /plans/current?today= (Step 6): the player's current plan week, from their market days and their local date,
 * its plan (or null) with the server's row id, and each item checked now with their rules as they are now.
 */
export interface CurrentPlanResponse { plan: (Plan & { id: string }) | null; weekStart: string; checks: PlanItemCheck[] }
/** PUT /plans/:weekStart (Step 6): the plan as stored, checked now. */
export interface PlanSaveResponse { plan: Plan & { id: string }; checks: PlanItemCheck[] }
/** POST /market-runs, its ticks and its finish (Step 6): the run, its unticked rows recomputed now (C40). */
export type MarketRunResponse = MarketRunView;

/** A margin note as the API stores it (Step 7): core's `MarginNote` and the row id. */
type StoredNote = MarginNote & { id: string };
/** GET /notes (Step 7, C32): every note the player has; the client filters by recipe. No query, ever. */
export interface NotesResponse { notes: StoredNote[] }
/**
 * POST /notes (201): the note as stored, and `check`, core `checkWithNotes` over all the player's notes on that recipe
 * with their rules now: what "cook with my notes" will show.
 */
export interface NoteSaveResponse { note: StoredNote & { check: CheckResult } }

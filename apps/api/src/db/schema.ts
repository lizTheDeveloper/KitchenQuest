import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable("users", {
  id: id(),
  email: citext("email").notNull().unique(),
  ageConfirmedAt: ts("age_confirmed_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const loginTokens = pgTable(
  "login_tokens",
  {
    id: id(),
    email: citext("email").notNull(),
    tokenHash: bytea("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("login_tokens_email_idx").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const profiles = pgTable(
  "profiles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    marketDays: smallint("market_days")
      .array()
      .notNull()
      .default(sql`'{}'`),
    mealsPerWeek: smallint("meals_per_week"),
    country: text("country"),
    region: text("region"),
    mealWindows: jsonb("meal_windows")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Set by every write from the app's injected clock; defaultNow() is only a fallback. */
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId] })],
);

/**
 * `sealed` is the core Rule minus its id, sealed with `sealFor` under the
 * context { table: 'rules', userId, rowId: id }; the row id (generated before
 * insert) is the rule id.
 */
export const rules = pgTable(
  "rules",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sealed: bytea("sealed").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** Set by every write from the app's injected clock; defaultNow() is only a fallback. */
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("rules_user_id_idx").on(t.userId)],
);

export const canonRecipes = pgTable("canon_recipes", {
  path: text("path").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  country: text("country").notNull(),
  region: text("region"),
  status: text("status").notNull(),
  source: text("source").notNull(),
  contentHash: text("content_hash").notNull(),
  /** Contributor ids exactly as given in the front matter (personal data: never logged or normalised; `source` also carries them, being the public file). */
  contributors: text("contributors")
    .array()
    .notNull()
    .default(sql`'{}'`),
  syncedAt: ts("synced_at").notNull().defaultNow(),
});

/** Never holds price, payment or card data; payments live with the payment provider. */
export const entitlements = pgTable(
  "entitlements",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("entitlements_user_id_idx").on(t.userId)],
);

/** Content-free: counts and cost only, never a prompt, transcript or response. */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
    units: integer("units").notNull(),
    costMicroUsd: integer("cost_microusd").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("usage_events_user_feature_idx").on(t.userId, t.feature, t.createdAt)],
);

/**
 * C-4: one random data key per user, wrapped (AES-256-GCM) by the key ring key
 * `key_id`. Health columns are sealed with it, so deleting this row (cascade on
 * account delete) makes every copy of that user's health data unreadable,
 * backups included.
 */
export const userKeys = pgTable("user_keys", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(),
  wrapped: bytea("wrapped").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const CONSENT_PURPOSES = ["health_data", "ai_health", "voice", "pantry_location", "research"] as const;
export const CONSENT_METHODS = ["tap", "api"] as const;
export const CONSENT_ENDED_REASONS = ["withdrawn", "superseded"] as const;
const inList = (list: readonly string[]) => sql.raw(list.map((v) => `'${v}'`).join(", "));

/**
 * C-1: the consent ledger. One row per grant; `withdrawn_at` ends it and
 * `ended_reason` says why: `withdrawn` by the player, or `superseded` by a
 * grant under a newer notice. Rows are never deleted while the account
 * exists, so the history is complete.
 */
export const consents = pgTable(
  "consents",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    noticeVersion: text("notice_version").notNull(),
    noticeSha256: bytea("notice_sha256").notNull(),
    grantedAt: ts("granted_at").notNull(),
    withdrawnAt: ts("withdrawn_at"),
    endedReason: text("ended_reason"),
    method: text("method").notNull(),
  },
  (t) => [
    index("consents_user_purpose_idx").on(t.userId, t.purpose),
    uniqueIndex("consents_one_active_idx")
      .on(t.userId, t.purpose)
      .where(sql`${t.withdrawnAt} is null`),
    check("consents_purpose_check", sql`${t.purpose} in (${inList(CONSENT_PURPOSES)})`),
    check("consents_method_check", sql`${t.method} in (${inList(CONSENT_METHODS)})`),
    check("consents_sha256_check", sql`octet_length(${t.noticeSha256}) = 32`),
    check("consents_ended_reason_check", sql`${t.endedReason} in (${inList(CONSENT_ENDED_REASONS)})`),
    check("consents_ended_check", sql`(${t.withdrawnAt} is null) = (${t.endedReason} is null)`),
  ],
);

export const AUDIT_ACTOR_KINDS = ["user", "system", "operator", "script"] as const;

/**
 * C-5: content-free access and security log. Never holds health content, an
 * email or a token. `subject_user_id`/`actor_id` are plain text with no
 * foreign key so the trail outlives the account; on account delete they are
 * pseudonymized (`p:` + HMAC). Append-only: a trigger (migration
 * 0004_audit_append_only) rejects UPDATE, DELETE and TRUNCATE except through
 * `audit_pseudonymize()` and `audit_purge_before()`.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: ts("at").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id"),
    subjectUserId: text("subject_user_id"),
    action: text("action").notNull(),
    target: text("target"),
    requestId: text("request_id"),
  },
  (t) => [
    index("audit_events_subject_idx").on(t.subjectUserId),
    index("audit_events_actor_idx").on(t.actorId),
    index("audit_events_at_idx").on(t.at),
    check("audit_events_actor_kind_check", sql`${t.actorKind} in (${inList(AUDIT_ACTOR_KINDS)})`),
  ],
);

export const SELF_READ_RESOURCES = ["rules"] as const;

/**
 * C-5: the player's routine reads of their own health data, counted per user,
 * resource and UTC day rather than logged one event per read, so no
 * behavioural log (when they looked) is built. Holds no content. Deleted with
 * the account; exported with it (Step 7).
 */
export const selfReadCounts = pgTable(
  "self_read_counts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.resource, t.day] }),
    check("self_read_counts_resource_check", sql`${t.resource} in (${inList(SELF_READ_RESOURCES)})`),
    check("self_read_counts_count_check", sql`${t.count} > 0`),
  ],
);

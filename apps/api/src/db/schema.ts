import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
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
    /** +1 on every update: `PUT /rules/:id` with `If-Match` writes only over the version the client read (M4 final N4). */
    version: integer("version").notNull().default(1),
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

/**
 * Never holds price, payment or card data; payments live with the payment provider. Never an accessibility need either
 * (M7 Step 4, Ruling 6, C-19): that is health data, sealed in `voice_settings`; the check refuses the retired
 * `accessibility_voice` kind (migration 0022 deleted any such row first).
 */
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
  (t) => [
    index("entitlements_user_id_idx").on(t.userId),
    check("entitlements_retired_kind_check", sql`${t.kind} <> 'accessibility_voice'`),
  ],
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
 * The AI's spend per hour, across all players, for the global daily budget
 * (`BudgetGuard`, M4 Step 7 fix round 1, P5). No user id and no content: an
 * account delete never takes its spend out of the budget. Kept 48 hours.
 */
export const aiCostHours = pgTable("ai_cost_hours", {
  hour: ts("hour").primaryKey(),
  costMicroUsd: bigint("cost_microusd", { mode: "number" }).notNull(),
});

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
    /**
     * C-45 reserve (M5 Step 7, Ruling 19): whose consent this is. Every row is `'user'` (the account holder), and the
     * check refuses anything else until M13 adds child profiles (P-9: no child data before counsel signs off).
     */
    subjectKind: text("subject_kind").notNull().default("user"),
    /** C-45 reserve: the subject's id when it is not the account holder (M13). Always null until then. */
    subjectId: uuid("subject_id"),
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
    check("consents_subject_kind_check", sql`${t.subjectKind} = 'user'`),
    // C-45 reserve (fix round 1, M3): no other subject until M13, which replaces this with
    // `(subject_kind = 'user') = (subject_id is null)`.
    check("consents_subject_id_check", sql`${t.subjectId} is null`),
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

export const SELF_READ_RESOURCES = ["rules", "meals", "pantry", "progress", "plans", "notes", "voice"] as const;

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

/** Core's `MEAL_SLOTS` (= M2's meal-window names); `test/meals.test.ts` checks they are equal. */
export const MEAL_LOG_SLOTS = ["breakfast", "lunch", "dinner", "snack", "other"] as const;

/**
 * H-7 / C-23: what the player ate. `sealed` is core's `MealItem` (the dish
 * slug and servings, or the free description), sealed with `sealFor` under
 * { table: 'meal_logs', userId, rowId: id }. The date and slot stay plain:
 * C-23 allows it, and the range read and the prompt context need them.
 * Health data (`HEALTH_TABLES`): deleted by a withdraw-with-delete of `health_data`.
 */
export const mealLogs = pgTable(
  "meal_logs",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eatenOn: date("eaten_on", { mode: "string" }).notNull(),
    slot: text("slot").notNull(),
    sealed: bytea("sealed").notNull(),
    /** Set from the app's injected clock; defaultNow() is only a fallback. */
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("meal_logs_user_eaten_on_idx").on(t.userId, t.eatenOn),
    check("meal_logs_slot_check", sql`${t.slot} in (${inList(MEAL_LOG_SLOTS)})`),
  ],
);

/**
 * H-11: what is in the player's pantry. `sealed` is core's `PantryItem`
 * (name and ingredient id), sealed with `sealFor` under
 * { table: 'pantry_items', userId, rowId: id }. Sealed although its basis is
 * contract, since contents can imply a diet ([lawyer] whether it needs
 * `health_data`); not in `HEALTH_TABLES`, so a health-data withdrawal keeps it.
 */
export const pantryItems = pgTable(
  "pantry_items",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sealed: bytea("sealed").notNull(),
    /** Set from the app's injected clock; defaultNow() is only a fallback. */
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("pantry_items_user_id_idx").on(t.userId)],
);

/**
 * A Pan conversation (M4 Step 6, C-12). Content-free: owner, times and the
 * turn counter only. What was said is in `messages`, and only with
 * `health_data` consent.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Set from the app's injected clock; defaultNow() is only a fallback. */
    startedAt: ts("started_at").notNull().defaultNow(),
    lastTurnAt: ts("last_turn_at").notNull().defaultNow(),
    turnSeq: integer("turn_seq").notNull().default(0),
    /** The last turn's `turnKey` (a client UUID, content-free): a repeat of it is never processed again (M4 final J2). */
    lastTurnKey: text("last_turn_key"),
  },
  (t) => [index("conversations_user_id_idx").on(t.userId), index("conversations_last_turn_at_idx").on(t.lastTurnAt)],
);

export const MESSAGE_ROLES = ["player", "pan"] as const;

/**
 * One transcript message (I-1, C-12): `sealed` is the mentor's `StoredMessage`,
 * sealed S-U with AAD `{ table: 'messages', userId, rowId }`. Kept 30 days.
 */
export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    sealed: bytea("sealed").notNull(),
    /** Set from the app's injected clock; defaultNow() is only a fallback. */
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_conversation_seq_idx").on(t.conversationId, t.seq),
    index("messages_user_id_idx").on(t.userId),
    index("messages_created_at_idx").on(t.createdAt),
    check("messages_role_check", sql`${t.role} in (${inList(MESSAGE_ROLES)})`),
  ],
);

/** Core's `ProposalKind`, as stored (`mentor/proposals.ts` checks the two agree). */
export const PROPOSAL_KINDS = ["rule", "meal", "profile", "pantry", "plan", "check_off"] as const;
export const PROPOSAL_STATUSES = ["open", "confirmed", "rejected", "expired", "undone"] as const;
// M7 Step 6 (Ruling 12): `spoken_yes`, a transcript's strict yes on a non-severe card.
export const PROPOSAL_CHANNELS = ["tap", "typed_yes", "spoken_yes"] as const;

/**
 * A proposal card the server showed (I-4, M4 Step 6): what Step 8's guard
 * checks before any write. `sealed` is core's `ProposalCard`, sealed S-U with
 * AAD `{ table: 'mentor_proposals', userId, rowId }`; `undo_sealed` the
 * write's undo payload under `{ table: 'mentor_proposals.undo', userId, rowId }`.
 * Short-lived: deleted 24 hours after it was made.
 */
export const mentorProposals = pgTable(
  "mentor_proposals",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    turnSeq: integer("turn_seq"),
    kind: text("kind").notNull(),
    severe: boolean("severe").notNull(),
    status: text("status").notNull(),
    sealed: bytea("sealed").notNull(),
    undoSealed: bytea("undo_sealed"),
    writeRef: uuid("write_ref"),
    channel: text("channel"),
    /** Set from the app's injected clock; defaultNow() is only a fallback. */
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    decidedAt: ts("decided_at"),
  },
  (t) => [
    index("mentor_proposals_user_id_idx").on(t.userId),
    index("mentor_proposals_conversation_turn_idx").on(t.conversationId, t.turnSeq),
    index("mentor_proposals_created_at_idx").on(t.createdAt),
    check("mentor_proposals_kind_check", sql`${t.kind} in (${inList(PROPOSAL_KINDS)})`),
    check("mentor_proposals_status_check", sql`${t.status} in (${inList(PROPOSAL_STATUSES)})`),
    check("mentor_proposals_channel_check", sql`${t.channel} in (${inList(PROPOSAL_CHANNELS)})`),
  ],
);

/** Core's `ProgressEventKind`, as stored (`progress/store.ts` checks the two agree). */
export const PROGRESS_KINDS = [
  "lesson",
  "drill",
  "cooked",
  "frame_cooked",
  "quest_step",
  "quest_done",
  "recognized",
  "market_run",
  "meal_logged",
  "imported",
  "stall_round",
] as const;
/** Core's `RewardGrant['kind']`, as stored (`progress/store.ts` checks the two agree). */
export const GRANT_KINDS = ["xp", "stamp", "trust", "level", "certificate"] as const;

/**
 * U-5 (Ruling 7): what happened in play, as content-free facts. `client_id` is the game's own event id (idempotent
 * replay and the sign-in upload, Ruling 8); `at` the player's local date. `body` is the rest of core's
 * `ProgressEvent` as accepted by `grantsFor` (ids and numbers only, each checked against the catalogue, so no free
 * text lands in it). Plain, on the contract basis: not health data, though dish slugs reveal what was cooked
 * ([lawyer], inventory U-5). A `meal_logged` row is erased by a meal-log undo or a `health_data` delete; its grants stay.
 * A `stall_round` row (M6 Step 6) is sealed: `body` is `{}` and `sealed` holds the whole body (the stall and every
 * answer, each question id with its pick), S-U with AAD `{ table: 'progress_events', userId, rowId }` (Task 3 privacy
 * ruling: every round, by kind, since answered ids can imply a rule over time). A `health_data` delete erases every
 * `stall_round` row (Task 3 ruling I2); its grants stay.
 */
export const progressEvents = pgTable(
  "progress_events",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Insertion order: the fold replays events in the order `grantsFor` saw them (grants are fixed in that order). */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    clientId: text("client_id").notNull(),
    kind: text("kind").notNull(),
    at: date("at", { mode: "string" }).notNull(),
    body: jsonb("body").notNull(),
    /**
     * A `meal_logged` event's meal log (I1 ruling): set for that kind only, one event per log. Deleting the log (an
     * undo, a `health_data` delete) cascades here, so the record of when they ate goes with it, server-side.
     */
    mealLogId: uuid("meal_log_id").references(() => mealLogs.id, { onDelete: "cascade" }),
    /**
     * M6 Step 6: a `stall_round`'s whole body, sealed per row (`progress/seal.ts`); set for that kind only and always
     * for it (the check below), so no round's stall or question ids are ever stored in the clear.
     */
    sealed: bytea("sealed"),
    /** Set from the app's injected clock; defaultNow() is only a fallback. */
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("progress_events_user_client_idx").on(t.userId, t.clientId),
    index("progress_events_user_at_idx").on(t.userId, t.at),
    uniqueIndex("progress_events_meal_log_idx")
      .on(t.userId, t.mealLogId)
      .where(sql`${t.mealLogId} is not null`),
    check("progress_events_kind_check", sql`${t.kind} in (${inList(PROGRESS_KINDS)})`),
    check("progress_events_meal_log_check", sql`(${t.kind} = 'meal_logged') = (${t.mealLogId} is not null)`),
    check("progress_events_sealed_check", sql`(${t.kind} = 'stall_round') = (${t.sealed} is not null)`),
  ],
);

/**
 * U-5 (Ruling 7, spec §6): what an event earned, fixed when granted and never reversed. `body` is the rest of core's
 * self-contained `RewardGrant` (its own id, the event's client id (a UUID), the day and the amount; no event content
 * and no time of day).
 * `event_id` is the `progress_events` row it was granted for, a plain column on purpose, not a foreign key: erasing
 * a `meal_logged` event (undo, `health_data` delete) keeps its grants, so XP never drops. Append-only: there is no
 * update or delete path; only account delete (the `user_id` cascade) removes a grant.
 */
export const rewardGrants = pgTable(
  "reward_grants",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    kind: text("kind").notNull(),
    /** No time column on purpose (I2 ruling): a grant's only date is its `isoDay`, so a kept grant carries no time finer than the day. */
    body: jsonb("body").notNull(),
  },
  (t) => [
    index("reward_grants_user_id_idx").on(t.userId),
    check("reward_grants_kind_check", sql`${t.kind} in (${inList(GRANT_KINDS)})`),
  ],
);

/**
 * U-6 (M6 Step 7, Ruling 18; M5 m12): a cache of the player's progress fold, never a record. `sealed` is core's
 * `ProgressSnapshot` (`{ view, facts }`) of every event with `seq <= upto_seq` and every grant made for them or for an
 * event already erased, sealed S-U with AAD `{ table: 'progress_snapshots', userId, rowId: userId }` (the view holds
 * dish slugs, answered stall question ids, Protein Counter ones included, and trust per cook). `catalogue_hash` is the
 * catalogue, rewards and freshness it was folded under: a different hash, or a blob that won't open, and it is ignored
 * and rebuilt from the ledgers. A trigger (`progress_events_drop_snapshot`, migration 0020) deletes the row whenever any
 * of the player's progress events is deleted (a meal-log undo's cascade, a `health_data` delete), in the same
 * transaction, so a snapshot never outlives an erased event. Written under `progress:` (last in the table order); account
 * delete cascades.
 */
export const progressSnapshots = pgTable("progress_snapshots", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  uptoSeq: bigint("upto_seq", { mode: "number" }).notNull(),
  catalogueHash: text("catalogue_hash").notNull(),
  sealed: bytea("sealed").notNull(),
  /** Set from the app's injected clock. */
  createdAt: ts("created_at").notNull(),
});

/**
 * H-11 (M5 Step 6, Ruling 18): one weekly plan per plan week. `sealed` is core's `Plan` minus `weekStart` (dish and
 * lesson slugs per day, servings, the hard-week flag and the One More Technique slot), sealed S-U with AAD
 * `{ table: 'meal_plans', userId, rowId }`. `week_start` stays plain: a date only, needed for the lookup and the
 * retention job. Health data (Step 6 ruling, conservative: the dishes chosen can reveal a diet, a religion or a
 * condition, GDPR Art. 9, WA MHMDA): written only with `health_data`, in `HEALTH_TABLES`. Deleted 8 weeks after its
 * week ends (`PLAN_RETENTION_WEEKS`).
 */
export const mealPlans = pgTable(
  "meal_plans",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    weekStart: date("week_start", { mode: "string" }).notNull(),
    sealed: bytea("sealed").notNull(),
    /** Set from the app's injected clock; defaultNow() is only a fallback. */
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("meal_plans_user_week_idx").on(t.userId, t.weekStart)],
);

/**
 * H-11 (M5 Step 6, Ruling 16, C20): the market run built from a plan, one per plan. `sealed` is
 * `{ items: ListItem[], pantryIds: Record<key, pantryItemId> }` (the list rows with their ticks, and the pantry row
 * each tick added, so an untick removes exactly that row), sealed S-U with AAD `{ table: 'market_runs', userId, rowId }`.
 * Health data as `meal_plans` (a listed swap shows what a rule hit). Goes with its plan (cascade) and with retention.
 */
export const marketRuns = pgTable(
  "market_runs",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => mealPlans.id, { onDelete: "cascade" }),
    sealed: bytea("sealed").notNull(),
    /** Set once by "That's the shop done"; after it the run takes no ticks (409 `run_closed`). */
    doneAt: ts("done_at"),
    /** Set from the app's injected clock; defaultNow() is only a fallback. */
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("market_runs_plan_idx").on(t.planId), index("market_runs_user_id_idx").on(t.userId)],
);

/**
 * H-12 (M5 Step 7, Ruling 9): the player's margin notes, their own changes to a canon recipe. `sealed` is core's whole
 * `MarginNote` (`{ recipe, ops, text, at }`: the canon slug, add, swap and remove ops over ingredient names, the
 * player's own words up to NOTE_TEXT_MAX, and when it was written), sealed S-U with AAD
 * `{ table: 'margin_notes', userId, rowId }`. The recipe is sealed too (fix round 1, I1): no plain column says which
 * dish a player changed or how often; the per-recipe cap is counted over the player's opened notes. Health data (the notes can show what the player can't or won't eat): written only
 * with `health_data`, in `HEALTH_TABLES`. At most MAX_NOTES_PER_RECIPE per recipe.
 */
export const marginNotes = pgTable(
  "margin_notes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sealed: bytea("sealed").notNull(),
    /** Set from the app's injected clock; defaultNow() is only a fallback. */
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("margin_notes_user_id_idx").on(t.userId)],
);

/**
 * H-13 (M5 Step 7, Ruling 10): Cooked for Someone, the Shared Table. `sealed` is `{ recipe, frame, cookedFor }`: the
 * canon slug or Pantry Frame id cooked, and core's `CookedFor` (a fixed count and, optionally, one fixed word), sealed
 * S-U with AAD `{ table: 'shared_table', userId, rowId }`. No names and no free text can be stored: every field is an
 * enum or a slug checked against the content. `cooked_on` (a date only) stays plain. Contract basis, not health.
 * Never a requirement for trust or progress (audit M-9).
 */
export const sharedTable = pgTable(
  "shared_table",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cookedOn: date("cooked_on", { mode: "string" }).notNull(),
    sealed: bytea("sealed").notNull(),
    /** Set from the app's injected clock; defaultNow() is only a fallback. */
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("shared_table_user_id_idx").on(t.userId)],
);

/**
 * The plaintext length of every sealed `voice_settings` value, in bytes: `{ accessibility, pad }` is padded to it, so
 * the blob of `true` and of `false` have one length (B4) and the row tells nothing by its size.
 */
export const VOICE_SETTINGS_PLAIN_BYTES = 64;
/** A sealed blob's fixed overhead past its key id: the id-length byte, the 12-byte IV and the 16-byte tag (`crypto/seal.ts`). */
const SEAL_OVERHEAD_BYTES = 1 + 12 + 16;

/**
 * P-5 (M7 Step 4, README Ruling 6, C-19): the player's self-declared accessibility need for voice, which makes voice
 * unmetered (spec §16; the abuse ceiling still applies). A disability signal, so health data: `sealed` is
 * `{ accessibility: boolean }` padded to VOICE_SETTINGS_PLAIN_BYTES, sealed S-U with AAD
 * `{ table: 'voice_settings', userId, rowId: userId }` (one row per player). Written only with `health_data`. Once the
 * player touches the setting the row is kept, with a sealed `false` when off (B4), so its existence says nothing;
 * a `health_data` withdraw-with-delete and account delete (cascade) remove it. The check pins the sealed layout and
 * length: a plain value, or a blob of another length, is refused. Never read by analytics, a prompt or a log.
 */
export const voiceSettings = pgTable(
  "voice_settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    sealed: bytea("sealed").notNull(),
    /** Set by every write from the app's injected clock. */
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check(
      "voice_settings_sealed_check",
      sql`case when octet_length(${t.sealed}) = 0 then false else octet_length(${t.sealed}) = get_byte(${t.sealed}, 0) + ${sql.raw(String(SEAL_OVERHEAD_BYTES + VOICE_SETTINGS_PLAIN_BYTES))} end`,
    ),
  ],
);

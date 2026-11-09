import { sql } from 'drizzle-orm';
import {
  customType,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable('users', {
  id: id(),
  email: citext('email').notNull().unique(),
  ageConfirmedAt: ts('age_confirmed_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const loginTokens = pgTable('login_tokens', {
  id: id(),
  email: citext('email').notNull(),
  tokenHash: bytea('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: bytea('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const profiles = pgTable(
  'profiles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    marketDays: smallint('market_days').array().notNull().default(sql`'{}'`),
    mealsPerWeek: smallint('meals_per_week'),
    country: text('country'),
    region: text('region'),
    mealWindows: jsonb('meal_windows').notNull().default(sql`'[]'::jsonb`),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId] })],
);

/** `sealed` is the AES-256-GCM blob of the core Rule minus its id; the row id is the rule id. */
export const rules = pgTable('rules', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  sealed: bytea('sealed').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const canonRecipes = pgTable('canon_recipes', {
  path: text('path').primaryKey(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  country: text('country').notNull(),
  region: text('region'),
  status: text('status').notNull(),
  source: text('source').notNull(),
  contentHash: text('content_hash').notNull(),
  syncedAt: ts('synced_at').notNull().defaultNow(),
});

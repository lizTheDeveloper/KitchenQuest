import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lockLiveUser } from '../auth/live-user.js';
import { requireUser } from '../auth/session.js';
import type { Tx } from '../consent/ledger.js';
import { profiles } from '../db/schema.js';
import { knownMealWindows, MEAL_WINDOW_NAMES, type StoredMealWindow } from './store.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h)');

const MealWindow = z
  .object({
    name: z.enum(MEAL_WINDOW_NAMES),
    start: hhmm,
    end: hhmm,
  })
  .strict()
  .refine((w) => w.start < w.end, { path: ['end'], message: 'end must be after start' });

const ProfileBody = z
  .object({
    marketDays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .refine((d) => new Set(d).size === d.length, 'marketDays must be unique'),
    mealsPerWeek: z.number().int().min(0).max(42).nullable(),
    country: z.string().max(80).nullable(),
    region: z.string().max(80).nullable(),
    mealWindows: z.array(MealWindow).max(8),
  })
  .partial()
  .strict();

/** A profile patch as PUT /profile takes it (every key optional). */
export type ProfilePatch = z.infer<typeof ProfileBody>;

export interface Profile {
  marketDays: number[];
  mealsPerWeek: number | null;
  country: string | null;
  region: string | null;
  mealWindows: StoredMealWindow[];
}

const cols = {
  marketDays: profiles.marketDays,
  mealsPerWeek: profiles.mealsPerWeek,
  country: profiles.country,
  region: profiles.region,
  mealWindows: profiles.mealWindows,
};

/**
 * The user's profile, created empty (at `now`) on first read, inside the caller's transaction. Exported (C8) so the
 * week services read `marketDays` from it.
 */
export async function loadProfile(tx: Tx, userId: string, now: Date): Promise<Profile> {
  await tx.insert(profiles).values({ userId, updatedAt: now }).onConflictDoNothing({ target: profiles.userId });
  const [row] = await tx.select(cols).from(profiles).where(eq(profiles.userId, userId));
  if (!row) throw new Error('profile vanished after insert');
  return { ...(row as Profile), mealWindows: knownMealWindows(row.mealWindows) };
}

/**
 * Applies `patch` to the user's profile inside the caller's transaction, after
 * the same zod validation as PUT /profile (a ZodError is a 400): live user
 * (401) → the profile as it was (created empty on first use) → upsert of the
 * keys in `patch` only → the profile as it is now. The mentor's profile card
 * confirms and undoes through here (Step 8), PUT /profile too.
 */
export async function applyProfilePatchIn(tx: Tx, userId: string, input: ProfilePatch, at: Date): Promise<{ before: Profile; after: Profile }> {
  const patch = ProfileBody.parse(input);
  await lockLiveUser(tx, userId);
  const before = await loadProfile(tx, userId, at);
  // Upsert: omitted fields are not in `patch`, so they are left unchanged.
  await tx
    .insert(profiles)
    .values({ userId, ...patch, updatedAt: at })
    .onConflictDoUpdate({ target: profiles.userId, set: { ...patch, updatedAt: at } });
  return { before, after: await loadProfile(tx, userId, at) };
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  const { db, now } = app.deps;

  // Both write (first read creates the row), so both hold the user row first: a deleted account is a 401.
  app.get('/profile', { preHandler: requireUser }, async (req) =>
    db.transaction(async (tx) => {
      await lockLiveUser(tx, req.user.id);
      return loadProfile(tx, req.user.id, now());
    }),
  );

  app.put('/profile', { preHandler: requireUser }, async (req) => {
    const patch = ProfileBody.parse(req.body);
    const at = now();
    return db.transaction(async (tx) => (await applyProfilePatchIn(tx, req.user.id, patch, at)).after);
  });
}

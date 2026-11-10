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

interface Profile {
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

/** The user's profile, created empty (at `now`) on first read, inside the caller's transaction. */
async function loadProfile(tx: Tx, userId: string, now: Date): Promise<Profile> {
  await tx.insert(profiles).values({ userId, updatedAt: now }).onConflictDoNothing({ target: profiles.userId });
  const [row] = await tx.select(cols).from(profiles).where(eq(profiles.userId, userId));
  if (!row) throw new Error('profile vanished after insert');
  return { ...(row as Profile), mealWindows: knownMealWindows(row.mealWindows) };
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
    return db.transaction(async (tx) => {
      await lockLiveUser(tx, req.user.id);
      // Upsert: omitted fields are not in `patch`, so they are left unchanged.
      await tx
        .insert(profiles)
        .values({ userId: req.user.id, ...patch, updatedAt: at })
        .onConflictDoUpdate({ target: profiles.userId, set: { ...patch, updatedAt: at } });
      return loadProfile(tx, req.user.id, at);
    });
  });
}

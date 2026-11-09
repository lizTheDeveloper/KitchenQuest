import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { profiles } from '../db/schema.js';
import type { Db } from '../types.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h)');

/**
 * N-7: a meal window's name is one of a fixed set. Free text here could name
 * a fast or a medical routine ("Ramadan suhoor", "insulin snack"), which is
 * special-category data in a plain column.
 */
const MEAL_WINDOW_NAMES = ['breakfast', 'lunch', 'dinner', 'snack', 'other'] as const;

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

type MealWindowName = (typeof MEAL_WINDOW_NAMES)[number];
type StoredMealWindow = { name: MealWindowName; start: string; end: string };

/**
 * Stored meal windows as served: a name outside the fixed set (a row written
 * before N-7 made names an enum) reads as `other`, so free text is never
 * shown back or exported. Used by GET /profile and the account export.
 */
export function knownMealWindows(stored: unknown): StoredMealWindow[] {
  const list = Array.isArray(stored) ? (stored as { name?: unknown }[]) : [];
  return list.map((w) => ({
    ...(w as StoredMealWindow),
    name: (MEAL_WINDOW_NAMES as readonly unknown[]).includes(w.name) ? (w.name as MealWindowName) : 'other',
  }));
}

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

/** The user's profile, created empty on first read. */
async function loadProfile(db: Db, userId: string): Promise<Profile> {
  await db.insert(profiles).values({ userId }).onConflictDoNothing({ target: profiles.userId });
  const [row] = await db.select(cols).from(profiles).where(eq(profiles.userId, userId));
  if (!row) throw new Error('profile vanished after insert');
  return { ...(row as Profile), mealWindows: knownMealWindows(row.mealWindows) };
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get('/profile', { preHandler: requireUser }, async (req) => loadProfile(db, req.user.id));

  app.put('/profile', { preHandler: requireUser }, async (req) => {
    const patch = ProfileBody.parse(req.body);
    // Upsert: omitted fields are not in `patch`, so they are left unchanged.
    await db
      .insert(profiles)
      .values({ userId: req.user.id, ...patch })
      .onConflictDoUpdate({ target: profiles.userId, set: { ...patch, updatedAt: new Date() } });
    return loadProfile(db, req.user.id);
  });
}

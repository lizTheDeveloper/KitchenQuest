import { randomUUID } from 'node:crypto';
import { checkWithNotes, MAX_NOTES_PER_RECIPE, validateNote, type CheckResult, type MarginNote, type NoteOp } from '@kitchenquest/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { Catalog } from '../catalog.js';
import { lockConsentIn, type Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { openFor, sealFor } from '../crypto/userkeys.js';
import { lockUserNotes } from '../db/advisory-locks.js';
import { marginNotes } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { RecipeIndex } from '../recipes/recipe-index.js';
import { loadRules } from '../rules/store.js';
import { assertUnderWriteCap } from '../usage/write-cap.js';
import type { Db } from '../types.js';

type Reader = Pick<Db, 'select'>;

export interface NotesDeps {
  keyring: Keyring;
  catalog: Catalog;
  recipes: RecipeIndex;
}

/** The audited actions the book's daily write cap counts (the M4 cap, the same for every player and plan, abuse only). */
export const BOOK_WRITE_ACTIONS = ['notes.create', 'shared_table.create'] as const;

/** What `margin_notes.sealed` holds: core's `MarginNote` without `recipe` (that is the plain `recipe` column). */
type SealedNote = Omit<MarginNote, 'recipe'>;

/** The seal context of a margin-note row (C-3): bound to the table, owner and row. */
const noteSealContext = (userId: string, rowId: string) => ({ table: 'margin_notes', userId, rowId });

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const utcToday = (at: Date): string => at.toISOString().slice(0, 10);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A note exactly as stored and returned: core's fields only, names and text trimmed, empty text as null. */
function canonical(n: MarginNote): MarginNote {
  const ops = n.ops.map((op): NoteOp => (op.op === 'swap' ? { op: 'swap', from: op.from.trim(), to: op.to.trim() } : { op: op.op, name: op.name.trim() }));
  const text = n.text === null || n.text.trim() === '' ? null : n.text.trim();
  return { recipe: n.recipe, ops, text, at: n.at };
}

/**
 * The player's margin notes, decrypted, oldest first, with their row ids; only those on `recipe` when it is given.
 * `recipe` is for the service's own use (the per-recipe cap, `createNoteIn`'s check): `GET /notes` never passes one,
 * so no slug is ever in a notes URL (C32, Ruling 26).
 */
export async function loadNotes(db: Reader, keyring: Keyring, userId: string, recipe?: string): Promise<(MarginNote & { id: string })[]> {
  const rows = await db
    .select({ id: marginNotes.id, recipe: marginNotes.recipe, sealed: marginNotes.sealed })
    .from(marginNotes)
    .where(recipe === undefined ? eq(marginNotes.userId, userId) : and(eq(marginNotes.userId, userId), eq(marginNotes.recipe, recipe)))
    .orderBy(asc(marginNotes.createdAt), asc(marginNotes.id));
  const out: (MarginNote & { id: string })[] = [];
  for (const r of rows) {
    const s = await openFor<SealedNote>(db, keyring, noteSealContext(userId, r.id), r.sealed);
    out.push({ recipe: r.recipe, ops: s.ops, text: s.text, at: s.at, id: r.id });
  }
  return out;
}

/** The export's margin notes (C-7, H-12): every note, decrypted, with its row id and time. */
export async function loadNotesForExport(db: Reader, keyring: Keyring, userId: string) {
  const times = new Map(
    (await db.select({ id: marginNotes.id, createdAt: marginNotes.createdAt }).from(marginNotes).where(eq(marginNotes.userId, userId))).map((r) => [r.id, r.createdAt]),
  );
  return (await loadNotes(db, keyring, userId)).map((n) => ({ ...n, createdAt: times.get(n.id)?.toISOString() ?? null }));
}

/**
 * Writes a margin note for the player, inside the caller's transaction (M5 Step 7, Ruling 9). Order: live user (401) →
 * advisory `notes:` → the daily write cap (429) → `health_data` (403 `consent_required`: notes are health data) →
 * `validateNote` against the canon (400 `bad_request` with its problems: shape, an unknown recipe, a sacred recipe,
 * text over NOTE_TEXT_MAX) → `at` within a day of `today`, the player's local date (the UTC date of `at` when absent)
 * → MAX_NOTES_PER_RECIPE per recipe (400 `too_many_notes`) → seal (`{ ops, text, at }`) → insert → audit
 * 'notes.create' (the row id only, C-5).
 *
 * Returns the note as stored, with its row id and `check`: core `checkWithNotes` over ALL the player's notes on that
 * recipe (this one included), on `today`, with their rules now. That is what "cook with my notes" will show: the worst
 * of the recipe with every change applied and every ingredient the notes name anywhere (`noteMentions`). Notes never
 * feed a reward (nothing here reaches progress).
 */
export async function createNoteIn(
  tx: Tx,
  deps: NotesDeps,
  userId: string,
  note: MarginNote,
  at: Date,
  requestId?: string,
  today: string = utcToday(at),
): Promise<MarginNote & { id: string; check: CheckResult }> {
  await lockLiveUser(tx, userId);
  await lockUserNotes(tx, userId);
  await assertUnderWriteCap(tx, userId, BOOK_WRITE_ACTIONS, at);
  await lockConsentIn(tx, userId, 'health_data', at);
  const problems = validateNote(note, deps.recipes);
  if (problems.length > 0) throw new ApiError(400, 'bad_request', 'The note is not valid', { problems });
  const day = note.at.slice(0, 10);
  if (day < addDays(today, -1) || day > addDays(today, 1)) {
    throw new ApiError(400, 'bad_request', 'The note is not valid', { problems: ['note: at is not today'] });
  }
  const value = canonical(note);
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(marginNotes)
    .where(and(eq(marginNotes.userId, userId), eq(marginNotes.recipe, value.recipe)));
  if (n >= MAX_NOTES_PER_RECIPE) {
    throw new ApiError(400, 'too_many_notes', `A recipe holds at most ${MAX_NOTES_PER_RECIPE} notes`, { max: MAX_NOTES_PER_RECIPE });
  }
  // Generated before insert: the seal is bound to it (C-3).
  const id = randomUUID();
  const sealed: SealedNote = { ops: value.ops, text: value.text, at: value.at };
  await tx.insert(marginNotes).values({ id, userId, recipe: value.recipe, sealed: await sealFor(tx, deps.keyring, noteSealContext(userId, id), sealed, at), createdAt: at });
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'notes.create', target: id, requestId }, at);
  const all = await loadNotes(tx, deps.keyring, userId, value.recipe);
  const rules = await loadRules(tx, deps.keyring, userId);
  const check = checkWithNotes(deps.recipes.get(value.recipe)!, all, rules, deps.catalog.graph, [...deps.catalog.substitutions], today);
  return { ...value, id, check };
}

/**
 * Deletes one of the player's margin notes, inside the caller's transaction: live user (401), then 404 when `id` is
 * not theirs (a malformed id looks the same and never reaches the database). No consent needed: kept data must stay
 * deletable after a "keep" withdrawal. Nothing earned is touched (notes never fed a reward). Audits 'notes.delete'.
 */
export async function deleteNoteIn(tx: Tx, userId: string, id: string, at: Date, requestId?: string): Promise<void> {
  await lockLiveUser(tx, userId);
  const notFound = () => new ApiError(404, 'not_found', 'Note not found');
  if (!UUID.test(id)) throw notFound();
  const rowId = id.toLowerCase();
  const gone = await tx
    .delete(marginNotes)
    .where(and(eq(marginNotes.id, rowId), eq(marginNotes.userId, userId)))
    .returning({ id: marginNotes.id });
  if (gone.length === 0) throw notFound();
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'notes.delete', target: rowId, requestId }, at);
}

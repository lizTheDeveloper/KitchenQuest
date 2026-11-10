import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { countSelfRead } from '../audit/self-reads.js';
import { requireUser } from '../auth/session.js';
import type { Catalog } from '../catalog.js';
import type { Tx } from '../consent/ledger.js';
import { ApiError } from '../errors.js';
import { changePantryIn, PantryChangeBody } from './service.js';
import { loadPantry } from './store.js';

/** The body of POST /pantry/changes: the change and the player's yes. */
const ChangeWrite = PantryChangeBody.extend({ confirmed: z.unknown() }).strict();

/**
 * The player's pantry (H-11). Sealed per user and row (C-3/C-4) although its
 * basis is contract, so no consent is asked; a change still needs an explicit
 * `confirmed: true` (light confirmation, spec §7.0). The client's undo sends
 * `{ add: removed, removeNames: [], removeIds: addedIds }`. Item names are
 * never in a URL or a log (C-9).
 */
export async function pantryRoutes(app: FastifyInstance, catalog: Catalog): Promise<void> {
  const { db, config, now } = app.deps;
  const deps = { keyring: config.keyring, catalog };

  app.get('/pantry', { preHandler: requireUser }, async (req) => {
    const items = await loadPantry(db, config.keyring, req.user.id);
    await countSelfRead(db, req.user.id, 'pantry', now());
    return { items };
  });

  app.post('/pantry/changes', { preHandler: requireUser }, async (req) => {
    const at = now();
    const body = req.body;
    if (typeof body !== 'object' || body === null || (body as { confirmed?: unknown }).confirmed !== true) {
      throw new ApiError(400, 'confirmation_required', 'Changing your pantry needs your confirmation (confirmed: true)');
    }
    const { confirmed: _confirmed, ...change } = ChangeWrite.parse(body);
    const { items, removed } = await db.transaction((tx: Tx) => changePantryIn(tx, deps, req.user.id, change, at, req.id));
    return { items, removed };
  });
}

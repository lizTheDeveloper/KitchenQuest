import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import type { Db } from '../types.js';
import * as schema from './schema.js';

export type { Sql };


const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

export function createDb(url: string, opts: { max?: number } = {}): { db: Db; sql: Sql } {
  const sql = postgres(url, { onnotice: () => {}, ...(opts.max ? { max: opts.max } : {}) });
  return { db: drizzle(sql, { schema }), sql };
}

/**
 * Applies the generated migrations, unmodified, into the connection's default
 * schema (`public`); drizzle keeps its bookkeeping in the `drizzle` schema. Run it from one process at a
 * time: there is no cross-process lock, so two instances booting together can
 * race on `CREATE EXTENSION`. Needs one pooled connection (runs in a transaction).
 */
export async function migrate(db: Db): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

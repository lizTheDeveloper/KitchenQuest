import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import type { Db } from '../types.js';
import * as schema from './schema.js';

export type { Sql };

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * `opts.schema` puts every table in that Postgres schema (search_path is the
 * schema, then `public` so database-wide extensions such as citext resolve).
 */
export function createDb(url: string, opts: { schema?: string } = {}): { db: Db; sql: Sql } {
  const sql = postgres(url, {
    onnotice: () => {},
    ...(opts.schema ? { connection: { search_path: `"${opts.schema}",public` } } : {}),
  });
  return { db: drizzle(sql, { schema }), sql };
}

/**
 * Applies the generated migrations. The bookkeeping table lives in `schemaName`
 * (default `public`) beside the tables, so per-test schemas stay isolated.
 * Serialised with an advisory lock: concurrent runs (parallel test files, two
 * API instances booting) race on CREATE EXTENSION otherwise.
 */
export async function migrate(db: Db, sql: Sql, schemaName = 'public'): Promise<void> {
  const lock = await sql.reserve();
  try {
    await lock`select pg_advisory_lock(727001)`;
    try {
      await drizzleMigrate(db, {
        migrationsFolder: MIGRATIONS_FOLDER,
        migrationsSchema: schemaName,
        migrationsTable: '__drizzle_migrations',
      });
    } finally {
      await lock`select pg_advisory_unlock(727001)`;
    }
  } finally {
    lock.release();
  }
}

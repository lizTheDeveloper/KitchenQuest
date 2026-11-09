import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Db } from '../../src/types.js';

export type Sql = postgres.Sql;

/**
 * Migration hook. Stays a no-op until Task 2 wires real migrations into the
 * per-file schema (the connection's search_path already points at it).
 */
async function migrate(_sql: Sql, _schema: string): Promise<void> {}

/** Fresh, uniquely named schema in the test database; dropped by close(). */
export async function testDb(): Promise<{ db: Db; sql: Sql; close(): Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start the local test database with ' +
        '`scripts/dev-db.sh start` and export the TEST_DATABASE_URL it prints ' +
        '(or run `eval "$(scripts/dev-db.sh url)"`).',
    );
  }
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create schema "${schema}"`);
  const sql = postgres(url, {
    max: 5,
    onnotice: () => {},
    connection: { search_path: schema },
  });
  await migrate(sql, schema);
  return {
    db: drizzle(sql),
    sql,
    async close() {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`drop schema "${schema}" cascade`);
      await admin.end({ timeout: 5 });
    },
  };
}

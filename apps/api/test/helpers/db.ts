import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createDb, migrate, type Sql } from '../../src/db/client.js';
import type { Db } from '../../src/types.js';

export type { Sql };

/**
 * Fresh, uniquely named database (migrated, `public` schema) per test file,
 * created from the server behind TEST_DATABASE_URL and dropped by close().
 */
export async function testDb(): Promise<{ db: Db; sql: Sql; url: string; close(): Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start the local test database with ' +
        '`scripts/dev-db.sh start` and export the TEST_DATABASE_URL it prints ' +
        '(or run `eval "$(scripts/dev-db.sh url)"`).',
    );
  }
  const name = `t_${randomBytes(6).toString('hex')}`;
  const testUrl = new URL(url);
  testUrl.pathname = `/${name}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const dropDb = () => admin.unsafe(`drop database if exists "${name}" with (force)`);
  let conn: ReturnType<typeof createDb> | undefined;
  try {
    await admin.unsafe(`create database "${name}"`);
    conn = createDb(testUrl.toString(), { max: 5 });
    await migrate(conn.db);
  } catch (err) {
    await conn?.sql.end({ timeout: 5 }).catch(() => {});
    await dropDb().catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
    throw err;
  }
  const { db, sql } = conn;
  return {
    db,
    sql,
    url: testUrl.toString(),
    async close() {
      await sql.end({ timeout: 5 });
      await dropDb();
      await admin.end({ timeout: 5 });
    },
  };
}

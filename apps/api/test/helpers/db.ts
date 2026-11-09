import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schemaModule from '../../src/db/schema.js';
import { migrate } from '../../src/db/client.js';
import type { Db } from '../../src/types.js';

export type Sql = postgres.Sql;

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
  let sql: Sql | undefined;
  try {
    await admin.unsafe(`create schema "${schema}"`);
    sql = postgres(url, {
      max: 5,
      onnotice: () => {},
      connection: { search_path: `"${schema}",public` },
    });
    await migrate(drizzle(sql, { schema: schemaModule }), sql, schema);
  } catch (err) {
    await sql?.end({ timeout: 5 }).catch(() => {});
    await admin.unsafe(`drop schema if exists "${schema}" cascade`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
    throw err;
  }
  const conn = sql;
  return {
    db: drizzle(conn, { schema: schemaModule }),
    sql: conn,
    async close() {
      await conn.end({ timeout: 5 });
      await admin.unsafe(`drop schema "${schema}" cascade`);
      await admin.end({ timeout: 5 });
    },
  };
}

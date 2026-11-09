import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from './db/schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

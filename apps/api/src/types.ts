import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/** Placeholder alias; Task 2 narrows this with the schema generic. */
export type Db = PostgresJsDatabase;

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import type { Mailer } from './types.js';

const config = loadConfig(process.env);

if (config.mailer === 'smtp') {
  // Task 3 adds a real SMTP mailer; fail loudly rather than silently logging.
  throw new Error('MAILER=smtp is not implemented yet');
}
const mailer: Mailer = {
  async send(msg) {
    console.log(`[mail] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
  },
};

const sql = postgres(config.databaseUrl);
const app = await buildApp({
  config,
  db: drizzle(sql),
  mailer,
  now: () => new Date(),
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

const stop = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await app.listen({ port: config.port, host: '0.0.0.0' });

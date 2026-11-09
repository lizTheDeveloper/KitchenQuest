import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import * as schema from './db/schema.js';
import { scheduleRetention } from './jobs/retention.js';
import { loggerOptions } from './logging/redact.js';
import { LogMailer, SmtpMailer } from './mail/mailer.js';
import type { Mailer } from './types.js';

const config = loadConfig(process.env);

// loadConfig guarantees smtpUrl and mailFrom when MAILER=smtp.
const mailer: Mailer = config.mailer === 'smtp' ? new SmtpMailer(config.smtpUrl!, config.mailFrom!) : new LogMailer();

const sql = postgres(config.databaseUrl);
const db = drizzle(sql, { schema });
const app = await buildApp({
  config,
  db,
  mailer,
  now: () => new Date(),
  logger: loggerOptions(process.env.LOG_LEVEL ?? 'info'),
});

// C-6: retention runs at boot and hourly; it logs counts only.
const stopRetention = scheduleRetention(db, () => new Date(), app.log);

const stop = async () => {
  stopRetention();
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await app.listen({ port: config.port, host: '0.0.0.0' });

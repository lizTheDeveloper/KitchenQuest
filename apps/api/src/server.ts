import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { LogMailer, SmtpMailer } from './mail/mailer.js';
import type { Mailer } from './types.js';

const config = loadConfig(process.env);

// loadConfig guarantees smtpUrl when MAILER=smtp.
const mailer: Mailer =
  config.mailer === 'smtp'
    ? new SmtpMailer(config.smtpUrl!, `Kitchen Quest <no-reply@${new URL(config.appOrigin).hostname}>`)
    : new LogMailer();

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

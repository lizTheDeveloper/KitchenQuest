// Admin script: npm run grant -w @kitchenquest/api -- <email> <kind> [days]
import { eq } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { ENTITLEMENT_KINDS, grant, type EntitlementKind } from '../src/entitlements/entitlements.js';

const [email, kind, days] = process.argv.slice(2);
const usage = `usage: npm run grant -w @kitchenquest/api -- <email> <${ENTITLEMENT_KINDS.join('|')}> [days]`;
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
if (!email || !kind || !ENTITLEMENT_KINDS.includes(kind as EntitlementKind)) throw new Error(usage);
const n = days === undefined ? undefined : Number(days);
if (n !== undefined && (!Number.isInteger(n) || n <= 0)) throw new Error(`days must be a positive integer\n${usage}`);

const { db, sql } = createDb(url, { max: 1 });
try {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!u) throw new Error(`no user with email ${email}`);
  const now = new Date();
  await grant(db, u.id, kind as EntitlementKind, 'manual', now, n === undefined ? undefined : new Date(now.getTime() + n * 86_400_000));
  console.log(`granted ${kind} to ${email}${n === undefined ? '' : ` for ${n} days`}`);
} finally {
  await sql.end({ timeout: 5 });
}

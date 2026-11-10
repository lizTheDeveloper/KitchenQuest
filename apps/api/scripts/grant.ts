// Admin script: npm run grant -w @kitchenquest/api -- <email> <kind> [days]
import { userInfo } from 'node:os';
import { eq } from 'drizzle-orm';
import { audit } from '../src/audit/audit.js';
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
  const endsAt = n === undefined ? undefined : new Date(now.getTime() + n * 86_400_000);
  // C-5: an admin script that changes a user's data writes an audit event, in the same transaction.
  await db.transaction(async (tx) => {
    await grant(tx, u.id, kind as EntitlementKind, 'manual', now, endsAt, now);
    await audit(
      tx,
      { actorKind: 'script', actorId: `grant:${userInfo().username}`, subjectUserId: u.id, action: 'entitlement.grant', target: kind },
      now,
    );
  });
  console.log(`granted ${kind} to ${email}${n === undefined ? '' : ` for ${n} days`}`);
} finally {
  await sql.end({ timeout: 5 });
}

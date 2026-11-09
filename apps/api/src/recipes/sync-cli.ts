// Admin script: npm run sync:recipes -w @kitchenquest/api
import { loadCatalog } from '../catalog.js';
import { createDb } from '../db/client.js';
import { RECIPES_DIR, syncCanon } from './sync.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const { graph } = loadCatalog();
const { db, sql } = createDb(url, { max: 1 });
try {
  const r = await syncCanon(db, RECIPES_DIR, graph);
  console.log(`recipes synced: ${r.added} added, ${r.updated} updated, ${r.removed} removed, ${r.unchanged} unchanged`);
} finally {
  await sql.end({ timeout: 5 });
}

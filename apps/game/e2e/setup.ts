import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext { baseUrl: string; fixtureUrl: string; handsFreeUrl: string }
}

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4173;
const FIXTURE_PORT = 4174;
const HANDS_FREE_PORT = 4175;

export default async function setup({ provide }: TestProject) {
  // Vitest sets NODE_ENV=test, which would make this a non-production build (import.meta.env.PROD false, so no
  // service worker). Build exactly what `npm run build` ships.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  // M7 B8: a build names the game's origin for its CSP's connect-src (the voice socket). The preview's own, here.
  process.env.KQ_APP_ORIGIN ??= `http://localhost:${PORT}`;
  try {
    await build({ root, logLevel: 'warn', configLoader: 'runner' });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  }
  // M7 Step 11: a second build with the hands-free UI (VITE_HANDS_FREE=on), for the hands-free voice e2e only. Its gate
  // reads the test fixture e2e/fixtures/voice/latest.json (vite.config.ts: only under Vitest), never the operator's
  // record; the first build above stays exactly what ships, and the budget and bundle checks read that one.
  const saved = { NODE_ENV: process.env.NODE_ENV, KQ_APP_ORIGIN: process.env.KQ_APP_ORIGIN };
  process.env.NODE_ENV = 'production';
  process.env.KQ_APP_ORIGIN = `http://localhost:${HANDS_FREE_PORT}`;
  process.env.VITE_HANDS_FREE = 'on';
  process.env.KQ_TEST_HANDS_FREE_RECORD = fileURLToPath(new URL('./fixtures/voice/latest.json', import.meta.url));
  try {
    await build({ root, logLevel: 'warn', configLoader: 'runner', build: { outDir: 'dist-hands-free' } });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.VITE_HANDS_FREE;
    delete process.env.KQ_TEST_HANDS_FREE_RECORD;
  }
  const server = await preview({ root, logLevel: 'warn', configLoader: 'runner', preview: { port: PORT, strictPort: true } });
  const handsFree = await preview({ root, logLevel: 'warn', configLoader: 'runner', build: { outDir: 'dist-hands-free' }, preview: { port: HANDS_FREE_PORT, strictPort: true } });
  // Component fixtures (chips, Bureau form) run from source on a dev server, so they never ship in the build.
  const fixtures = await createServer({ root, logLevel: 'warn', configLoader: 'runner', server: { port: FIXTURE_PORT, strictPort: true }, optimizeDeps: { noDiscovery: true } });
  await fixtures.listen();
  provide('baseUrl', `http://localhost:${PORT}`);
  provide('fixtureUrl', `http://localhost:${FIXTURE_PORT}`);
  provide('handsFreeUrl', `http://localhost:${HANDS_FREE_PORT}`);
  return async () => { await server.close(); await handsFree.close(); await fixtures.close(); };
}

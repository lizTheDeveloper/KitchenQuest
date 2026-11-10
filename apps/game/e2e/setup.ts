import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext { baseUrl: string; fixtureUrl: string }
}

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4173;
const FIXTURE_PORT = 4174;

export default async function setup({ provide }: TestProject) {
  // Vitest sets NODE_ENV=test, which would make this a non-production build (import.meta.env.PROD false, so no
  // service worker). Build exactly what `npm run build` ships.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await build({ root, logLevel: 'warn', configLoader: 'runner' });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  }
  const server = await preview({ root, logLevel: 'warn', configLoader: 'runner', preview: { port: PORT, strictPort: true } });
  // Component fixtures (chips, Bureau form) run from source on a dev server, so they never ship in the build.
  const fixtures = await createServer({ root, logLevel: 'warn', configLoader: 'runner', server: { port: FIXTURE_PORT, strictPort: true }, optimizeDeps: { noDiscovery: true } });
  await fixtures.listen();
  provide('baseUrl', `http://localhost:${PORT}`);
  provide('fixtureUrl', `http://localhost:${FIXTURE_PORT}`);
  return async () => { await server.close(); await fixtures.close(); };
}

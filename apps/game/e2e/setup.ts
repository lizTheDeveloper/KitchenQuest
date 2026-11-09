import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext { baseUrl: string }
}

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4173;

export default async function setup({ provide }: TestProject) {
  await build({ root, logLevel: 'warn' });
  const server = await preview({ root, logLevel: 'warn', preview: { port: PORT, strictPort: true } });
  provide('baseUrl', `http://localhost:${PORT}`);
  return async () => { await server.close(); };
}

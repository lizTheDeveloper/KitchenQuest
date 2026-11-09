import { Writable } from 'node:stream';
import type { FastifyServerOptions } from 'fastify';
import { loggerOptions } from '../../src/logging/redact.js';

/**
 * The production logger configuration (C-9), at `trace` so every line is
 * written, into memory. Pass `logger` to buildApp, make requests, then assert
 * on `text()`, e.g. `expect(logs.text()).not.toMatch(/peanut/i)`.
 * Step 5 reuses this for its search and rule routes.
 */
export function captureLogs(): { logger: FastifyServerOptions['logger']; lines(): string[]; text(): string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const text = () => chunks.join('');
  return {
    logger: { ...loggerOptions('trace'), stream },
    lines: () => text().split('\n').filter(Boolean),
    text,
  };
}

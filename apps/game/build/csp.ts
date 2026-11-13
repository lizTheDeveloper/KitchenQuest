import type { Plugin } from 'vite';

/** The placeholder in index.html's CSP `connect-src`, filled at build (and dev) time. */
export const KQ_WS_TOKEN = '%KQ_WS_ORIGIN%';
/** The dev server's own origin (vite.config.ts `server.port`). */
const DEV_WS = 'ws://localhost:5173';

/**
 * M7 B8: the voice socket's origin for the CSP, from the game's public origin: `https://host` → `wss://host`
 * (`http://` → `ws://`, for a local preview). Only the origin is kept (no path).
 */
export function wsOriginFor(appOrigin: string): string {
  let u: URL;
  try {
    u = new URL(appOrigin);
  } catch {
    throw new Error(`KQ_APP_ORIGIN must be the game's origin (https://host), not "${appOrigin}"`);
  }
  // Fix round 1 (M6): plaintext (ws://) only for a local preview, never for a public host.
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error(`KQ_APP_ORIGIN must be an https:// origin (http:// only for localhost), not "${appOrigin}"`);
  return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`;
}

/** `html` with the token replaced by `wsOrigin` (a page without it is returned as it is). */
export function fillCsp(html: string, wsOrigin: string): string {
  return html.replaceAll(KQ_WS_TOKEN, wsOrigin);
}

/** A build must say where the game is served from (its socket's origin goes in the CSP); the dev server need not. */
export function cspProblem(command: 'build' | 'serve', env: Readonly<Record<string, string | undefined>>): string | null {
  const origin = env.KQ_APP_ORIGIN;
  if (command === 'build' && (origin === undefined || origin === '')) {
    return "KQ_APP_ORIGIN is not set: a build must name the game's origin (https://host) so the CSP's connect-src allows its voice socket (B8)";
  }
  return null;
}

/** Fills `%KQ_WS_ORIGIN%` in each page's CSP; fails a build without `KQ_APP_ORIGIN`. `env` is process.env by default. */
export function kqCsp(env: Readonly<Record<string, string | undefined>> = process.env): Plugin {
  let ws = DEV_WS;
  return {
    name: 'kq-csp',
    configResolved(config) {
      const problem = cspProblem(config.command, env);
      if (problem !== null) throw new Error(problem);
      const origin = env.KQ_APP_ORIGIN;
      ws = origin === undefined || origin === '' ? DEV_WS : wsOriginFor(origin);
    },
    transformIndexHtml: { order: 'pre', handler: (html) => fillCsp(html, ws) },
  };
}

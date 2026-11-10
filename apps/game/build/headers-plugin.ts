import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/**
 * The sign-in page carries its token in the URL, so it must never leak it in a Referer header or be stored by
 * a cache. Production sets these in nginx (deploy/security-headers.conf); this plugin does the same for the
 * Vite dev and preview servers. The page also sets `<meta name="referrer" content="no-referrer">` itself.
 */
const VERIFY_HEADERS: Readonly<Record<string, string>> = { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

export function isVerifyPath(pathname: string): boolean {
  return pathname === '/auth/verify' || pathname === '/auth/verify/' || pathname === '/auth/verify/index.html';
}

type Res = Pick<ServerResponse, 'setHeader'> & { writeHead?: ServerResponse['writeHead'] };

/**
 * Connect middleware (dev and preview). Vite's static server passes its own `Cache-Control` to `writeHead`, which would win
 * over `setHeader`, so on a verify path `writeHead` is wrapped to drop those and set ours.
 */
export function verifyHeaders(req: Pick<IncomingMessage, 'url'>, res: Res, next: () => void): void {
  const url = req.url ?? '';
  const pathname = url.split(/[?#]/)[0];
  if (isVerifyPath(pathname)) {
    // The emailed link is `/auth/verify?token=…` (no slash), which Vite's servers would answer with the app's
    // index.html. Serve the page's own file, like nginx's try_files does.
    if (pathname === '/auth/verify') req.url = `/auth/verify/index.html${url.slice(pathname.length)}`;
    const ours = new Set(Object.keys(VERIFY_HEADERS).map((k) => k.toLowerCase()));
    const apply = () => { for (const [k, v] of Object.entries(VERIFY_HEADERS)) res.setHeader(k, v); };
    apply();
    const original = res.writeHead?.bind(res);
    if (original) {
      res.writeHead = ((status: number, ...rest: unknown[]) => {
        for (const arg of rest) {
          if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
            for (const k of Object.keys(arg)) if (ours.has(k.toLowerCase())) delete (arg as OutgoingHttpHeaders)[k];
          }
        }
        apply();
        return (original as (...a: unknown[]) => ServerResponse)(status, ...rest);
      });
    }
  }
  next();
}

/** Dev and preview middleware: on verify paths, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. */
export function kqSecurityHeaders(): Plugin {
  return {
    name: 'kq-security-headers',
    configureServer(server) { server.middlewares.use(verifyHeaders); },
    configurePreviewServer(server) { server.middlewares.use(verifyHeaders); },
  };
}

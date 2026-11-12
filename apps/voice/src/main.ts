// The voice service's entry point: `npm run dev -w @kitchenquest/voice`. Everything else is in boot.ts (P11).
//
// Fix round 1 (I1): an error that escapes every handler (an engine throwing outside any promise, an unhandled
// rejection) would make Node print its message and stack, which may hold a transcript or audio, to stderr, and so to
// the journal on disk. Instead the process logs one content-free line and exits; the error is never read.
import { boot } from './boot.js';
import { createLogger } from './log.js';

const log = createLogger();
const fatal = () => {
  log('fatal');
  process.exit(1);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

let service: Awaited<ReturnType<typeof boot>>;
try {
  service = await boot(process.env);
} catch (e) {
  // Before boot there is no session, no audio and no transcript: a refusal names only config (variables, model ids).
  process.stderr.write(`voice: ${e instanceof Error ? e.message : 'boot failed'}\n`);
  process.exit(1);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.close().then(() => process.exit(0));
  });
}

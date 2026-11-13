// The voice service's entry point: `npm run dev -w @kitchenquest/voice`. Everything else is in boot.ts (P11).
//
// C-18: nothing Node itself prints may carry content.
// - Fix round 1 (I1): an error that escapes every handler (an engine throwing outside any promise, an unhandled
//   rejection) would make Node print its message and stack to stderr, and so to the journal on disk. Instead the
//   process logs one content-free line and exits; the error is never read.
// - Fix round 2 (N2): Node's warning printer prints a warning's message and detail. It is removed here, and every
//   warning is logged by name only: this handler, not any flag, is what keeps stderr content-free. boot.ts is imported
//   dynamically, after the handlers, so a warning raised while it loads is caught too.
// - Step 3 (correcting fix round 3): on Node 22, `--disable-warning=ExperimentalWarning` (in deploy/kq-voice.service)
//   has no effect on this process. The flag only filters Node's default printer, which is removed here, so core's
//   WebAssembly ExperimentalWarning is still logged as {"kind":"warning","experimental":true}, like any other warning
//   (main-process.test.ts). The unit keeps the flag for any printer Node might restore; it is not what protects stderr.
//   `--no-warnings` is never used.
import { createLogger, warningFields, writeBootRefusal } from './log.js';

const log = createLogger();
const fatal = () => {
  log('fatal');
  process.exit(1);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
process.removeAllListeners('warning');
process.on('warning', (w) => log('warning', warningFields(w)));

let service: { close(): Promise<void> };
try {
  const { boot } = await import('./boot.js');
  service = await boot(process.env);
} catch (e) {
  writeBootRefusal(e);
  process.exit(1);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.close().then(() => process.exit(0));
  });
}

// The voice service's entry point: `npm run dev -w @kitchenquest/voice`. Everything else is in boot.ts (P11).
import { boot } from './boot.js';

const service = await boot(process.env);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void service.close().then(() => process.exit(0));
  });
}

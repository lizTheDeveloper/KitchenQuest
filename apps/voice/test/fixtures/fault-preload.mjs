// Test only (main-process.test.ts): loaded with `node --import`, after tsx, so the real src/main.ts runs with
// fault-engines.ts in place of src/engines/fake.ts. Nothing in src knows about it.
import { register } from 'node:module';

register(new URL('./fault-hooks.mjs', import.meta.url));

// `npm run content:pin -w @kitchenquest/game [-- --repin <question-id> ...]` (M6 Step 5, Ruling 2): adds every new
// stall question id to build/content/market-pins.json with a hash of its option texts in order. Existing pins are
// never changed, except a question named with --repin (a deliberate text fix, committed with the content change so
// the pin diff is reviewed). The build only checks the pins; it never writes them.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { parse } from 'yaml';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const { module: market } = await runnerImport(fileURLToPath(new URL('../build/content/market.ts', import.meta.url)));
const pinsFile = `${repoRoot}/${market.PINS_PATH}`;

const args = process.argv.slice(2);
const repin = new Set();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repin' && args[i + 1]) repin.add(args[++i]);
  else { console.error(`content:pin: unknown argument ${args[i]}`); process.exit(2); }
}

let pins = {};
try { pins = JSON.parse(readFileSync(pinsFile, 'utf8')); } catch { /* first run: no pins yet */ }
const stalls = ['wen', 'bram', 'okafor-sato', 'spice'].map((id) => parse(readFileSync(`${repoRoot}/content/market/${id}.yaml`, 'utf8')));
const out = market.updatedPins(stalls, pins, repin);
for (const id of repin) if (!out.repinned.includes(id)) console.error(`content:pin: --repin ${id}: no such question, or its options are unchanged`);
writeFileSync(pinsFile, `${JSON.stringify(out.pins, null, 2)}\n`);
console.log(`content:pin: ${out.added.length} added, ${out.repinned.length} re-pinned, ${Object.keys(out.pins).length} pinned in all.`);
if (out.changed.length > 0) {
  console.error(`content:pin: these questions' options changed since they shipped; give each a new id, or re-pin a deliberate text fix with --repin <id>:\n  ${out.changed.join('\n  ')}`);
  process.exit(1);
}

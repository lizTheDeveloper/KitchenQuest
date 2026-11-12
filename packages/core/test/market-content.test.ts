// Fix round 1, C1: regressions on the shipped stall content. Every shipped question is over 500 characters once its
// texts are joined, so a scan that stops at 500 misses the explanation. Uses the market fixture graph (it has
// chicken and beef; Step 4 adds the real nodes).
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { questionStatus, stallBank } from '../src/market/bank';
import { ctx, NO_PORK } from '../src/market/fixtures';
import type { StallFile } from '../src/market/types';

const bram = parse(readFileSync(new URL('../../../content/market/bram.yaml', import.meta.url), 'utf8')) as StallFile;

test('bram-thaw under "no pork": its explanation names meat (❓ under a partial rule), so it is never shown', () => {
  const thaw = bram.questions.find((q) => q.id === 'bram-thaw')!;
  expect(thaw.explain).toMatch(/^Thaw meat/);
  expect([thaw.prompt, ...thaw.options.flatMap((o) => [o.text, o.reaction])].join(' | ').length).toBeGreaterThan(500);
  expect(questionStatus(thaw, ctx([]))).toBe('ok');
  expect(questionStatus(thaw, ctx([NO_PORK]))).toBe('unverified');
  expect(stallBank({ ...bram, questions: [thaw] }, ctx([NO_PORK])).questions).toEqual([]);
});

import { expect, test } from 'vitest';

// Every source file under src/scenes/, as text.
const sources = import.meta.glob<string>(['./**/*.ts', '!./**/*.test.ts'], { query: '?raw', import: 'default', eager: true });

test('the canvas never draws text: no scene adds or makes text or bitmapText', () => {
  const files = Object.keys(sources);
  expect(files).toContain('./KitchenScene.ts');
  const offenders = files.filter((f) => /\.(add|make)\.(text|bitmapText)\(/.test(sources[f]!));
  expect(offenders).toEqual([]);
});

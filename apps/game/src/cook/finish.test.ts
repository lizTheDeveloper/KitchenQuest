import { describe, expect, test } from 'vitest';
import { recordTechnique, EMPTY_TOOLKIT } from '@kitchenquest/core/engine';
import { content } from '../content';
import { cookedEvents } from './finish';

const slug = 'india/kerala/parippu';
const parippu = content.recipes[slug]!;

describe('cookedEvents', () => {
  test('cookedEvents for parippu', () => {
    expect(cookedEvents(slug, parippu, '2026-11-09').map((e) => e.technique)).toEqual(['legumes', 'heat-control', 'tempering']);
  });
  test('each is a cooked event for this recipe and day', () => {
    for (const e of cookedEvents(slug, parippu, '2026-11-09')) expect(e).toEqual({ kind: 'cooked', technique: e.technique, at: '2026-11-09', recipe: slug });
  });
  test('folding them marks every technique tried', () => {
    const t = cookedEvents(slug, parippu, '2026-11-09').reduce(recordTechnique, EMPTY_TOOLKIT);
    expect(t.techniques.tempering!.tier).toBe('tried');
  });
});

import { describe, expect, test } from 'vitest';
import { cookWithNotes, takeNotes } from './with-notes';

const SLUG = 'india/kerala/parippu';
const note = { recipe: SLUG, ops: [{ op: 'add' as const, name: 'lime' }], text: null, at: '2026-11-10' };

describe('the "cook with my notes" hand-off (M5 Step 11, fix M2)', () => {
  test('taken once, for that dish and that account only', () => {
    cookWithNotes(SLUG, [note], 'a@example.test');
    expect(takeNotes(SLUG, 'a@example.test')).toEqual([note]);
    expect(takeNotes(SLUG, 'a@example.test')).toBeNull();
  });
  test('another account never gets it (and it is gone after the look)', () => {
    cookWithNotes(SLUG, [note], 'a@example.test');
    expect(takeNotes(SLUG, 'b@example.test')).toBeNull();
    expect(takeNotes(SLUG, 'a@example.test')).toBeNull();
  });
  test('signed out never gets an account\'s notes; another dish never gets them', () => {
    cookWithNotes(SLUG, [note], 'a@example.test');
    expect(takeNotes(SLUG, null)).toBeNull();
    cookWithNotes(SLUG, [note], 'a@example.test');
    expect(takeNotes('japan/osaka/onigiri', 'a@example.test')).toBeNull();
  });
  test('notes on other dishes are never handed over', () => {
    cookWithNotes(SLUG, [note, { ...note, recipe: 'japan/osaka/onigiri' }], 'a@example.test');
    expect(takeNotes(SLUG, 'a@example.test')).toEqual([note]);
  });
});

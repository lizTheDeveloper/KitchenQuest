import { describe, expect, test } from 'vitest';
import type { ApiClient } from '../api/client';
import { loadBook } from './book-screen';

const client = (calls: string[]) => new Proxy({}, {
  get: (_t, name: string) => () => { calls.push(name); return Promise.resolve({ ok: true, status: 200, data: name === 'listNotes' ? { notes: [] } : { shared: 0, byRecipe: {} } }); },
}) as ApiClient;

describe('the book\'s data (M5 Step 11)', () => {
  test('signed in: one GET /notes and the tally', async () => {
    const calls: string[] = [];
    await loadBook(client(calls), { signedIn: true, familyTable: false });
    expect(calls.sort()).toEqual(['listNotes', 'sharedTally']);
  });
  test('Family Table (fix I1) and signed out: no notes, no tally, nothing called', async () => {
    for (const who of [{ signedIn: true, familyTable: true }, { signedIn: false, familyTable: false }]) {
      const calls: string[] = [];
      const d = await loadBook(client(calls), who);
      expect(calls).toEqual([]);
      expect(d).toMatchObject({ notes: [], tally: { shared: 0, byRecipe: {} }, notesShown: false });
    }
  });
});

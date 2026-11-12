import { describe, expect, test } from 'vitest';
import type { ProgressEvent } from '@kitchenquest/core/engine';
import { createStore } from '../state/store';
import { recordRound } from './record';

const setup = (familyTable = false) => {
  const store = createStore(null);
  if (familyTable) store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
  const sent: ProgressEvent[][] = [];
  return { store, sent, record: (e: ProgressEvent[]) => { sent.push(e); return Promise.resolve([]); } };
};

describe('recordRound (M6 Step 9, Rulings 1 and 2)', () => {
  test('one stall_round with the answers as { q, pick } only: no correct flag, no score, nothing extra', () => {
    const { store, sent, record } = setup();
    const answers = [{ q: 'wen-avocado', pick: 2, correct: true }, { q: 'wen-squash', pick: 0 }] as { q: string; pick: number }[];
    recordRound({ store, record }, 'wen', answers, '2026-11-12', { familyTableAtStart: false });
    expect(sent).toHaveLength(1);
    const [e] = sent[0];
    expect(e).toMatchObject({ kind: 'stall_round', at: '2026-11-12', stall: 'wen', answers: [{ q: 'wen-avocado', pick: 2 }, { q: 'wen-squash', pick: 0 }] });
    expect(Object.keys(e).sort()).toEqual(['answers', 'at', 'id', 'kind', 'stall']);
    expect(JSON.stringify(e)).not.toMatch(/correct|score/);
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('no answers → nothing; Family Table → nothing (no event, so no stamp)', () => {
    const a = setup();
    recordRound(a, 'bram', [], '2026-11-12', { familyTableAtStart: false });
    expect(a.sent).toEqual([]);
    const ft = setup(true);
    recordRound(ft, 'bram', [{ q: 'x', pick: 0 }], '2026-11-12', { familyTableAtStart: false });
    expect(ft.sent).toEqual([]);
  });

  test('final I2: a round begun in Family Table keeps nothing, even with Family Table off now', () => {
    const a = setup();
    recordRound(a, 'bram', [{ q: 'x', pick: 0 }], '2026-11-12', { familyTableAtStart: true });
    expect(a.sent).toEqual([]);
  });
});

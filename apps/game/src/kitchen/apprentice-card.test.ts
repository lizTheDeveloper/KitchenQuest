// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { renderApprenticeCard, sharedCount } from './apprentice-card';

describe('the Shared Table on the apprentice card (M5 Step 11, fix M12)', () => {
  test('a count above zero is shown; zero, junk or nothing shows nothing (eating alone is never counted against anyone)', () => {
    expect(sharedCount({ shared: 3, byRecipe: {} })).toBe(3);
    for (const t of [{ shared: 0, byRecipe: {} }, { shared: -1 }, { shared: 1.5 }, null, 'x', {}]) expect(sharedCount(t)).toBeNull();
    const v = { level: 2, stamps: 1 };
    expect(renderApprenticeCard(v, 2).querySelector('.apprentice-shared')?.textContent).toBe('Shared Table: 2 meals cooked for company');
    expect(renderApprenticeCard(v, 1).querySelector('.apprentice-shared')?.textContent).toBe('Shared Table: one meal cooked for company');
    expect(renderApprenticeCard(v, 0).querySelector('.apprentice-shared')).toBeNull();
    expect(renderApprenticeCard(v, null).querySelector('.apprentice-shared')).toBeNull();
    expect(renderApprenticeCard(v).textContent).not.toMatch(/shared/i);
  });
});

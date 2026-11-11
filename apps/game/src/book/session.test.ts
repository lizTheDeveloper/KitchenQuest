import { describe, expect, test } from 'vitest';
import { sessionDrawer } from './session';

describe('the book\'s session guard (M5 Step 11, fix M1/M15)', () => {
  test('an account change clears the page at once; data loaded for the old account is never shown', async () => {
    let session = 'A';
    const shown: string[] = [];
    let cleared = 0;
    let finish: (v: string) => void = () => undefined;
    const draw = sessionDrawer({
      session: () => session, alive: () => true, clear: () => { cleared++; },
      load: () => new Promise<string>((r) => { finish = r; }), show: (d) => { shown.push(d); },
    });
    const first = draw();
    expect(cleared).toBe(1);
    session = 'B'; // another account signs in while A's book is loading
    finish("A's notes");
    await first;
    expect(shown).toEqual([]);
    const second = draw();
    expect(cleared).toBe(2);
    finish("B's notes");
    await second;
    expect(shown).toEqual(["B's notes"]);
    await draw(); // same session: no reload, no clear
    expect(cleared).toBe(2);
    expect(shown).toEqual(["B's notes", "B's notes"]);
  });
  test('nothing is shown once the screen is gone', async () => {
    let alive = true;
    const shown: string[] = [];
    const draw = sessionDrawer({ session: () => 'A', alive: () => alive, clear: () => undefined, load: () => { alive = false; return Promise.resolve('x'); }, show: (d) => { shown.push(d); } });
    await draw();
    expect(shown).toEqual([]);
  });
});

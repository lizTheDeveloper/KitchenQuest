import type { Page, Request } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { expectNoA11yViolations, expectNoHorizontalScroll, openApp, PAN_READY, type OpenedApp } from './helpers';

const RULES_UNREADABLE_MESSAGE =
  "Some of the rules saved on this device couldn't be read, so I can't be sure what to check for. Open Your rules to look them over and confirm them.";
const BAD_RULE = "This rule names an ingredient the ledger doesn't know any more.";
const coconutSevere = { id: 'r1', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };
const milkIntolerance = { id: 'r2', target: { kind: 'ingredient', ids: ['milk'] }, type: 'avoid', severity: 'intolerance' };
const unknownId = { id: 'r3', target: { kind: 'ingredient', ids: ['no_such_ingredient'] }, type: 'avoid', severity: 'allergy' };

let app: OpenedApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('kq.player.v1') ?? '{}') as {
  localRules?: { id: string; target: { ids: string[] }; severity: string }[]; rulesUnreadable?: boolean;
});
const item = (page: Page, name: string) => page.locator('.rules-item', { has: page.locator('.rules-name', { hasText: name }) });

/** Add a rule through the form: search, pick, leave the severity empty, then stamp the 27-B card. */
async function addRule(page: Page, query: string, pick: string): Promise<void> {
  await page.getByRole('button', { name: 'Add a rule' }).click();
  await page.locator('#rule-search').fill(query);
  await page.locator('.rule-form-option', { hasText: pick }).first().click();
  expect(await page.locator('#rule-severity').inputValue()).toBe('');
  await page.getByText('If you leave this, it is filed as a Severe allergy.').waitFor();
  await page.getByRole('button', { name: 'Fill in Form 27-B' }).click();
  const card = page.locator('.rules-card .pan-card');
  await card.waitFor();
  expect(await card.textContent()).toContain('27-B/ALLERGEN');
  await card.getByRole('button', { name: 'Stamp it ✔' }).click();
  await page.locator('.rules-stamped').waitFor();
}

describe('Your rules (M4 Step 11)', () => {
  it('the rules screen adds, removes (a severe one needs the Remove tap) and clears rules-unreadable', async () => {
    app = await openApp('/#/rules', { reducedMotion: true, seed: { ...PAN_READY, localRules: [coconutSevere, milkIntolerance] as never, rulesUnreadable: true } });
    const { page } = app;
    await page.getByRole('heading', { level: 1, name: 'Your rules' }).waitFor();
    // Rules unreadable: the banner, and one tap to say these are all of them.
    await page.getByText(RULES_UNREADABLE_MESSAGE).waitFor();
    expect(await item(page, 'coconut').textContent()).toContain('a severe allergy, on this device');
    expect(await item(page, 'milk').textContent()).toContain('an intolerance, on this device');
    await expectNoA11yViolations(page, 'rules screen, unreadable');
    await page.getByRole('button', { name: 'These are all my rules' }).click();
    await expect.poll(async () => (await stored(page)).rulesUnreadable).toBe(false);
    expect(await page.getByText(RULES_UNREADABLE_MESSAGE).count()).toBe(0);

    // Add: the same 27-B card, signed out: kept on this device.
    await page.getByRole('button', { name: 'Add a rule' }).click();
    await page.locator('#rule-search').fill('sesa');
    await page.locator('.rule-form-option', { hasText: 'sesame' }).first().click();
    await page.getByRole('button', { name: 'Fill in Form 27-B' }).click();
    const card = page.locator('.rules-card .pan-card');
    await card.waitFor();
    expect(await card.textContent()).toContain('S-E-S-A-M-E');
    expect(await card.textContent()).toContain('*Kept on this device only.');
    await expectNoA11yViolations(page, 'rules screen, card');
    await card.getByRole('button', { name: 'Stamp it ✔' }).click();
    await page.locator('.rules-stamped').waitFor();
    await expect.poll(async () => (await stored(page)).localRules?.map((r) => [r.target.ids[0], r.severity])).toEqual([
      ['coconut', 'anaphylactic'], ['milk', 'intolerance'], ['sesame', 'anaphylactic'],
    ]);
    await item(page, 'sesame').waitFor();

    // Remove a severe rule: the 27-B/VOID form asks first; "Keep it" keeps it.
    await item(page, 'coconut').getByRole('button', { name: 'Remove' }).click();
    const dialog = page.getByRole('dialog', { name: 'Removal of a Rule' });
    await dialog.waitFor();
    expect(await dialog.locator('.bureau-lead').textContent()).toContain('coconut');
    await dialog.getByRole('button', { name: 'Keep it' }).click();
    await page.waitForTimeout(100);
    expect((await stored(page)).localRules).toHaveLength(3);
    await item(page, 'coconut').getByRole('button', { name: 'Remove' }).click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect.poll(async () => (await stored(page)).localRules?.map((r) => r.target.ids[0])).toEqual(['milk', 'sesame']);
    expect(await page.locator('#rules-status [data-content]').textContent()).not.toBe('');
    await page.locator('#rules-status').getByRole('button', { name: 'Undo' }).waitFor();
    // The removal line points at the Undo button (a tap), never 'say undo' (the rules screen has no text box).
    expect(await page.locator('#rules-status').textContent()).toMatch(/tap 'Undo'/i);
    expect(await page.locator('#rules-status').textContent()).not.toMatch(/say 'undo'/i);
    // A non-severe rule has no extra warning, but still needs the form's Remove.
    await item(page, 'milk').getByRole('button', { name: 'Remove' }).click();
    await dialog.waitFor();
    expect(await dialog.locator('.bureau-lead').count()).toBe(0);
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect.poll(async () => (await stored(page)).localRules?.map((r) => r.target.ids[0])).toEqual(['sesame']);
    // Undo puts it back.
    await page.locator('#rules-status').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await stored(page)).localRules?.map((r) => r.target.ids[0])).toEqual(['sesame', 'milk']);
    await expectNoHorizontalScroll(page);
    expect(app.consoleErrors).toEqual([]);
  });

  it('it works with the AI off and the API down', async () => {
    app = await openApp('/#/rules', {
      reducedMotion: true, width: 360,
      seed: { ...PAN_READY, localRules: [unknownId] as never, settings: { showCalories: false, reducedMotion: 'system', familyTable: false, iosNoteDismissed: false, aiMentor: false } },
      beforeGoto: (page) => page.route((u) => u.pathname.startsWith('/api/'), (r) => r.abort()),
    });
    const { page } = app;
    await page.getByRole('heading', { level: 1, name: 'Your rules' }).waitFor();
    // A rule the ledger no longer knows: said plainly, and it can be removed.
    expect(await item(page, 'no_such_ingredient').textContent()).toContain(BAD_RULE);
    await item(page, 'no_such_ingredient').getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('dialog', { name: 'Removal of a Rule' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect.poll(async () => (await stored(page)).localRules).toEqual([]);
    await addRule(page, 'peanu', 'peanut');
    await expect.poll(async () => (await stored(page)).localRules?.map((r) => [r.target.ids[0], r.severity])).toEqual([['peanut', 'anaphylactic']]);
    await expectNoHorizontalScroll(page);
    expect(app.requests.filter((u) => new URL(u).pathname.startsWith('/api/mentor'))).toEqual([]);
    expect(app.consoleErrors).toEqual([]);
  });

  it('signed in: device rules the account lacks are named, and each is copied only through its own confirm card', async () => {
    const server: { id: string; target: { kind: string; ids: string[] }; type: string; severity: string }[] = [];
    const posts: Request[] = [];
    app = await openApp('/#/rules', {
      reducedMotion: true,
      seed: { ...PAN_READY, localRules: [coconutSevere] as never },
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route((u) => u.pathname === '/api/rules', (r) => {
          if (r.request().method() !== 'POST') return r.fulfill(json(200, { rules: server }));
          posts.push(r.request());
          const body = r.request().postDataJSON() as { rule: Omit<(typeof server)[number], 'id'> };
          const rule = { ...body.rule, id: `s${server.length + 1}` };
          server.push(rule);
          return r.fulfill(json(201, { rule }));
        });
      },
    });
    const { page } = app;
    const copy = page.locator('.rules-copy');
    await copy.waitFor();
    expect(await copy.textContent()).toContain('coconut');
    expect(await page.getByText('Your account has no rules yet.').count()).toBe(1);
    await copy.getByRole('button', { name: 'Copy to my account' }).click();
    const card = copy.locator('.pan-card');
    await card.waitFor();
    expect(posts).toHaveLength(0);
    expect(await card.textContent()).not.toContain('Kept on this device only');
    await card.getByRole('button', { name: 'Stamp it ✔' }).click();
    await expect.poll(() => posts.length).toBe(1);
    // The card's own reading of the rule (coconut is a category in the ledger), confirmed by the tap.
    expect(posts[0].postDataJSON()).toEqual({ rule: { target: { kind: 'category', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' }, confirmed: true });
    await expect.poll(() => page.locator('.rules-copy').count()).toBe(0);
    expect(await item(page, 'coconut').textContent()).toContain('on your account');
    expect(app.consoleErrors).toEqual([]);
  });

  it('signed in: a device rule stricter than the account\'s is raised only through its own card; the unreadable banner names the device rules it confirms', async () => {
    let server = [{ id: 's1', target: { kind: 'category', ids: ['coconut'] }, type: 'avoid', severity: 'intolerance' }];
    const puts: Request[] = [];
    app = await openApp('/#/rules', {
      reducedMotion: true,
      seed: { ...PAN_READY, localRules: [coconutSevere] as never, rulesUnreadable: true },
      beforeGoto: async (page) => {
        await page.route((u) => u.pathname === '/api/me', (r) => r.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] })));
        await page.route((u) => u.pathname === '/api/rules', (r) => r.fulfill(json(200, { rules: server })));
        await page.route((u) => u.pathname === '/api/rules/s1', (r) => {
          puts.push(r.request());
          const body = r.request().postDataJSON() as { rule: { severity: string } };
          server = [{ ...server[0], ...body.rule, id: 's1' }];
          return r.fulfill(json(200, { rule: server[0] }));
        });
      },
    });
    const { page } = app;
    const banner = page.locator('.rules-unreadable');
    await banner.waitFor();
    await expect.poll(() => banner.textContent()).toContain('coconut: a severe allergy');
    const raise = page.locator('.rules-raise');
    await raise.waitFor();
    expect(await raise.textContent()).toContain('a severe allergy on this device; an intolerance on your account');
    await raise.getByRole('button', { name: /Raise it on my account/ }).click();
    const card = raise.locator('.pan-card');
    await card.waitFor();
    expect(puts).toHaveLength(0);
    await card.getByRole('button', { name: 'Stamp it ✔' }).click();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0].method()).toBe('PUT');
    expect(puts[0].postDataJSON()).toMatchObject({ rule: { severity: 'anaphylactic', target: { ids: ['coconut'] } }, confirmed: true });
    await expect.poll(() => page.locator('.rules-raise').count()).toBe(0);
    expect(await item(page, 'coconut').textContent()).toContain('a severe allergy, on your account');
    // The raise has a trail entry with Undo, like other mentor writes; Undo puts the account's rule back.
    const entry = page.locator('#rules-status .trail-entry');
    await entry.waitFor();
    expect(await entry.textContent()).toContain('coconut');
    await entry.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1].postDataJSON()).toMatchObject({ rule: { severity: 'intolerance', target: { ids: ['coconut'] } }, confirmed: true });
    await expect.poll(() => page.locator('li[data-rule="s1"]').textContent()).toContain('an intolerance, on your account');
    await page.locator('.rules-raise').waitFor();
    expect(app.consoleErrors).toEqual([]);
  });

  it('signed out with nothing readable: the list never says "no rules" under the banner', async () => {
    app = await openApp('/#/rules', { reducedMotion: true, seed: { ...PAN_READY, rulesUnreadable: true } });
    const { page } = app;
    await page.getByText(RULES_UNREADABLE_MESSAGE).waitFor();
    expect(await page.getByText('No rules are saved on this device yet.').count()).toBe(0);
    await page.getByText('None of the rules on this device could be read back.', { exact: false }).waitFor();
  });
});

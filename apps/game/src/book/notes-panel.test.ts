// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';
import type { MarginNote, Rule } from '@kitchenquest/core/engine';
import { content } from '../content';
import { createDialogue } from '../mentor/dialogue';
import type { BookCard, CardWriter, KeepOutcome } from '../mentor/writer';
import type { RulesState } from '../recipes/rules';
import { notesPanel, restoredAt } from './notes-panel';
import type { BookNote } from './book-model';

const SLUG = 'india/kerala/parippu';
const T0 = new Date('2026-11-10T12:00:00');
const peanut: Rule = { id: 'p1', target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' };
const ready = (rules: Rule[]): RulesState => ({ status: 'ready', rules, source: 'account' });
const flush = () => new Promise((r) => setTimeout(r, 0));
const dialogue = createDialogue(content.pan);

function setup(notes: BookNote[], opts: { rules?: Rule[]; signedIn?: boolean } = {}) {
  const log: string[] = [];
  const kept: BookCard[] = [];
  const cooked: MarginNote[][] = [];
  const writer = {
    keep: async (c: BookCard): Promise<KeepOutcome> => { kept.push(c); log.push(`keep`); return { ok: true, id: `new-${kept.length}`, items: [], check: null, undoUntil: new Date(T0.getTime() + 60_000).toISOString() }; },
    unkeep: async (kind: string, id: string) => { log.push(`unkeep ${kind} ${id}`); return 'undone' as const; },
  } as unknown as CardWriter;
  const el = document.createElement('div');
  document.body.append(el);
  notesPanel(el, { slug: SLUG, recipe: content.recipes[SLUG], notes }, {
    writer, signedIn: opts.signedIn ?? true, now: () => T0, today: () => '2026-11-10',
    say: (t, v) => dialogue.say(t, v).text, rules: () => ready(opts.rules ?? []), notes: async () => notes,
    askConsent: async () => false, cook: (n) => { cooked.push([...n]); },
  });
  return { el, log, kept, cooked };
}
const n = (id: string, ops: MarginNote['ops'], text: string | null = null, at = '2026-11-01'): BookNote => ({ recipe: SLUG, ops, text, at, id });

afterEach(() => { document.body.replaceChildren(); });

describe('the notes panel (M5 Step 11)', () => {
  test('lists the notes under "Your margin notes"; "Cook with my notes" is ⛔ and off when a note clashes, with margin.blocked', () => {
    const t = setup([n('a', [{ op: 'add', name: 'peanut butter' }])], { rules: [peanut] });
    expect(t.el.querySelector('h2')?.textContent).toBe('Your margin notes');
    expect(t.el.querySelector('.book-note-text')?.textContent).toBe('added peanut butter');
    const go = t.el.querySelector<HTMLButtonElement>('.cook-with-notes-go')!;
    expect(go.disabled).toBe(true);
    expect(t.el.querySelector('.cook-with-notes .note-check')?.getAttribute('data-status')).toBe('blocked');
    expect(t.el.querySelector('.cook-with-notes .after-cook-line')?.textContent).toContain('peanut');
    go.click();
    expect(t.cooked).toEqual([]);
  });
  test('a clean note: "Cook with my notes" hands over exactly this dish\'s notes', () => {
    const t = setup([n('a', [{ op: 'add', name: 'lime' }])]);
    const go = t.el.querySelector<HTMLButtonElement>('.cook-with-notes-go')!;
    expect(go.disabled).toBe(false); // no rules: nothing to check against
    go.click();
    expect(t.cooked[0].map((x) => (x as BookNote).id)).toEqual(['a']);
  });
  test('with any rule, a note naming something the ledger can\'t identify is ❓, never ✅, and still cookable', () => {
    const milk: Rule = { id: 'm1', target: { kind: 'ingredient', ids: ['milk'] }, type: 'avoid', severity: 'intolerance' };
    const t = setup([n('a', [{ op: 'add', name: 'grandmother\'s secret paste' }])], { rules: [milk] });
    expect(t.el.querySelector('.cook-with-notes .note-check')?.getAttribute('data-status')).toBe('unverified');
    expect(t.el.querySelector<HTMLButtonElement>('.cook-with-notes-go')!.disabled).toBe(false);
  });
  test('delete is a tap with an M4-style undo; the undo puts the note back (and nothing earned is touched)', async () => {
    const t = setup([n('a', [{ op: 'remove', name: 'chilli' }], 'less salt')]);
    t.el.querySelector<HTMLButtonElement>('.book-note-delete')!.click();
    await flush();
    expect(t.log).toEqual(['unkeep margin_note a']);
    expect(t.el.querySelector('.book-note')).toBeNull();
    [...t.el.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!.click();
    await flush();
    expect(t.kept).toHaveLength(1);
    expect(t.kept[0]).toMatchObject({ kind: 'margin_note', note: { recipe: SLUG, ops: [{ op: 'remove', name: 'chilli' }], text: 'less salt', at: '2026-11-10' } });
    expect(t.el.querySelectorAll('.book-note')).toHaveLength(1);
  });
  test('signed out: margin.needs_account and no "Add a note"', () => {
    const t = setup([], { signedIn: false });
    expect(t.el.querySelector('.book-note-new')).toBeNull();
    const text = t.el.querySelector('.book-note-add')?.textContent ?? '';
    expect(content.pan.triggers['margin.needs_account'].lines).toContain(text);
  });
  test('restoredAt keeps a date the server still takes, else today', () => {
    expect(restoredAt('2026-11-10', '2026-11-10')).toBe('2026-11-10');
    expect(restoredAt('2026-11-09T20:00:00Z', '2026-11-10')).toBe('2026-11-09T20:00:00Z');
    expect(restoredAt('2026-11-01', '2026-11-10')).toBe('2026-11-10');
  });
});

describe('fix I4: margin.blocked tells the truth', () => {
  test('every line says the note is kept and "Cook with my notes" stays off while it clashes; none says the change is left out', () => {
    const lines = content.pan.triggers['margin.blocked'].lines;
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const l of lines) {
      expect(l).toContain('{finding}');
      expect(l).toMatch(/Cook with my notes/);
      expect(l).toMatch(/\b(?:keep|kept)\b/i);
      expect(l).not.toMatch(/won't put|without it|can't go in|stay without/i);
    }
  });
});

describe('fix M7: accessibility', () => {
  test('two notes from one day have different Delete names', () => {
    const t = setup([n('a', [{ op: 'add', name: 'lime' }]), n('b', [{ op: 'remove', name: 'chilli' }])]);
    const names = [...t.el.querySelectorAll('.book-note-delete')].map((b) => b.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toContain('added lime');
  });
  test('after "Write it in", focus goes to the new note, never the page', async () => {
    const t = setup([]);
    t.el.querySelector<HTMLButtonElement>('.book-note-new')!.click();
    t.el.querySelector<HTMLTextAreaElement>('.note-text')!.value = 'added lime';
    t.el.querySelector<HTMLButtonElement>('.note-readback')!.click();
    await flush();
    t.el.querySelector<HTMLButtonElement>('.slip-confirm')!.click();
    await flush();
    expect(document.activeElement).toBe(t.el.querySelector('.book-note[data-id="new-1"]'));
  });
});

describe('fix M6: the book\'s consent card always answers', () => {
  const consents = { ok: true, status: 200, data: { consents: [], needsReconsent: [], notices: { health_data: { version: 'v3', text: 'The notice.' } } } };
  test('a failed grant says so and answers false; a good one answers true; no notice answers false', async () => {
    const { askConsentIn } = await import('./book-screen');
    for (const [grant, want] of [[{ ok: false, status: 500, error: { code: 'x', message: '' } }, false], [{ ok: true, status: 201, data: {} }, true]] as const) {
      const box = document.createElement('div');
      const client = { consents: () => Promise.resolve(consents), grantConsent: () => Promise.resolve(grant) } as never;
      const p = askConsentIn(box, client);
      await flush();
      box.querySelector<HTMLButtonElement>('.consent-agree')!.click();
      expect(await p).toBe(want);
      if (!want) expect(box.textContent).toBe(content.pan.triggers['ui.rules.consent_failed'].lines[0]);
    }
    const box = document.createElement('div');
    expect(await askConsentIn(box, { consents: () => Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } }) } as never)).toBe(false);
    expect(box.textContent).toBe(content.pan.triggers['ui.rules.consent_unavailable'].lines[0]);
  });
});

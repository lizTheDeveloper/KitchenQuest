// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { content } from '../content';
import { renderToolkit } from './toolkit-view';

const opts = {
  name: (id: string) => ({ tempering: 'Tempering', legumes: 'Legumes', grains: 'Grains' })[id] ?? id,
  rustyLine: (t: string) => `Your ${t}'s gone a bit rusty. Fancy a refresher?`,
};

function usesChili(el: Element): boolean {
  for (const e of [el, ...el.querySelectorAll('*')]) {
    if (e.getAttribute('style')?.includes('--chili')) return true;
    if (e.classList.contains('chip-blocked')) return true;
  }
  return false;
}

describe('renderToolkit', () => {
  test('a rusty "yours" row shows the tier, the freshness and the rusty invitation', () => {
    const el = renderToolkit([{ technique: 'tempering', tier: 'yours', freshness: 'rusty' }], opts);
    const row = el.querySelector('[data-technique="tempering"]')!;
    expect(row).not.toBeNull();
    const text = row.textContent;
    expect(text).toContain('Tempering');
    expect(text).toContain('Yours');
    expect(text).toContain('Rusty');
    expect(text).toContain("Your Tempering's gone a bit rusty. Fancy a refresher?");
    expect(usesChili(row)).toBe(false);
    expect(row.querySelector('.rusty-invite')).not.toBeNull();
  });

  test('sharp and warm rows have no invitation; a seen row shows no freshness', () => {
    const el = renderToolkit([
      { technique: 'grains', tier: 'seen', freshness: null },
      { technique: 'legumes', tier: 'tried', freshness: 'warm' },
      { technique: 'tempering', tier: 'yours', freshness: 'sharp' },
    ], opts);
    expect(el.querySelectorAll('[data-technique]')).toHaveLength(3);
    expect(el.querySelector('.rusty-invite')).toBeNull();
    expect(el.querySelector('[data-technique="legumes"]')!.textContent).toContain('Warm');
    expect(el.querySelector('[data-technique="legumes"]')!.textContent).toContain('Tried');
    const seen = el.querySelector('[data-technique="grains"]')!.textContent;
    expect(seen).toContain('Seen');
    expect(seen).not.toMatch(/Sharp|Warm|Rusty/);
    expect(usesChili(el)).toBe(false);
  });

  test('three pips per row, the current tier and the ones below it filled', () => {
    const el = renderToolkit([{ technique: 'legumes', tier: 'tried', freshness: 'sharp' }], opts);
    const pips = el.querySelectorAll('[data-technique="legumes"] .pip');
    expect(pips).toHaveLength(3);
    expect([...pips].map((p) => p.classList.contains('is-on'))).toEqual([true, true, false]);
  });

  test('zero rows → the empty footnote, and no "0" or "%" anywhere', () => {
    const el = renderToolkit([], opts);
    const empties = content.bureau.footnotes.filter((f) => f.tag === 'empty').map((f) => f.text);
    expect(empties.length).toBeGreaterThan(0);
    expect(empties).toContain(el.querySelector('.toolkit-empty')!.textContent);
    expect(el.textContent).not.toMatch(/0|%/);
    expect(el.querySelectorAll('[data-technique]')).toHaveLength(0);
  });

  test('no totals, percentages or counts with rows (the only digits are the certificate\'s form number, 51-T)', () => {
    const el = renderToolkit([{ technique: 'tempering', tier: 'yours', freshness: 'rusty' }], opts);
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.toolkit-cert').forEach((c) => c.remove());
    expect(copy.textContent).not.toMatch(/\d|%/);
    expect(el.querySelector('.toolkit-cert')!.textContent).toBe('Form 51-T: Certificate of Technique');
  });

  test('Yours rows show the Certificate of Technique (51-T); Seen and Tried rows do not', () => {
    const el = renderToolkit([
      { technique: 'grains', tier: 'seen', freshness: null },
      { technique: 'legumes', tier: 'tried', freshness: 'sharp' },
      { technique: 'tempering', tier: 'yours', freshness: 'sharp' },
    ], opts);
    expect(el.querySelector('[data-technique="tempering"] .toolkit-cert')!.textContent).toContain('51-T');
    expect(el.querySelector('[data-technique="legumes"] .toolkit-cert')).toBeNull();
    expect(el.querySelector('[data-technique="grains"] .toolkit-cert')).toBeNull();
  });

  test('a Rusty Yours row keeps M3\'s invitation beside the certificate: no new warning, no warning class, no red', () => {
    const el = renderToolkit([{ technique: 'tempering', tier: 'yours', freshness: 'rusty' }], opts);
    const row = el.querySelector('[data-technique="tempering"]')!;
    expect(row.querySelector('.toolkit-cert')).not.toBeNull();
    expect(row.querySelectorAll('.rusty-invite')).toHaveLength(1);
    expect(row.querySelector('.rusty-invite')!.textContent).toBe("Your Tempering's gone a bit rusty. Fancy a refresher?");
    for (const e of [row, ...row.querySelectorAll('*')]) {
      expect(e.className).not.toMatch(/warn|danger|error|alert|blocked/);
      expect(e.getAttribute('role')).not.toBe('alert');
    }
    expect(usesChili(row)).toBe(false);
  });
});

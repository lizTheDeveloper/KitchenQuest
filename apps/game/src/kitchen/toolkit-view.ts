import type { Freshness, Tier, ToolkitRow } from '@kitchenquest/core/engine';
import { content } from '../content';
import { contentText, h } from '../ui/dom';

const TIERS: readonly Tier[] = ['seen', 'tried', 'yours'];
const TIER_WORD: Record<Tier, string> = { seen: 'Seen', tried: 'Tried', yours: 'Yours' };
const FRESH_WORD: Record<Freshness, string> = { sharp: 'Sharp', warm: 'Warm', rusty: 'Rusty' };

function emptyFootnote(): string {
  const pool = content.bureau.footnotes.filter((f) => f.tag === 'empty');
  return pool.length === 0 ? '' : pool[Math.floor(Math.random() * pool.length)].text;
}

/** Audit M-1: a Yours technique carries the Bureau's Form 51-T, the Certificate of Technique. Kept for good. */
function certificate(): HTMLElement | null {
  const forms = content.bureau.forms;
  if (!Object.hasOwn(forms, 'technique_certificate')) return null;
  const f = forms.technique_certificate;
  return contentText('span', `Form ${f.number}: ${f.title}`, { class: 'toolkit-cert' });
}

/**
 * The knife roll's contents: one row per technique the player has. Octalysis M-1 guardrail: no totals,
 * percentages, counts of techniques not yet learned, or locked rows. A Rusty row is an invitation in the
 * Pan's words (spec §17), never a warning: no red, no warning icon.
 */
export function renderToolkit(
  rows: ToolkitRow[],
  opts: { name(id: string): string; rustyLine(technique: string): string; emptyFootnote?: string },
): HTMLElement {
  if (rows.length === 0) {
    return h('div', { class: 'toolkit' }, contentText('p', opts.emptyFootnote ?? emptyFootnote(), { class: 'toolkit-empty bureau-footnote' }));
  }
  const list = h('ul', { class: 'toolkit' });
  for (const row of rows) {
    const name = opts.name(row.technique);
    const rank = TIERS.indexOf(row.tier);
    const pips = h('span', { class: 'pips', 'aria-hidden': 'true' },
      ...TIERS.map((t, i) => h('span', { class: i <= rank ? 'pip is-on' : 'pip', title: TIER_WORD[t] })));
    list.append(h('li', { class: 'toolkit-row', 'data-technique': row.technique, 'data-tier': row.tier, 'data-freshness': row.freshness ?? 'none' },
      contentText('span', name, { class: 'toolkit-name' }),
      h('span', { class: 'toolkit-tier' }, pips, ' ', h('span', { class: 'tier-word' }, TIER_WORD[row.tier])),
      row.freshness ? h('span', { class: `toolkit-fresh fresh-${row.freshness}` }, FRESH_WORD[row.freshness]) : null,
      row.tier === 'yours' ? certificate() : null,
      row.freshness === 'rusty' ? contentText('p', opts.rustyLine(name), { class: 'rusty-invite' }) : null,
    ));
  }
  return list;
}

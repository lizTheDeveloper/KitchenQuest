import type { CheckStatus } from '@kitchenquest/core/engine';
import { h } from './dom';

const CHIPS: Record<CheckStatus, { emoji: string; label: string }> = {
  ok: { emoji: '✅', label: 'OK' },
  swap: { emoji: '🔁', label: 'Swap' },
  blocked: { emoji: '⛔', label: 'Blocked' },
  unverified: { emoji: '❓', label: "Can't verify" },
};

/** Text label plus emoji, so status never rests on colour alone. */
export function statusChip(status: CheckStatus): HTMLElement {
  const c = CHIPS[status];
  return h('span', { class: `chip chip-${status}`, 'data-status': status },
    h('span', { 'aria-hidden': 'true' }, c.emoji), ' ', c.label);
}

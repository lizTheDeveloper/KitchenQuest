// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import type { ProgressEvent, RewardGrant } from '@kitchenquest/core/engine';
import { content } from '../content';
import { announceGrants, friendOf, grantLines, introduced, showToast } from './announce';

const ev = (kind: ProgressEvent['kind'], id = 'e1'): ProgressEvent =>
  ({ id, kind, at: '2026-11-09', ...(kind === 'meal_logged' ? { minute: 600 } : kind === 'cooked' ? { recipe: 'india/kerala/parippu', planned: false } : { quest: 'leela-tempering' }) }) as ProgressEvent;
const g = (x: Partial<RewardGrant> & Pick<RewardGrant, 'kind'>, eventId = 'e1'): RewardGrant => ({ id: `${eventId}#${Math.random()}`, eventId, isoDay: '2026-11-09', ...x }) as RewardGrant;

describe('grant lines', () => {
  test('level → levelup, trust → trust_up, certificate → certificate.technique, stamp → stamp_earned (named), at most two per event, in that order', () => {
    const grants = [
      g({ kind: 'stamp', stamp: 'quest_done' }), g({ kind: 'certificate', technique: 'tempering' }), g({ kind: 'trust', cook: 'haruka', level: 1 }),
      g({ kind: 'xp', amount: 40, reason: 'quest' }), g({ kind: 'level', level: 2 }),
    ];
    expect(grantLines(grants, [ev('quest_done')])).toEqual([
      { trigger: 'levelup', vars: { level: '2' } },
      { trigger: 'trust_up', vars: { cook: 'Haruka' } },
    ]);
    expect(grantLines([g({ kind: 'certificate', technique: 'tempering' }), g({ kind: 'stamp', stamp: 'certificate' })], [ev('cooked')])).toEqual([
      { trigger: 'certificate.technique', vars: { technique: 'Tempering' } },
      { trigger: 'stamp_earned', vars: { stamp: content.bureau.stamp_names.certificate } },
    ]);
  });

  test('trust 3 is the introduction letter: introduction_received names the friend and their place', () => {
    expect(friendOf('leela')).toBe('marisol');
    expect(friendOf('marisol')).toBe('haruka');
    expect(friendOf('haruka')).toBeNull();
    expect(grantLines([g({ kind: 'trust', cook: 'leela', level: 3 })], [ev('cooked')])).toEqual([
      { trigger: 'introduction_received', vars: { cook: content.cooks.leela.name, friend: content.cooks.marisol.name, place: content.cooks.marisol.place } },
    ]);
    expect([...introduced({})]).toEqual(['leela']);
    expect(introduced({ leela: 3 }).has('marisol')).toBe(true);
    expect(introduced({ leela: 2 }).has('marisol')).toBe(false);
  });

  test('M6 Step 9: a stall round\'s weekly stamp is stamp_earned.market_game, naming the keeper from the event\'s stall; its XP says nothing', () => {
    const round = { id: 'r1', kind: 'stall_round', at: '2026-11-09', stall: 'okafor-sato', answers: [{ q: 'x', pick: 0 }] } as ProgressEvent;
    expect(grantLines([g({ kind: 'xp', amount: 5, reason: 'market_game' }, 'r1'), g({ kind: 'stamp', stamp: 'market_game' }, 'r1')], [round])).toEqual([
      { trigger: 'stamp_earned.market_game', vars: { stall: content.stallNames['okafor-sato'] } },
    ]);
    expect(grantLines([g({ kind: 'xp', amount: 5, reason: 'market_game' }, 'r1')], [round])).toEqual([]);
    expect(Object.hasOwn(content.pan.triggers, 'stamp_earned.market_game')).toBe(true);
  });

  test('XP alone says nothing', () => {
    expect(grantLines([g({ kind: 'xp', amount: 30, reason: 'cook' })], [ev('cooked')])).toEqual([]);
  });

  test('nourishment grants produce no line, no toast', () => {
    // Even when a meal log's XP crosses a level, logging food is never applauded by a number (audit R4).
    const grants = [g({ kind: 'xp', amount: 5, reason: 'nourishment' }), g({ kind: 'level', level: 2 })];
    const say = vi.fn(() => 'said');
    const toast = vi.fn();
    expect(announceGrants(grants, [ev('meal_logged')], { say, toast })).toEqual([]);
    expect(say).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  test('each line is said by the Pan and toasted once; the toast is hidden from AT and spoken through the live region', () => {
    const say = vi.fn((t: string) => `line:${t}`);
    const spoken: string[] = [];
    announceGrants([g({ kind: 'level', level: 4 })], [ev('cooked')], { say, toast: (t) => showToast(document, t, (m) => spoken.push(m)) });
    expect(say).toHaveBeenCalledWith('levelup', { level: '4' });
    const shelf = document.getElementById('progress-toasts')!;
    expect(shelf.getAttribute('aria-hidden')).toBe('true');
    expect(shelf.textContent).toBe('line:levelup');
    expect(spoken).toEqual(['line:levelup']);
  });
});

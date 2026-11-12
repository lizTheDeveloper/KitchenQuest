// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { optionOrder, scoreAnswer, type StallQuestion } from '@kitchenquest/core/engine';
import { loadMarket } from './content';
import { boardNumber, renderRound, type RoundAnswer, type RoundDeps } from './round-view';

const deps = (questions: readonly StallQuestion[], ended: { how: string; answers: RoundAnswer[] }[] = []): RoundDeps => ({
  questions, keeper: 'Old Wen', gameName: (g) => `game:${g}`,
  keeperLine: (t) => (t === 'correct' ? 'Keeper says right.' : null), panLine: (t) => `Pan ${t}`,
  itemArt: () => null, itemName: () => null, priceFootnote: '*Example prices in no particular currency. Your shop will differ.',
  onEnd: (how, answers) => { ended.push({ how, answers }); },
});
const mount = () => { const el = document.createElement('div'); document.body.replaceChildren(el); return el; };
const options = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.stall-option')];

describe('the round view (M6 Step 9)', async () => {
  const m = await loadMarket();
  const wen = m.stalls.wen.questions.slice(0, 3);
  const braise = m.stalls.bram.questions.find((q) => q.chalkboard !== undefined)!;

  test('options render in optionOrder; the pick sent is the FILE index; the answer is final', () => {
    const ended: { how: string; answers: RoundAnswer[] }[] = [];
    const el = mount();
    const round = renderRound(el, deps(wen, ended));
    const q = wen[0];
    const order = optionOrder(q.id, q.options.length);
    expect(options(el).map((b) => b.textContent)).toEqual(order.map((i) => q.options[i].text));
    expect(options(el).map((b) => Number(b.dataset.pick))).toEqual(order);
    options(el)[0].click();
    options(el)[1].click(); // no re-pick
    expect(round.answers()).toEqual([{ q: q.id, pick: order[0] }]);
    expect(options(el).every((b) => b.getAttribute('aria-disabled') === 'true')).toBe(true);
  });

  test('a wrong answer shows its reaction and explain, says nothing negative, and focus moves to the reaction', () => {
    const el = mount();
    renderRound(el, deps(wen));
    const q = wen[0];
    const wrong = q.options.findIndex((o) => !o.correct);
    el.querySelector<HTMLButtonElement>(`.stall-option[data-pick="${wrong}"]`)!.click();
    const fb = el.querySelector<HTMLElement>('.stall-feedback')!;
    expect(fb.hidden).toBe(false);
    expect(fb.textContent).toContain(scoreAnswer(q, wrong).reaction);
    expect(fb.textContent).toContain(q.explain);
    expect(fb.textContent).toContain('Pan market.wrong'); // no keeper wrong line → the Pan's
    expect(document.activeElement).toBe(fb);
    expect(el.textContent).not.toMatch(/\bxp\b|lost|lose|penalt|-\s?\d/i);
  });

  test('I4: with no safe keeper line and no safe Pan line, no line is said at all (never an unchecked one)', () => {
    const el = mount();
    renderRound(el, { ...deps(wen), keeperLine: () => null, panLine: () => null });
    options(el)[0].click();
    expect(el.querySelector('.stall-feedback .stall-said')).toBeNull();
    expect(el.querySelector('.stall-feedback .stall-reaction')).not.toBeNull();
  });

  test('a correct answer gets the keeper\'s correct line; Next, then the last question finishes the round with every answer', () => {
    const ended: { how: string; answers: RoundAnswer[] }[] = [];
    const el = mount();
    renderRound(el, deps(wen.slice(0, 2), ended));
    for (const q of wen.slice(0, 2)) {
      const right = q.options.findIndex((o) => o.correct);
      el.querySelector<HTMLButtonElement>(`.stall-option[data-pick="${right}"]`)!.click();
      expect(el.querySelector('.stall-feedback')!.textContent).toContain('Keeper says right.');
      el.querySelector<HTMLButtonElement>('.stall-next')!.click();
    }
    expect(ended).toEqual([{ how: 'done', answers: wen.slice(0, 2).map((q) => ({ q: q.id, pick: q.options.findIndex((o) => o.correct) })) }]);
  });

  test('no timer, countdown, progress bar, "x/5", "in a row" or score element exists in the round DOM', () => {
    const el = mount();
    renderRound(el, deps(wen));
    options(el)[0].click();
    expect(el.querySelectorAll('progress, meter, [role="progressbar"], [role="timer"], time, .timer, .score, .countdown')).toHaveLength(0);
    expect(el.textContent).not.toMatch(/\b\d+\s*(\/|of)\s*\d+\b|in a row|streak|\bscore\b|seconds?\b|left\b|remaining|lives/i);
    expect(el.querySelector('h2')!.textContent).toBe('Question 1'); // orientation only: no total
  });

  test('leaving mid-round ends it with the answers so far; leaving before any answer ends it with none', () => {
    const ended: { how: string; answers: RoundAnswer[] }[] = [];
    const el = mount();
    const r = renderRound(el, deps(wen, ended));
    options(el)[0].click();
    el.querySelector<HTMLButtonElement>('.stall-leave')!.click();
    el.querySelector<HTMLButtonElement>('.stall-leave')?.click();
    expect(ended).toHaveLength(1);
    expect(ended[0].how).toBe('left');
    expect(ended[0].answers).toHaveLength(1);
    expect(r.ended()).toBe(true);
    const none: { how: string; answers: RoundAnswer[] }[] = [];
    renderRound(mount(), deps(wen, none));
    document.querySelector<HTMLButtonElement>('.stall-leave')!.click();
    expect(none).toEqual([{ how: 'left', answers: [] }]);
  });

  test('I3: the chalkboard rows follow the same fixed option order as the buttons (row 1 never gives the answer away)', () => {
    for (const q of [braise, ...m.stalls.bram.variants!.protein_counter!.questions.filter((x) => x.chalkboard !== undefined)]) {
      const el = mount();
      renderRound(el, deps([q]));
      const rows = [...el.querySelectorAll('.stall-chalkboard tbody tr')];
      const order = optionOrder(q.id, q.options.length);
      expect(rows.map((r) => r.querySelector('th')!.textContent)).toEqual(order.map((i) => q.options[i].text));
      expect(rows.map((r) => r.querySelectorAll('td')[0].textContent)).toEqual(order.map((i) => boardNumber(q.chalkboard![i].price)));
      expect(rows.map((r) => r.querySelector('th')!.textContent)).toEqual(options(el).map((b) => b.querySelector('span')!.textContent));
    }
  });

  test('a chalkboard question shows the board and the example-price footnote; no currency symbol in the DOM', () => {
    const el = mount();
    renderRound(el, deps([braise]));
    const board = el.querySelector('.stall-chalkboard')!;
    expect(board.querySelectorAll('tbody tr')).toHaveLength(braise.options.length);
    expect(board.textContent).toContain(boardNumber(braise.chalkboard![0].price));
    expect(board.querySelector('.stall-price-note')!.textContent).toMatch(/Example prices in no particular currency/);
    options(el)[0].click();
    expect(el.textContent).not.toMatch(/[$£€₹¢¥]/);
    expect(el.textContent).not.toMatch(/\bbuy\b/i);
    expect(boardNumber(22.5)).toBe('22.50');
    expect(boardNumber(38)).toBe('38');
  });
});

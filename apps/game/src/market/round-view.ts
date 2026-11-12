// One stall round, one question at a time (M6 Step 9). The questions come already rules-checked (core `stallBank`,
// then `nextRound`); this view only shows them. Options are buttons in core `optionOrder` (Ruling 7), a pick is the
// FILE index, and core `scoreAnswer` says whether it was right. There is no timer, no count of questions answered,
// right or left, no score and no "in a row": a "Question 2" heading is for orientation only. A pick is final for that
// question in this round. Leaving costs nothing, at any question.
import { optionOrder, scoreAnswer, type StallQuestion } from '@kitchenquest/core/engine';
import { contentText, h } from '../ui/dom';

export interface RoundAnswer { q: string; pick: number }

export interface RoundDeps {
  /** The round, in order (core `nextRound` over the player's `stallBank`). */
  questions: readonly StallQuestion[];
  /** Who speaks the keeper's lines (the stall's name on screen). */
  keeper: string;
  /** Form 14-S's name for a minigame (`game:` key), or null when it has none. */
  gameName(game: string): string | null;
  /** The keeper's `correct` / `wrong` line for this question, already rules-checked; null → the Pan's line. */
  keeperLine(trigger: 'correct' | 'wrong', questionId: string): string | null;
  /** The Pan's written line for a trigger (`market.cheer`, `market.wrong`). */
  panLine(trigger: 'market.cheer' | 'market.wrong'): string;
  /** An item sprite's URL for an ingredient id, when the assets manifest has one. */
  itemArt(ingredientId: string): string | null;
  /** The display name of an ingredient id (a ripeness picture's alt text when the option has none). */
  itemName(ingredientId: string): string | null;
  /** Form 14-S's "*Example prices in no particular currency…" footnote, shown under every chalkboard, in every mode. */
  priceFootnote: string;
  /** The round ended: every question answered ('done') or the player left ('left'). `answers` are in answer order. */
  onEnd(how: 'done' | 'left', answers: RoundAnswer[]): void;
}

export interface RoundHandle {
  /** What has been answered so far, in answer order. */
  answers(): RoundAnswer[];
  /** Whether the round has ended (finished or left). */
  ended(): boolean;
}

/** A chalkboard figure as written: whole numbers bare, others to two places (22.5 → "22.50"). No currency, ever. */
export function boardNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * The chalkboard (Ruling 5): one row per option, in the same fixed `optionOrder` as the buttons (I3: file order would
 * put the answer on row 1), the option's own text naming it, its figures read from the file-order data, and the footnote.
 */
function chalkboard(q: StallQuestion, order: readonly number[], footnoteText: string): HTMLElement | null {
  const board = q.chalkboard;
  if (board === undefined || board.length !== q.options.length) return null;
  const rows = order.map((i) => h('tr', null,
    h('th', { scope: 'row' }, contentText('span', q.options[i].text)),
    h('td', null, boardNumber(board[i].price)),
    h('td', null, String(board[i].servings))));
  return h('div', { class: 'stall-chalkboard' },
    h('table', null,
      h('caption', null, 'The chalkboard'),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Option'), h('th', { scope: 'col' }, 'On the board'), h('th', { scope: 'col' }, 'Servings'))),
      h('tbody', null, ...rows)),
    contentText('p', footnoteText, { class: 'bureau-footnote stall-price-note' }));
}

/** Mount the round in `el`. Returns a handle the stall screen reads when the player leaves by another way. */
export function renderRound(el: HTMLElement, deps: RoundDeps): RoundHandle {
  const answers: RoundAnswer[] = [];
  let index = 0;
  let over = false;

  const end = (how: 'done' | 'left') => {
    if (over) return;
    over = true;
    deps.onEnd(how, [...answers]);
  };

  const leaveButton = () => {
    const b = h('button', { type: 'button', class: 'btn btn-secondary stall-leave' }, 'Leave the stall');
    b.addEventListener('click', () => { end('left'); });
    return b;
  };

  const show = (focusHeading: boolean) => {
    const q = deps.questions[index];
    const headingId = `stall-q-${index + 1}`;
    const heading = h('h2', { id: headingId, tabindex: -1 }, `Question ${index + 1}`);
    const game = deps.gameName(q.game);
    const isRipeness = q.game === 'ripeness';
    const promptArtId = isRipeness ? (q.contains ?? []).find((id) => deps.itemArt(id) !== null) : undefined;
    const promptArt = promptArtId === undefined ? null : h('img', { class: 'stall-item-art', src: deps.itemArt(promptArtId), alt: deps.itemName(promptArtId) ?? '' });

    const buttons: HTMLButtonElement[] = [];
    const feedback = h('div', { class: 'stall-feedback', tabindex: -1, hidden: true });
    const controls = h('div', { class: 'button-row stall-controls' }, leaveButton());
    let picked = false;

    const order = optionOrder(q.id, q.options.length);
    const items = order.map((fileIndex) => {
      const option = q.options[fileIndex];
      const artId = isRipeness ? (option.contains ?? []).find((id) => deps.itemArt(id) !== null) : undefined;
      // Ripeness (Ruling 15): the sprite sits beside the text, never instead of it; its alt text is the option's text.
      const art = artId === undefined ? null : h('img', { class: 'stall-item-art', src: deps.itemArt(artId), alt: option.text, 'data-content': '' });
      const mark = h('span', { class: 'stall-option-mark' });
      const button = h('button', { type: 'button', class: 'btn btn-secondary stall-option', 'data-pick': fileIndex }, contentText('span', option.text), mark);
      button.addEventListener('click', () => { answer(fileIndex); });
      buttons.push(button);
      return h('li', { class: 'stall-option-item' }, art, button);
    });

    const answer = (pick: number) => {
      if (picked || over) return; // the answer is final: no re-pick on this question in this round
      picked = true;
      answers.push({ q: q.id, pick });
      const scored = scoreAnswer(q, pick);
      for (const b of buttons) {
        const i = Number(b.dataset.pick);
        b.setAttribute('aria-disabled', 'true');
        b.classList.add('is-answered');
        const mark = b.querySelector<HTMLElement>('.stall-option-mark')!;
        const right = q.options[i].correct === true;
        if (i === pick) b.dataset.picked = 'true';
        if (right) b.dataset.right = 'true';
        // In words, never colour alone. Every option shown is one the rules engine checked ✅, so the right one is safe to name.
        mark.textContent = i === pick && right ? ' (your pick, the right one)' : i === pick ? ' (your pick)' : right ? ' (the right one)' : '';
      }
      const trigger = scored.correct ? 'correct' : 'wrong';
      const keeper = deps.keeperLine(trigger, q.id);
      const said = keeper !== null
        ? h('p', { class: 'stall-said' }, h('span', { class: 'stall-speaker' }, `${deps.keeper}: `), contentText('span', keeper))
        : h('p', { class: 'stall-said' }, h('span', { class: 'stall-speaker' }, 'The Pan: '), contentText('span', deps.panLine(scored.correct ? 'market.cheer' : 'market.wrong')));
      feedback.replaceChildren(
        said,
        contentText('p', scored.reaction, { class: 'stall-reaction' }),
        h('p', { class: 'stall-explain' }, h('strong', null, 'Why: '), contentText('span', scored.explain)),
      );
      feedback.hidden = false;
      const last = index + 1 >= deps.questions.length;
      const next = h('button', { type: 'button', class: 'btn btn-primary stall-next' }, last ? 'Finish the round' : 'Next');
      next.addEventListener('click', () => {
        if (over) return;
        if (last) { end('done'); return; }
        index += 1;
        show(true);
      });
      controls.replaceChildren(next, leaveButton());
      // Focus moves to the reaction, so a keyboard or screen-reader player hears what their pick meant.
      feedback.focus();
    };

    el.replaceChildren(h('section', { class: 'stall-round', 'aria-labelledby': headingId, 'data-question': q.id },
      game === null ? null : contentText('p', game, { class: 'stall-game' }),
      heading,
      promptArt,
      contentText('p', q.prompt, { class: 'stall-prompt' }),
      chalkboard(q, order, deps.priceFootnote),
      h('ul', { class: 'stall-options', 'aria-labelledby': headingId }, ...items),
      feedback,
      controls));
    if (focusHeading) heading.focus();
  };

  if (deps.questions.length === 0) end('done');
  else show(false);

  return { answers: () => [...answers], ended: () => over };
}

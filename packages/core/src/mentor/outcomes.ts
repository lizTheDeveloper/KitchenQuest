import { isSevereCard, type LineRef, type ProposalCard, type ProposalKind } from './cards';
import type { MealSlot } from './parse';

/**
 * What a written card says when it is confirmed, turned down or undone, and its trail summary.
 * The API's write guard and the client's card writer both use these (pre-flight C14), so a write
 * reads the same whichever side made it.
 */

/** A confirmed write can be undone for this long after it was made (M4 README constants). */
export const UNDO_WINDOW_MS = 5 * 60_000;

/** "a", "a and b", "a, b and c": a list of names inside a line's variable. */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The log.logged `{meal}` values (pre-flight C39). */
const MEAL_WORD: Readonly<Record<MealSlot, string>> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  dinner: 'dinner',
  snack: 'a snack',
  other: 'meal',
};

const line = (trigger: string, vars: Record<string, string> = {}): LineRef => ({ trigger, vars });

/** A short summary for the trail entry. */
export function trailSummary(card: ProposalCard): string {
  return card.kind === 'rule' ? `${card.display.ingredient}, ${card.display.severity}` : card.summary;
}

/**
 * The lines after `card` was written. `removedNames`: for a pantry card, the names of the rows
 * actually removed (an item that wasn't there is `pantry.not_found`, never "struck"); for a check-off card (M6 Step
 * 8), the names of the rows this write ticked into the pantry (a row gone or already ticked is skipped), and with
 * none, `market.checkoff_none`.
 */
export function confirmedLines(card: ProposalCard, removedNames: readonly string[] = []): LineRef[] {
  switch (card.kind) {
    case 'rule':
      return [line('rule.stamped', { ingredient: card.display.ingredient }), ...(isSevereCard(card) ? [line('rule.severe_label_reminder')] : [])];
    case 'meal':
      return [line('log.logged', { meal: MEAL_WORD[card.meal.slot] }), ...(card.estimate ? [line('log.estimate_note')] : [])];
    case 'profile':
      return [line('schedule.set', { summary: card.summary })];
    case 'plan':
      return [line('plan.saved')];
    case 'check_off':
      // Only the got rows tick; the missing ones never do (their "Out of stock?" chip is Step 10's).
      if (card.got.length === 0) return [];
      return removedNames.length > 0 ? [line('market.ticked_pantry', { items: listWords([...new Set(removedNames)]) })] : [line('market.checkoff_none')];
    case 'pantry': {
      const out: LineRef[] = [];
      if (card.add.length > 0) out.push(line('pantry.added', { items: listWords(card.add.map((a) => a.name)) }));
      if (removedNames.length > 0) out.push(line('pantry.removed', { items: listWords([...new Set(removedNames)]) }));
      if (out.length === 0) out.push(line('pantry.not_found', { items: listWords(card.remove) }));
      return out;
    }
  }
}

/** The line after a card was turned down; nothing was saved. */
export function rejectedLine(kind: ProposalKind): LineRef {
  return line(kind === 'rule' ? 'rule.not_quite' : 'card.rejected');
}

/** The line after a write was undone. */
export function undoneLine(card: ProposalCard): LineRef {
  return card.kind === 'rule' ? line('rule.voided', { ingredient: card.display.ingredient }) : line('undo');
}

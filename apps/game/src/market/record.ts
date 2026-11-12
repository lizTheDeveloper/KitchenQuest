// A stall round becomes one `stall_round` progress event (M6 Step 9, Rulings 1 and 2). The device sends only what was
// answered: question ids and each pick's FILE index. Never a "correct" flag, a score, or which questions the round
// showed: core scores each pick from the stall file, on the device and on the server alike.
import { MAX_ROUND_ANSWERS, type ProgressEvent, type StallId } from '@kitchenquest/core/engine';
import type { ProgressService } from '../progress/service';
import { newEventId } from '../progress/log';
import type { PlayerStore } from '../state/store';

/** One stall_round per round (finished or left with ≥ 1 answer). Never in Family Table. Never with a correct flag. */
export function recordRound(
  deps: { store: PlayerStore; record: ProgressService['record'] },
  stall: StallId,
  answers: { q: string; pick: number }[],
  today: string,
): void {
  // §19, M5 Ruling 25: Family Table plays by tapping and keeps nothing, no event and so no stamp.
  if (deps.store.get().settings.familyTable || answers.length === 0) return;
  const event: ProgressEvent = {
    id: newEventId(),
    kind: 'stall_round',
    at: today,
    stall,
    // Exactly { q, pick }: nothing else a caller passed along rides into the event.
    answers: answers.slice(0, MAX_ROUND_ANSWERS).map(({ q, pick }) => ({ q, pick })),
  };
  void deps.record([event]).catch((err: unknown) => { console.error('stall round: not recorded', err); });
}

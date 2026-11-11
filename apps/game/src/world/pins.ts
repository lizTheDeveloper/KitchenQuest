/**
 * Where each cook sits on `scene.map`, in percent of the backdrop (from prototype/BRIEF.md, checked by eye
 * against the art). The canvas draws no pins: these place the HTML pin buttons.
 */
export const MAP_PINS: Readonly<Record<string, { x: number; y: number }>> = Object.freeze({
  marisol: { x: 21, y: 44 },
  leela: { x: 67, y: 50 },
  haruka: { x: 86, y: 34 },
});

/**
 * A pin's state (Ruling 3): every launch cook stays visitable, and no pin is ever locked. A cook introduced (the first
 * cook, or a friend whose introducer's trust reached 3) is "expecting you"; any other is "awaiting an introduction",
 * and the permit then reads "Travel anyway".
 */
export type PinState = 'expecting' | 'awaiting';
export const PIN_STATE_TEXT: Readonly<Record<PinState, string>> = Object.freeze({ expecting: 'Expecting you', awaiting: 'Awaiting an introduction' });

export function pinState(cookId: string, introducedCooks: ReadonlySet<string>): PinState {
  return introducedCooks.has(cookId) ? 'expecting' : 'awaiting';
}

/**
 * Where each cook sits on `scene.map`, in percent of the backdrop (from prototype/BRIEF.md, checked by eye
 * against the art). The canvas draws no pins: these place the HTML pin buttons.
 */
export const MAP_PINS: Readonly<Record<string, { x: number; y: number }>> = Object.freeze({
  marisol: { x: 21, y: 44 },
  leela: { x: 67, y: 50 },
  haruka: { x: 86, y: 34 },
});

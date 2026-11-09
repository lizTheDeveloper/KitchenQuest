export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Keep a point inside a rectangle, inset by `margin` on every side. */
export function clampToBounds(p: Point, bounds: Size, margin = 0): Point {
  return {
    x: Math.min(Math.max(p.x, margin), bounds.width - margin),
    y: Math.min(Math.max(p.y, margin), bounds.height - margin),
  };
}

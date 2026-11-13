// A one-shot "focus this when you draw it" between two screens (fix round 1, M-3: the talk control opens Settings →
// Voice, which takes focus once). In memory only.
let pending: string | null = null;

/** Ask the next screen that draws `id` to focus it. */
export function requestFocus(id: string): void { pending = id; }

/** True once, for the screen that draws `id` after a request. */
export function takeFocus(id: string): boolean {
  if (pending !== id) return false;
  pending = null;
  return true;
}

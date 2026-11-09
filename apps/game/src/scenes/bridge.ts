/** Canvas → HTML: a scene's hotspot click becomes the same action as its HTML button. */
const EVENT = 'kq:action';

export function emitAction(id: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id } }));
}

export function onAction(fn: (id: string) => void): () => void {
  const listener = (ev: Event) => {
    const id = (ev as CustomEvent<{ id?: unknown }>).detail?.id;
    if (typeof id === 'string') fn(id);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

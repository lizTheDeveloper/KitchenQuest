/**
 * The Recipe Book's session guard (M5 Step 11, fix M1): the book is one session's (the account and the mode). When the
 * session changes, what was shown goes at once (`clear`), the data is read again for the new session, and data that
 * lands after yet another change, or after the screen has gone, is never shown.
 */
export function sessionDrawer<D>(o: {
  session: () => string; alive: () => boolean; clear: () => void; load: () => Promise<D>; show: (data: D) => void;
}): () => Promise<void> {
  let shownFor: string | null = null;
  let data: { value: D } | null = null;
  return async () => {
    const s = o.session();
    if (s !== shownFor) {
      shownFor = s;
      data = null;
      o.clear();
      const loaded = await o.load();
      if (!o.alive() || o.session() !== s) return;
      data = { value: loaded };
    }
    if (data !== null && o.alive()) o.show(data.value);
  };
}

// M7 Step 10 fix round 1 (I1, controller ruling): at most one voice controller at a time. While hands-free cook mode
// is on it owns voice: the panel's talk control closes its own controller (its microphone too) the moment cook mode
// claims, reads "Hands-free is on", and opens nothing until the claim is released. Lazy: only talk.ts and cook mode
// import it, so first paint never carries it.

type Owner = 'cook';
let owner: Owner | null = null;
const fns = new Set<() => void>();
const tell = () => { for (const fn of [...fns]) fn(); };

export const voiceOwner = (): Owner | null => owner;

/** Claims voice for `who`, at once (listeners close their controllers before this returns). Returns the release. */
export function claimVoice(who: Owner): () => void {
  owner = who;
  tell();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (owner === who) { owner = null; tell(); }
  };
}

export function onVoiceOwner(fn: () => void): () => void {
  fns.add(fn);
  return () => { fns.delete(fn); };
}

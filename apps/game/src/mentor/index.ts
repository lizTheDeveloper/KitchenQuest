import type { PlayerStore } from '../state/store';
import type { LineBank } from '../content/types';
import { reducedMotion } from '../shell/motion';
import { createScriptedBackend } from './backend';
import { createDialogue } from './dialogue';
import { mountMentorPanel, type MentorPanel } from './panel';

export { createDialogue } from './dialogue';
export type { MentorPanel } from './panel';

let mentor: MentorPanel | null = null;

/** The app's single panel. Throws before `mountApp` has mounted it. */
export function getMentor(): MentorPanel {
  if (!mentor) throw new Error('The mentor panel is not mounted yet');
  return mentor;
}

/**
 * Where the line history lives. Standard mode keeps it in the player store. Family Table mode keeps nothing
 * (§19): history stays in this page's memory only and is never written.
 */
export function historyOptions(store: PlayerStore): { history: Record<string, number[]>; onHistory?: (h: Record<string, number[]>) => void } {
  const { dialogueHistory, settings } = store.get();
  if (settings.familyTable) return { history: dialogueHistory };
  return { history: dialogueHistory, onHistory: (h) => { store.update((s) => ({ ...s, dialogueHistory: h })); } };
}

/** Mount the panel once, on the scripted backend, with its line history kept in the player store. */
export function mountMentor(doc: Document, store: PlayerStore, bank: LineBank): MentorPanel {
  if (mentor) return mentor;
  const win = doc.defaultView!;
  const mql = win.matchMedia('(prefers-reduced-motion: reduce)');
  const dialogue = createDialogue(bank, historyOptions(store));
  const root = doc.createElement('div');
  root.id = 'pan-root';
  doc.body.append(root);
  mentor = mountMentorPanel(root, {
    mode: store.get().settings.familyTable ? 'familyTable' : 'standard',
    backend: createScriptedBackend(dialogue),
    dialogue,
    reducedMotion: () => reducedMotion(store.get().settings.reducedMotion, mql),
  });
  return mentor;
}

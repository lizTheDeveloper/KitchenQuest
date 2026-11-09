import { onAction } from '../scenes/bridge';
import { h } from './dom';

export interface SceneAction { id: string; label: string; run(): void }

/**
 * The HTML twin of every canvas hotspot: a `<nav aria-label="Actions">` of real buttons. Canvas hotspots
 * arrive through `onAction` and run the same action. Returns a function that stops listening; the listener
 * also stops by itself once `el` has left the document.
 */
export function renderActionBar(el: HTMLElement, actions: SceneAction[]): () => void {
  const nav = h('nav', { class: 'action-bar', 'aria-label': 'Actions' },
    ...actions.map((a) => h('button', { type: 'button', class: 'btn btn-secondary', 'data-action': a.id, onclick: () => a.run() }, a.label)));
  el.replaceChildren(nav);
  const stop = onAction((id) => {
    if (!nav.isConnected) { stop(); return; }
    actions.find((a) => a.id === id)?.run();
  });
  return stop;
}

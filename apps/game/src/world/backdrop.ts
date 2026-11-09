import { hideStage, showScene, type SceneKey } from '../scenes/phaser-host';
import { h } from '../ui/dom';

/**
 * A scene backdrop the HTML can sit on: a frame holding the pixelated `<img>` (always there, so the frame has
 * its size and the page works without the canvas), the `#stage` canvas laid exactly over it while this screen
 * is up, and an optional layer of HTML controls over both. Returns the cleanup, which hides the stage and puts
 * it back where it lives.
 */
export function mountBackdrop(
  slot: HTMLElement,
  opts: { className: string; src: string; width: number; scene: SceneKey; data?: Record<string, unknown>; layer?: HTMLElement },
): () => void {
  const doc = slot.ownerDocument;
  const img = h('img', { class: `scene-backdrop-img ${opts.className}-img`, src: opts.src, alt: '' });
  const frame = h('div', { class: `scene-frame ${opts.className}-frame` }, img);
  frame.style.width = `${opts.width}px`;
  slot.append(frame);

  const stage = doc.getElementById('stage');
  const home = stage ? { parent: stage.parentNode, next: stage.nextSibling } : null;
  if (stage) {
    frame.append(stage);
    void showScene(stage, opts.scene, opts.data);
  }
  if (opts.layer) frame.append(opts.layer);

  return () => {
    if (!stage || !home?.parent) return;
    hideStage(stage);
    home.parent.insertBefore(stage, home.next?.parentNode === home.parent ? home.next : null);
  };
}

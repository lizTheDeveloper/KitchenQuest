/**
 * The canvas behind the HTML. Phaser is imported the first time a screen asks for a scene; if that fails the
 * screens carry on without it. The canvas lives in `#stage` (aria-hidden), takes no focus and draws no text.
 */
import type * as PhaserGame from './phaser-game';
import type { GameHandle } from './phaser-game';

export type SceneKey = 'Kitchen' | 'Map' | 'CookKitchen' | 'Market';

let loading: Promise<typeof PhaserGame | null> | null = null;
let game: GameHandle | null = null;
/** The scene the current screen wants, so a load that finishes after the screen left shows nothing. */
let wanted = 0;

declare global {
  interface Window {
    /** Test hooks. */
    __kqTweens?: () => number;
    __kqPhaser?: () => { keyboardQueue: number; touchCapture: boolean } | null;
    __kqScene?: string | null;
    __kqPlayer?: () => { x: number; y: number } | null;
  }
}
if (typeof window !== 'undefined') {
  window.__kqTweens = () => game?.tweens() ?? 0;
  window.__kqPhaser = () => game?.probe() ?? null;
}

function loadPhaser() {
  loading ??= import('./phaser-game').catch((err: unknown) => {
    console.warn('The scene canvas could not load; carrying on without it.', err);
    loading = null; // try again next time a screen asks
    return null;
  });
  return loading;
}

function motionReduced(doc: Document): boolean {
  return doc.documentElement.dataset.motion === 'reduced';
}

/** Show `key` in `stage`. Resolves false when Phaser could not load, the scene doesn't exist yet, or the stage was hidden meanwhile. */
export async function showScene(stage: HTMLElement, key: SceneKey, data: Record<string, unknown> = {}): Promise<boolean> {
  const my = ++wanted;
  const mod = await loadPhaser();
  if (!mod || my !== wanted) return false;
  try {
    const full = { ...data, reducedMotion: motionReduced(stage.ownerDocument) };
    game ??= mod.createGame(stage);
    if (!game.show(key, full)) { hideStage(stage); return false; }
    stage.hidden = false;
    return true;
  } catch (err) {
    console.warn('The scene canvas failed to start; carrying on without it.', err);
    return false;
  }
}

/**
 * Hide the canvas and destroy the game, so none of Phaser's window listeners outlive the screen. The next
 * showScene builds a fresh game (Phaser's module stays loaded, so that is quick).
 */
export function hideStage(stage: HTMLElement): void {
  wanted += 1;
  stage.hidden = true;
  game?.destroy();
  game = null;
  if (typeof window !== 'undefined') { window.__kqScene = null; window.__kqPlayer = () => null; }
}

/** A cook's kitchen backdrop: `scene.kitchen-<cookId>` when the art agent provides one, otherwise `scene.kitchen`. */
export function kitchenBackdropKey(assets: Readonly<Record<string, string>>, cookId: string): string {
  const own = `scene.kitchen-${cookId}`;
  return Object.hasOwn(assets, own) ? own : 'scene.kitchen';
}

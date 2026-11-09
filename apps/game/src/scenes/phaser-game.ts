/** Loaded lazily by phaser-host: everything that imports Phaser lives behind this module. */
import Phaser from 'phaser';
import { BootScene, type BootTarget } from './BootScene';
import { CookKitchenScene } from './CookKitchenScene';
import { KitchenScene } from './KitchenScene';
import { MapScene } from './MapScene';

export interface GameHandle {
  /** Start `key` with `data`; false when no such scene is registered. */
  show(key: string, data: Record<string, unknown>): boolean;
  /** Destroy the game: its window listeners go and its canvas is removed (on Phaser's next step). */
  destroy(): void;
  /** Running tweens across every scene. */
  tweens(): number;
  /** Test hook: the keyboard queue length and whether touch input captures (preventDefaults). */
  probe(): { keyboardQueue: number; touchCapture: boolean };
}

const WIDTH = 320;
const HEIGHT = 180;
const SCENES = ['Kitchen', 'Map', 'CookKitchen'];

export function createGame(stage: HTMLElement): GameHandle {
  const zoom = Math.max(1, Math.min(4, Math.floor((stage.parentElement?.clientWidth ?? WIDTH) / WIDTH)));
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: stage,
    width: WIDTH,
    height: HEIGHT,
    zoom,
    pixelArt: true,
    backgroundColor: '#1e1b1d',
    banner: false,
    autoFocus: false,
    audio: { noAudio: true },
    // Never preventDefault mouse or touch: the page must still scroll on a phone over the canvas.
    input: {
      keyboard: true,
      mouse: { preventDefaultDown: false, preventDefaultUp: false, preventDefaultMove: false, preventDefaultWheel: false },
      touch: { capture: false },
      gamepad: false,
    },
    scene: [BootScene, KitchenScene, MapScene, CookKitchenScene],
  });
  const fixCanvas = () => { if (game.canvas) { game.canvas.tabIndex = -1; game.canvas.setAttribute('aria-hidden', 'true'); } };
  fixCanvas();
  game.events.once(Phaser.Core.Events.READY, fixCanvas);

  let booted = false;
  let target: BootTarget | null = null;
  game.registry.set('bootTarget', () => target);
  game.events.once('kq-booted', () => { booted = true; });

  const stopOthers = (keep: string) => {
    for (const s of game.scene.getScenes(false)) {
      const k = s.scene.key;
      if (k !== keep && k !== 'Boot' && (s.scene.isActive() || s.scene.isSleeping() || s.scene.isPaused())) game.scene.stop(k);
    }
  };

  return {
    show(key, data) {
      if (!SCENES.includes(key)) return false;
      target = { key, data };
      if (booted) { stopOthers(key); game.scene.start(key, data); }
      return true;
    },
    destroy() {
      target = null;
      game.destroy(true);
    },
    probe() {
      return { keyboardQueue: (game.input.keyboard as unknown as { queue?: unknown[] } | null)?.queue?.length ?? 0, touchCapture: game.input.touch?.capture ?? false };
    },
    tweens() {
      let n = 0;
      for (const s of game.scene.getScenes(true)) n += s.tweens.getTweens().length;
      return n;
    },
  };
}

/** Loaded lazily by phaser-host: everything that imports Phaser lives behind this module. */
import Phaser from 'phaser';
import { BootScene, type BootTarget } from './BootScene';
import { KitchenScene } from './KitchenScene';

export interface GameHandle {
  /** Start `key` with `data`; false when no such scene is registered. */
  show(key: string, data: Record<string, unknown>): boolean;
  hide(): void;
  /** Running tweens across every scene. */
  tweens(): number;
}

const WIDTH = 320;
const HEIGHT = 180;
const SCENES = ['Kitchen'];

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
    input: { keyboard: true, mouse: true, touch: true, gamepad: false },
    scene: [BootScene, KitchenScene],
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
      game.loop.wake();
      if (booted) { stopOthers(key); game.scene.start(key, data); }
      return true;
    },
    hide() {
      target = null;
      if (booted) stopOthers('');
      game.loop.sleep();
    },
    tweens() {
      let n = 0;
      for (const s of game.scene.getScenes(true)) n += s.tweens.getTweens().length;
      return n;
    },
  };
}

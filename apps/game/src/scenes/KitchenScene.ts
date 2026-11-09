import Phaser from 'phaser';
import { clampToBounds } from '../util/movement';
import { emitAction } from './bridge';

const SPEED = 90; // world pixels per second
type Dir = 'up' | 'down' | 'left' | 'right';

/** True while the player is typing or an overlay is open: the canvas must not steal those keys. */
function inputBlocked(): boolean {
  const a = document.activeElement;
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement) return true;
  if (a instanceof HTMLElement && a.isContentEditable) return true;
  if (document.getElementById('overlay-root')?.childElementCount) return true;
  const pan = document.getElementById('pan-panel');
  return !!pan && !pan.hidden;
}

/**
 * The player's kitchen, drawn behind the HTML: the backdrop at integer scale, the player (arrows/WASD),
 * the Pan, and hotspots that send the same actions as the HTML buttons. No text, ever.
 */
export class KitchenScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Image;
  private keys: Record<Dir, Phaser.Input.Keyboard.Key[]> = { up: [], down: [], left: [], right: [] };
  private bounds = { width: 320, height: 180 };

  constructor() {
    super('Kitchen');
  }

  create(data: { reducedMotion?: boolean }): void {
    const bg = this.add.image(0, 0, 'scene.kitchen').setOrigin(0, 0);
    this.bounds = { width: bg.width, height: bg.height };
    this.scale.resize(bg.width, bg.height);
    this.cameras.main.setBounds(0, 0, bg.width, bg.height);

    const { width, height } = this.bounds;
    const hotspot = (x: number, y: number, w: number, h: number, id: string) =>
      this.add.zone(x, y, w, h).setOrigin(0, 0).setInteractive({ useHandCursor: true }).on('pointerdown', () => emitAction(id));
    hotspot(0, 0, 185, 55, 'recipes'); // the shelves
    hotspot(0, 60, 45, 40, 'toolkit'); // the utensil corner, where the knife roll hangs
    hotspot(width - 20, 0, 20, height, 'map'); // the way out

    const pan = this.add.image(Math.round(width * 0.42), height - 40, 'char.pan').setOrigin(0.5, 1);
    pan.setInteractive({ useHandCursor: true }).on('pointerdown', () => emitAction('talk'));
    if (!data.reducedMotion) {
      this.tweens.add({ targets: pan, y: pan.y - 2, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }
    this.player = this.add.image(Math.round(width * 0.62), height - 32, 'char.player');

    const kb = this.input.keyboard;
    if (kb) {
      // Never preventDefault page keys: the HTML owns the keyboard.
      kb.disableGlobalCapture();
      const add = (code: number) => kb.addKey(code, false);
      const K = Phaser.Input.Keyboard.KeyCodes;
      this.keys = {
        up: [add(K.UP), add(K.W)], down: [add(K.DOWN), add(K.S)],
        left: [add(K.LEFT), add(K.A)], right: [add(K.RIGHT), add(K.D)],
      };
    }
  }

  update(_time: number, delta: number): void {
    if (inputBlocked()) return;
    const held = (d: Dir) => (this.keys[d].some((k) => k.isDown) ? 1 : 0);
    const dx = held('right') - held('left');
    const dy = held('down') - held('up');
    if (dx === 0 && dy === 0) return;
    const step = (SPEED * delta) / 1000;
    const next = clampToBounds(
      { x: this.player.x + dx * step, y: this.player.y + dy * step },
      this.bounds,
      this.player.width / 2,
    );
    this.player.setPosition(next.x, next.y);
  }
}

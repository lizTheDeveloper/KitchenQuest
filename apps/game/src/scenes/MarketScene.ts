import Phaser from 'phaser';
import { emitAction } from './bridge';

/** Where each keeper stands on the 320×180 market street (left edge, as a share of the width), as the prototype lays them out. */
const KEEPERS: readonly { stall: string; sprite: string | null; x: number }[] = [
  { stall: 'wen', sprite: 'char.wen', x: 0.02 },
  { stall: 'bram', sprite: 'char.bram', x: 0.25 },
  { stall: 'okafor-sato', sprite: 'char.okafor-sato', x: 0.49 },
  // The Spice Merchant is never seen (content/market/spice.yaml `art: null`): only the wall of sacks is a hotspot.
  { stall: 'spice', sprite: null, x: 0.78 },
];

/**
 * The market street (M6 Step 9, Ruling 15), drawn behind the HTML: the backdrop and the keepers as hotspots that send
 * `stall:<id>`, the same action as each stall's HTML button. No text, ever; reduced motion means no tween.
 */
export class MarketScene extends Phaser.Scene {
  constructor() {
    super('Market');
  }

  create(data: { reducedMotion?: boolean }): void {
    const bg = this.add.image(0, 0, 'scene.market').setOrigin(0, 0);
    this.scale.resize(bg.width, bg.height);
    this.cameras.main.setBounds(0, 0, bg.width, bg.height);

    for (const k of KEEPERS) {
      const x = Math.round(bg.width * k.x);
      const hasSprite = k.sprite !== null && this.textures.exists(k.sprite);
      const target = hasSprite
        ? this.add.image(x, bg.height - 4, k.sprite!).setOrigin(0, 1)
        : this.add.zone(x, bg.height - 68, 64, 64).setOrigin(0, 0);
      target.setInteractive({ useHandCursor: true }).on('pointerdown', () => emitAction(`stall:${k.stall}`));
      if (hasSprite && !data.reducedMotion) {
        this.tweens.add({ targets: target, y: bg.height - 6, duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      }
    }

    window.__kqScene = 'Market';
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (window.__kqScene === 'Market') window.__kqScene = null;
    });
  }
}

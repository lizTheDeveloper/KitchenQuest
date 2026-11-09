import Phaser from 'phaser';
import { emitAction } from './bridge';

interface CookKitchenData {
  /** Manifest key of the backdrop: `scene.kitchen-<cookId>` or `scene.kitchen`. */
  backdrop: string;
  /** Manifest key of the cook's sprite, `char.<cookId>`. */
  cook: string;
  reducedMotion?: boolean;
}

/**
 * A cook's kitchen, drawn behind the HTML: the backdrop and the cook, who is a hotspot for "Hear the intro
 * again". No text, ever.
 */
export class CookKitchenScene extends Phaser.Scene {
  constructor() {
    super('CookKitchen');
  }

  create(data: CookKitchenData): void {
    const bg = this.add.image(0, 0, this.textures.exists(data.backdrop) ? data.backdrop : 'scene.kitchen').setOrigin(0, 0);
    this.scale.resize(bg.width, bg.height);
    this.cameras.main.setBounds(0, 0, bg.width, bg.height);

    if (this.textures.exists(data.cook)) {
      const cook = this.add.image(Math.round(bg.width * 0.7), bg.height - 8, data.cook).setOrigin(0.5, 1);
      cook.setInteractive({ useHandCursor: true }).on('pointerdown', () => emitAction('intro'));
      if (!data.reducedMotion) {
        this.tweens.add({ targets: cook, y: cook.y - 2, duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      }
    }

    window.__kqScene = 'CookKitchen';
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (window.__kqScene === 'CookKitchen') window.__kqScene = null;
    });
  }
}

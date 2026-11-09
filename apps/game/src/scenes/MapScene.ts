import Phaser from 'phaser';
import { emitAction } from './bridge';

/**
 * The world map, drawn behind the HTML. The cooks' pins are HTML buttons laid over the canvas, so the canvas
 * draws none: only the backdrop and the Pan (a hotspot for "Talk to the Pan"). No text, ever.
 */
export class MapScene extends Phaser.Scene {
  constructor() {
    super('Map');
  }

  create(data: { reducedMotion?: boolean }): void {
    const bg = this.add.image(0, 0, 'scene.map').setOrigin(0, 0);
    this.scale.resize(bg.width, bg.height);
    this.cameras.main.setBounds(0, 0, bg.width, bg.height);

    const pan = this.add.image(6, bg.height - 6, 'char.pan').setOrigin(0, 1);
    pan.setInteractive({ useHandCursor: true }).on('pointerdown', () => emitAction('talk'));
    if (!data.reducedMotion) {
      this.tweens.add({ targets: pan, y: pan.y - 2, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }

    window.__kqScene = 'Map';
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (window.__kqScene === 'Map') window.__kqScene = null;
    });
  }
}

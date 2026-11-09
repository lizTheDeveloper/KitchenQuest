import Phaser from 'phaser';
import assets from 'virtual:kq-assets';

export interface BootTarget { key: string; data: Record<string, unknown> }

/** Loads every manifest sprite as an image, then starts whichever scene the host currently wants. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    for (const [key, url] of Object.entries(assets)) this.load.image(key, url);
  }

  create(): void {
    const target = (this.registry.get('bootTarget') as () => BootTarget | null)();
    this.game.events.emit('kq-booted');
    if (target) this.scene.start(target.key, target.data);
    else this.scene.stop();
  }
}

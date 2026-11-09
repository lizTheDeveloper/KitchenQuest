import Phaser from 'phaser';

/** Loads assets, then hands off to the first playable scene. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    // Load assets from public/assets here, e.g.:
    // this.load.image('chef', 'assets/chef.png');
  }

  create(): void {
    this.scene.start('Kitchen');
  }
}

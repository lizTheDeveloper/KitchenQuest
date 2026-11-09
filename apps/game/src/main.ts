import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { KitchenScene } from './scenes/KitchenScene';

export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#2b1d16',
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: 'arcade',
    arcade: { debug: false },
  },
  scene: [BootScene, KitchenScene],
});

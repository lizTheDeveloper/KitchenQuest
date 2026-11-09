import Phaser from 'phaser';
import { clampToBounds } from '../util/movement';

const SPEED = 220;

/** Placeholder scene: a "chef" square you can move around the kitchen with arrows/WASD. */
export class KitchenScene extends Phaser.Scene {
  private chef!: Phaser.GameObjects.Rectangle;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;

  constructor() {
    super('Kitchen');
  }

  create(): void {
    const { width, height } = this.scale;

    this.add
      .text(width / 2, 40, 'Kitchen Quest', {
        fontFamily: 'Georgia, serif',
        fontSize: '36px',
        color: '#ffd9a0',
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, height - 30, 'Arrow keys / WASD to move', {
        fontFamily: 'sans-serif',
        fontSize: '16px',
        color: '#c9a88a',
      })
      .setOrigin(0.5);

    this.chef = this.add.rectangle(width / 2, height / 2, 32, 32, 0xf4f1ea);

    const keyboard = this.input.keyboard!;
    this.cursors = keyboard.createCursorKeys();
    this.wasd = {
      up: keyboard.addKey('W'),
      down: keyboard.addKey('S'),
      left: keyboard.addKey('A'),
      right: keyboard.addKey('D'),
    };
  }

  update(_time: number, delta: number): void {
    const dx =
      (this.cursors.right.isDown || this.wasd.right.isDown ? 1 : 0) -
      (this.cursors.left.isDown || this.wasd.left.isDown ? 1 : 0);
    const dy =
      (this.cursors.down.isDown || this.wasd.down.isDown ? 1 : 0) -
      (this.cursors.up.isDown || this.wasd.up.isDown ? 1 : 0);

    const step = (SPEED * delta) / 1000;
    const next = clampToBounds(
      { x: this.chef.x + dx * step, y: this.chef.y + dy * step },
      { width: this.scale.width, height: this.scale.height },
      this.chef.width / 2,
    );
    this.chef.setPosition(next.x, next.y);
  }
}

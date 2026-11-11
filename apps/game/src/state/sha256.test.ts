import { describe, expect, test } from 'vitest';
import { sha256Hex } from './sha256';

describe('sha256Hex', () => {
  test('matches SHA-256 on known vectors, padding edges and UTF-8', () => {
    const cases: [string, string][] = [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      ['cook@example.test', '6d12d565fe344253c934713df5d8b5e6984bbc01fa6c81048a9ba425568d39b8'],
      ['ünïcødé@ex.test', '4e7341420dd9f550a5b0687fe74c86fdaff97eaf5d9ec443aa56763ca19969e3'],
      ['xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'd5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072'],
      ['yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy', '4877e564e5e36e367c7c8d59670774becd3350610b6df4c399c9fa9b66da5813'],
      ['z'.repeat(1000), '950f88b09cf1d5e2cdbc5660c77dce3962265c548797950095629a0ea2daea46'],
    ];
    for (const [text, hex] of cases) expect(sha256Hex(text), text.slice(0, 10)).toBe(hex);
  });
});

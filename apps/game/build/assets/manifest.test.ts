import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { AssetError, buildAssetManifest, REQUIRED_ASSETS } from './manifest';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const list = (dir: string): string[] => readdirSync(`${repoRoot}/${dir}`).map((f) => `${dir}/${f}`);
const prototypeFiles = list('prototype/art');
const artFiles = readdirSync(`${repoRoot}/art`, { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? list(`art/${d.name}`) : [`art/${d.name}`]));

function problemsOf(fn: () => unknown): string[] {
  try { fn(); } catch (e) { if (e instanceof AssetError) return e.problems; throw e; }
  throw new Error('expected an AssetError');
}

describe('buildAssetManifest', () => {
  test('the prototype art alone maps through the aliases', () => {
    const { entries } = buildAssetManifest(prototypeFiles);
    expect(entries['char.leela']).toEqual({ key: 'char.leela', file: 'prototype/art/cook_in.png', source: 'prototype' });
    expect(entries['scene.map']!.file).toBe('prototype/art/bg_map.png');
    expect(entries['item.rice']!.file).toBe('prototype/art/i_rice.png');
    for (const key of REQUIRED_ASSETS) expect(entries[key], key).toBeDefined();
  });

  test('art/ wins over prototype/ for the same key', () => {
    const { entries } = buildAssetManifest([...prototypeFiles, 'art/characters/pan.png']);
    expect(entries['char.pan']).toEqual({ key: 'char.pan', file: 'art/characters/pan.png', source: 'art' });
  });

  test('art names are normalised: i_ and bg_ stripped, lower case, _ and spaces to -', () => {
    const { entries } = buildAssetManifest([...prototypeFiles, 'art/items/i_rice.png', 'art/scenes/BG_Big Kitchen.png', 'art/items/bell_pepper.png']);
    expect(entries['item.rice']!.file).toBe('art/items/i_rice.png');
    expect(entries['scene.big-kitchen']!.file).toBe('art/scenes/BG_Big Kitchen.png');
    expect(entries['item.bell-pepper']!.source).toBe('art');
  });

  test('an unknown art/ subdirectory gives one warning and no entry', () => {
    const { entries, warnings } = buildAssetManifest([...prototypeFiles, 'art/sfx/x.png']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('art/sfx/x.png');
    expect(Object.values(entries).some((e) => e.file === 'art/sfx/x.png')).toBe(false);
  });

  test('a non-PNG file in art/ is a warning', () => {
    const { warnings } = buildAssetManifest([...prototypeFiles, 'art/items/rice.jpg']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('art/items/rice.jpg');
  });

  test('two art/ files with the same key are an AssetError', () => {
    const problems = problemsOf(() => buildAssetManifest([...prototypeFiles, 'art/characters/Pan.png', 'art/characters/pan.png']));
    expect(problems.join('\n')).toContain('char.pan');
  });

  test('a missing required key is an AssetError naming it', () => {
    const problems = problemsOf(() => buildAssetManifest(prototypeFiles.filter((f) => f !== 'prototype/art/bg_map.png')));
    expect(problems.join('\n')).toContain('scene.map');
  });

  test('every missing required key is listed', () => {
    const problems = problemsOf(() => buildAssetManifest([]));
    for (const key of REQUIRED_ASSETS) expect(problems.join('\n')).toContain(key);
  });

  test('the real repo (art/ + prototype/art/) builds with no missing keys', () => {
    const { entries } = buildAssetManifest([...artFiles, ...prototypeFiles]);
    for (const key of REQUIRED_ASSETS) expect(entries[key], key).toBeDefined();
    expect(entries['scene.kitchen']!.source).toBe('art');
  });
});

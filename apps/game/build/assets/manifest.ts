/**
 * The sprite manifest: every PNG the game can draw, by key. The art agent's root `art/` folder wins;
 * `prototype/art/` is the fallback. Pure: the plugin passes in the file list.
 */
export interface AssetEntry { key: string; file: string /* repo-relative */; source: 'art' | 'prototype' }

export const ART_DIRS: Readonly<Record<string, string>> = Object.freeze({
  characters: 'char', items: 'item', scenes: 'scene', ui: 'ui',
});

const PROTOTYPE_ITEMS = [
  'avocado', 'beef', 'chicken', 'chili', 'cilantro', 'cumin', 'egg', 'garlic', 'lentils', 'onion',
  'rice', 'seaweed', 'squash', 'strawberry', 'tofu', 'tomato', 'tortilla',
];

/** Prototype file name (without `.png`) → key. Every `i_<x>` is also `item.<x>`, handled by rule below. */
export const PROTOTYPE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  pan: 'char.pan', player: 'char.player', cook_in: 'char.leela', cook_mx: 'char.marisol', cook_jp: 'char.haruka',
  butcher: 'char.bram', grocer: 'char.wen', tofu: 'char.okafor-sato',
  bg_kitchen: 'scene.kitchen', bg_map: 'scene.map', bg_market: 'scene.market',
  ...Object.fromEntries(PROTOTYPE_ITEMS.map((x) => [`i_${x}`, `item.${x}`])),
});

export const REQUIRED_ASSETS: readonly string[] = Object.freeze([
  'char.pan', 'char.player', 'char.leela', 'char.marisol', 'char.haruka', 'scene.kitchen', 'scene.map',
]);

export class AssetError extends Error {
  constructor(public problems: string[]) {
    super(`Asset manifest problems:\n${problems.join('\n')}`);
    this.name = 'AssetError';
  }
}

/** Lower case, drop a leading `bg_` or `i_`, and turn `_` and spaces into `-`. */
export function norm(name: string): string {
  return name.toLowerCase().replace(/^(bg_|i_)/, '').replace(/[_ ]/g, '-');
}

/** Prototype file name → key: an alias, else `i_<x>` → `item.<x>`, else null. */
function prototypeKey(name: string): string | null {
  if (Object.hasOwn(PROTOTYPE_ALIASES, name)) return PROTOTYPE_ALIASES[name]!;
  if (name.startsWith('i_')) return `item.${norm(name)}`;
  return null;
}

/**
 * Build the manifest from repo-relative paths under `art/` and `prototype/art/`. Other paths are ignored,
 * as are files directly in `art/` (its README and its own metadata). Throws an AssetError listing every
 * duplicate art key and every missing required key.
 */
export function buildAssetManifest(files: string[]): { entries: Record<string, AssetEntry>; warnings: string[] } {
  const art = new Map<string, AssetEntry>();
  const proto = new Map<string, AssetEntry>();
  const warnings: string[] = [];
  const problems: string[] = [];

  for (const file of [...files].sort()) {
    const parts = file.split('/');
    if (parts[0] === 'art' && parts.length >= 3) {
      const [, dir, ...rest] = parts;
      const base = rest.join('/');
      if (!Object.hasOwn(ART_DIRS, dir!) || rest.length !== 1) { warnings.push(`${file}: not in a known art folder (${Object.keys(ART_DIRS).join(', ')})`); continue; }
      if (!base.toLowerCase().endsWith('.png')) { warnings.push(`${file}: not a PNG`); continue; }
      const key = `${ART_DIRS[dir!]}.${norm(base.slice(0, -4))}`;
      const prior = art.get(key);
      if (prior) { problems.push(`${key}: both ${prior.file} and ${file}`); continue; }
      art.set(key, { key, file, source: 'art' });
    } else if (parts[0] === 'prototype' && parts[1] === 'art' && parts.length === 3) {
      const base = parts[2]!;
      if (!base.endsWith('.png')) { warnings.push(`${file}: not a PNG`); continue; }
      const key = prototypeKey(base.slice(0, -4));
      if (!key) { warnings.push(`${file}: no key for this prototype sprite`); continue; }
      proto.set(key, { key, file, source: 'prototype' });
    }
  }

  const entries: Record<string, AssetEntry> = {};
  for (const [k, e] of proto) entries[k] = e;
  for (const [k, e] of art) entries[k] = e;
  for (const key of REQUIRED_ASSETS) if (!Object.hasOwn(entries, key)) problems.push(`${key}: missing (required)`);
  if (problems.length > 0) throw new AssetError(problems);
  return { entries, warnings };
}

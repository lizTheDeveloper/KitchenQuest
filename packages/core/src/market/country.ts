// Country names compared one way (Ruling 8): a question's `countries:` scope and the player's profile country both go
// through `normalizeCountry`, so "USA", "U.S.A." and "United States of America" meet as one name.

/** Common other names → the one name every comparison uses. Keys and values are already normalised. */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  us: 'united states',
  usa: 'united states',
  america: 'united states',
  'united states of america': 'united states',
  uk: 'united kingdom',
  gb: 'united kingdom',
  britain: 'united kingdom',
  'great britain': 'united kingdom',
  'united kingdom of great britain and northern ireland': 'united kingdom',
  england: 'united kingdom',
  scotland: 'united kingdom',
  wales: 'united kingdom',
  'northern ireland': 'united kingdom',
  holland: 'netherlands',
  'kingdom of the netherlands': 'netherlands',
  nz: 'new zealand',
  aotearoa: 'new zealand',
  uae: 'united arab emirates',
  'czech republic': 'czechia',
  turkey: 'turkiye',
  'russian federation': 'russia',
  'viet nam': 'vietnam',
  'republic of korea': 'south korea',
  'korea republic of': 'south korea',
  'ivory coast': 'cote divoire',
  'peoples republic of china': 'china',
  prc: 'china',
  deutschland: 'germany',
  espana: 'spain',
  bharat: 'india',
});

/**
 * One comparable name for a country, or null when there is none: lower-cased, accents removed, apostrophes and full
 * stops dropped ("U.S.A." → "usa"), other punctuation read as a space, a leading "the" dropped, then the alias table.
 */
export function normalizeCountry(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const n = name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
  if (n === '') return null;
  return ALIASES[n] ?? n;
}

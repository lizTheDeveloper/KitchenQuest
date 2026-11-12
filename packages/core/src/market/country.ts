// Country names compared one way (Ruling 8): a question's `countries:` scope and the player's profile country both go
// through `normalizeCountry`, so "USA", "U.S.A." and "United States of America" meet as one name. The UK's nations
// stay distinct names, each inside "united kingdom" (fix round 1, I2): a UK-wide fact reaches all four, but a Scottish
// one (Food Standards Scotland) reaches only Scotland.

/** Other names → the one name every comparison uses. Keys and values are already normalised. */
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
  'democratic peoples republic of korea': 'north korea',
  'ivory coast': 'cote divoire',
  'peoples republic of china': 'china',
  prc: 'china',
  deutschland: 'germany',
  espana: 'spain',
  bharat: 'india',
  burma: 'myanmar',
  swaziland: 'eswatini',
  'cape verde': 'cabo verde',
  'east timor': 'timor leste',
  macedonia: 'north macedonia',
  'holy see': 'vatican city',
  vatican: 'vatican city',
  drc: 'democratic republic of the congo',
  'dr congo': 'democratic republic of the congo',
  'congo kinshasa': 'democratic republic of the congo',
  'republic of the congo': 'congo',
  'congo brazzaville': 'congo',
  'lao pdr': 'laos',
  'syrian arab republic': 'syria',
  'republic of ireland': 'ireland',
  eire: 'ireland',
  'brunei darussalam': 'brunei',
  'united republic of tanzania': 'tanzania',
  'state of palestine': 'palestine',
  'federated states of micronesia': 'micronesia',
});

/** Sub-national names a scope may use, each inside its country. A player in one also matches its country's scopes. */
const INSIDE: Readonly<Record<string, string>> = Object.freeze({
  england: 'united kingdom',
  scotland: 'united kingdom',
  wales: 'united kingdom',
  'northern ireland': 'united kingdom',
});

/** Country names as `normalizeCountry` writes them (ISO 3166-1 short names in common English, plus a few territories). */
const COUNTRIES: ReadonlySet<string> = new Set([
  'afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'antigua and barbuda', 'argentina', 'armenia', 'australia',
  'austria', 'azerbaijan', 'bahamas', 'bahrain', 'bangladesh', 'barbados', 'belarus', 'belgium', 'belize', 'benin',
  'bhutan', 'bolivia', 'bosnia and herzegovina', 'botswana', 'brazil', 'brunei', 'bulgaria', 'burkina faso', 'burundi',
  'cabo verde', 'cambodia', 'cameroon', 'canada', 'central african republic', 'chad', 'chile', 'china', 'colombia',
  'comoros', 'congo', 'democratic republic of the congo', 'costa rica', 'cote divoire', 'croatia', 'cuba', 'cyprus',
  'czechia', 'denmark', 'djibouti', 'dominica', 'dominican republic', 'ecuador', 'egypt', 'el salvador',
  'equatorial guinea', 'eritrea', 'estonia', 'eswatini', 'ethiopia', 'fiji', 'finland', 'france', 'gabon', 'gambia',
  'georgia', 'germany', 'ghana', 'greece', 'grenada', 'guatemala', 'guinea', 'guinea bissau', 'guyana', 'haiti',
  'honduras', 'hungary', 'iceland', 'india', 'indonesia', 'iran', 'iraq', 'ireland', 'israel', 'italy', 'jamaica',
  'japan', 'jordan', 'kazakhstan', 'kenya', 'kiribati', 'kosovo', 'kuwait', 'kyrgyzstan', 'laos', 'latvia', 'lebanon',
  'lesotho', 'liberia', 'libya', 'liechtenstein', 'lithuania', 'luxembourg', 'madagascar', 'malawi', 'malaysia',
  'maldives', 'mali', 'malta', 'marshall islands', 'mauritania', 'mauritius', 'mexico', 'micronesia', 'moldova',
  'monaco', 'mongolia', 'montenegro', 'morocco', 'mozambique', 'myanmar', 'namibia', 'nauru', 'nepal', 'netherlands',
  'new zealand', 'nicaragua', 'niger', 'nigeria', 'north korea', 'north macedonia', 'norway', 'oman', 'pakistan',
  'palau', 'palestine', 'panama', 'papua new guinea', 'paraguay', 'peru', 'philippines', 'poland', 'portugal', 'qatar',
  'romania', 'russia', 'rwanda', 'saint kitts and nevis', 'saint lucia', 'saint vincent and the grenadines', 'samoa',
  'san marino', 'sao tome and principe', 'saudi arabia', 'senegal', 'serbia', 'seychelles', 'sierra leone',
  'singapore', 'slovakia', 'slovenia', 'solomon islands', 'somalia', 'south africa', 'south korea', 'south sudan',
  'spain', 'sri lanka', 'sudan', 'suriname', 'sweden', 'switzerland', 'syria', 'taiwan', 'tajikistan', 'tanzania',
  'thailand', 'timor leste', 'togo', 'tonga', 'trinidad and tobago', 'tunisia', 'turkiye', 'turkmenistan', 'tuvalu',
  'uganda', 'ukraine', 'united arab emirates', 'united kingdom', 'united states', 'uruguay', 'uzbekistan', 'vanuatu',
  'vatican city', 'venezuela', 'vietnam', 'yemen', 'zambia', 'zimbabwe',
  'puerto rico', 'hong kong', 'macao', 'greenland', 'guam', 'new caledonia', 'french polynesia', 'reunion',
]);

/**
 * One comparable name for a country, or null when there is none: lower-cased, accents removed, apostrophes and full
 * stops dropped ("U.S.A." → "usa"), other punctuation read as a space, a leading "the" dropped, then the alias table.
 * England, Scotland, Wales and Northern Ireland keep their own names.
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

/** Whether a name (as written) is a country, or a nation inside one, that a `countries:` scope may use. */
export function isKnownCountry(name: string | null | undefined): boolean {
  const n = normalizeCountry(name);
  return n !== null && (COUNTRIES.has(n) || Object.hasOwn(INSIDE, n));
}

/**
 * Ruling 8: whether a player in `country` is inside a scope. The player's own name, or the country it is inside,
 * must be listed: "Scotland" is inside a [United Kingdom] scope, but "United Kingdom" is not inside [Scotland], and
 * "England" is not inside [Scotland]. No country set → inside nothing.
 */
export function countryInScope(scope: readonly string[], country: string | null): boolean {
  const mine = normalizeCountry(country);
  if (mine === null) return false;
  const reach = Object.hasOwn(INSIDE, mine) ? [mine, INSIDE[mine]] : [mine];
  return scope.some((c) => {
    const s = normalizeCountry(c);
    return s !== null && reach.includes(s);
  });
}

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
  // Common short names (M6 Step 4).
  'st lucia': 'saint lucia',
  'st kitts and nevis': 'saint kitts and nevis',
  'st kitts': 'saint kitts and nevis',
  'saint kitts': 'saint kitts and nevis',
  'st vincent and the grenadines': 'saint vincent and the grenadines',
  'st vincent': 'saint vincent and the grenadines',
  'saint vincent': 'saint vincent and the grenadines',
  bosnia: 'bosnia and herzegovina',
  'bosnia herzegovina': 'bosnia and herzegovina',
  trinidad: 'trinidad and tobago',
  antigua: 'antigua and barbuda',
  'sao tome': 'sao tome and principe',
  'kyrgyz republic': 'kyrgyzstan',
  'slovak republic': 'slovakia',
  dprk: 'north korea',
  macau: 'macao',
  'st helena': 'saint helena ascension and tristan da cunha',
  'saint helena': 'saint helena ascension and tristan da cunha',
  'st barts': 'saint barthelemy',
  'st barths': 'saint barthelemy',
  'st barthelemy': 'saint barthelemy',
  'st martin': 'saint martin',
  'st maarten': 'sint maarten',
  'st pierre and miquelon': 'saint pierre and miquelon',
  falklands: 'falkland islands',
  'faeroe islands': 'faroe islands',
  faroes: 'faroe islands',
  bonaire: 'caribbean netherlands',
  usvi: 'us virgin islands',
  bvi: 'british virgin islands',
  // ISO 3166-1's own "Name, qualifier" forms, normalised (M6 Step 4).
  'bolivia plurinational state of': 'bolivia',
  'bonaire sint eustatius and saba': 'caribbean netherlands',
  'congo the democratic republic of the': 'democratic republic of the congo',
  'falkland islands malvinas': 'falkland islands',
  'holy see vatican city state': 'vatican city',
  'iran islamic republic of': 'iran',
  'korea democratic peoples republic of': 'north korea',
  'lao peoples democratic republic': 'laos',
  'micronesia federated states of': 'micronesia',
  'moldova republic of': 'moldova',
  'palestine state of': 'palestine',
  pitcairn: 'pitcairn islands',
  'saint martin french part': 'saint martin',
  'sint maarten dutch part': 'sint maarten',
  'taiwan province of china': 'taiwan',
  'tanzania united republic of': 'tanzania',
  'venezuela bolivarian republic of': 'venezuela',
  'virgin islands british': 'british virgin islands',
  'virgin islands us': 'us virgin islands',
  'virgin islands of the united states': 'us virgin islands',
});

/** Sub-national names a scope may use, each inside its country. A player in one also matches its country's scopes. */
const INSIDE: Readonly<Record<string, string>> = Object.freeze({
  england: 'united kingdom',
  scotland: 'united kingdom',
  wales: 'united kingdom',
  'northern ireland': 'united kingdom',
});

/**
 * Country names as `normalizeCountry` writes them: every ISO 3166-1 entry (249), by its short name in common English,
 * plus Kosovo (no ISO 3166-1 code). M6 Step 4 checked the list against ISO 3166-1 as published in the Debian
 * `iso-codes` package 4.16.0 (iso_3166-1.json, which tracks the ISO 3166 Maintenance Agency), and added the 47
 * dependent territories that were missing. Long official forms ("Republic of Kenya", "Kingdom of Spain") are not
 * aliased: such a player sees only unscoped questions, the safe side.
 */
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
  // ISO 3166-1 territories added in M6 Step 4.
  'aland islands', 'american samoa', 'anguilla', 'antarctica', 'aruba', 'bermuda', 'bouvet island',
  'british indian ocean territory', 'british virgin islands', 'caribbean netherlands', 'cayman islands',
  'christmas island', 'cocos keeling islands', 'cook islands', 'curacao', 'falkland islands', 'faroe islands',
  'french guiana', 'french southern territories', 'gibraltar', 'guadeloupe', 'guernsey',
  'heard island and mcdonald islands', 'isle of man', 'jersey', 'martinique', 'mayotte', 'montserrat', 'niue',
  'norfolk island', 'northern mariana islands', 'pitcairn islands', 'saint barthelemy',
  'saint helena ascension and tristan da cunha', 'saint martin', 'saint pierre and miquelon', 'sint maarten',
  'south georgia and the south sandwich islands', 'svalbard and jan mayen', 'tokelau', 'turks and caicos islands',
  'united states minor outlying islands', 'us virgin islands', 'wallis and futuna', 'western sahara',
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

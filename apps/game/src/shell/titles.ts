/** The title of each lazily loaded screen, written once: the shell reads it before the screen's code has loaded. */
export const SCREEN_TITLES = {
  settings: 'Settings', recipes: 'Recipe shelf', recipe: 'Recipe', cook: 'Cook', map: 'World map', visit: 'Visit', rules: 'Your rules',
  plan: 'This week', market: 'Market list', frame: 'Pantry Frame', book: 'Recipe Book',
  // M6 Step 9: the hub, and a stall until its code has read the rules: the stall screen then names the keeper, or the
  // Protein Counter by its own name (fix round 1, M2: never the butcher's name first).
  stalls: 'The Market', stall: 'Stall',
} as const;


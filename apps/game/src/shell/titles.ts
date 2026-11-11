/** The title of each lazily loaded screen, written once: the shell reads it before the screen's code has loaded. */
export const SCREEN_TITLES = {
  settings: 'Settings', recipes: 'Recipe shelf', recipe: 'Recipe', cook: 'Cook', map: 'World map', visit: 'Visit', rules: 'Your rules',
  plan: 'This week', market: 'Market list', frame: 'Pantry Frame', book: 'Recipe Book',
} as const;

/**
 * The exact-line allowlist of the voice and never-rules scans (Ruling 24, C29). The patterns are never weakened: a
 * legitimate teaching line they catch is listed here, by file and exact text, with the reason it stays. A listed line
 * that is edited, even by one word, stops matching and fails the scan again, so it must be re-justified here.
 *
 * Shared by the content scan (src/content/voice-scan.test.ts) and Step 12's in-page scan, which applies it only inside
 * `[data-content]` (UI chrome gets no allowlist).
 */
export interface VoiceAllowance {
  /** The repo file the line is written in. */
  file: string;
  /** The line, exactly as shipped. */
  line: string;
  reason: string;
}

export const VOICE_ALLOWLIST: readonly VoiceAllowance[] = [
  {
    file: 'content/bureau/forms.yaml',
    line: '*About ½ lb (225 g) of boneless raw meat per person. Example prices.',
    reason: "Form 12-M footnote: Big Bram teaches cost per serving (spec §3.5). 'Example prices' says the figures are examples; nothing is sold.",
  },
  {
    file: 'content/bureau/forms.yaml',
    line: '*Prices shown are examples. Real prices are set by the market, the weather and, the Bureau suspects, the strawberries.',
    reason: 'Market footnote: the same teaching as the Form 12-M footnote. It says the prices are examples set by the real market; the game sells nothing.',
  },
  {
    file: 'content/bureau/forms.yaml',
    line: 'Price per Serving (Butcher)',
    reason: "stamp_names.cost_per_serving: the stall skill Big Bram teaches (spec §3.5, 'price per pound lies'). A shopping skill, not a sale.",
  },
  {
    file: 'content/bureau/forms.yaml',
    line: "*Recipes are taught, gifted and passed on. They are never found, looted or discovered. The Bureau will confiscate the word 'exotic' at the border.",
    reason: 'Map footnote, anti-loot (voice §0.2, §0.3): it names the banned words to say recipes are never treated that way.',
  },
  {
    file: 'content/bureau/forms.yaml',
    line: '*Permit void if the bearer calls anything “exotic”, leaves without washing up, or claims to have “discovered” a dish.',
    reason: 'Form 9-T footnote, anti-loot (voice §2 example 5): claiming to have discovered a dish voids the permit.',
  },
  {
    file: 'content/bureau/forms.yaml',
    line: '*Nobody\'s food is exotic. It\'s somebody\'s Tuesday.',
    reason: "Map footnote: voice §0.2's own wording, saying no food is exotic.",
  },
  {
    file: 'content/dialogue/pan.yaml',
    line: "Nobody's food is 'exotic'. It's somebody's Tuesday.",
    reason: "travel.map_remark: voice §0.2's own wording, saying no food is exotic.",
  },
  {
    file: 'content/bureau/forms.yaml',
    line: "*Missed days are not recorded as missed. They're recorded as days. Days are allowed.",
    reason: 'M3 ledger footnote: says missed days cost nothing (voice §0.7, spec §2.3), the very rule the scan protects.',
  },
  {
    file: 'content/dialogue/pan.yaml',
    line: "I may have missed one of the ingredients you named. If there's another one to avoid, tell me plainly and I'll read it back.",
    reason: "rule.ask_what_else (M4 Step 7, safety): 'missed' is the Pan missing a word the player said, so nothing severe is lost. No days, no streak.",
  },
  {
    file: 'content/dialogue/pan.yaml',
    line: "I may have missed {term}. If you need me to watch for it, tell me plainly and I'll read it back.",
    reason: "rule.ask_what_else (M4 Step 7, safety): 'missed' is the Pan missing an allergen the player named. No days, no streak.",
  },
  {
    file: 'content/cooks/leela.yaml',
    line: 'Cool it, cover it, and keep it in the fridge for three or four days. It will thicken like it is sulking; warm it with a little hot water and stir. It freezes well for a couple of months, though the coconut can separate a little — stir hard when you warm it and it comes back.',
    reason: "Leela's storage FAQ: a food-safety keep time for leftovers, not a count of days played or missed.",
  },
  {
    file: 'content/cooks/marisol.yaml',
    line: "In their broth, in the fridge, for four or five days. They freeze very well too, in their broth, for a few months — freeze them in portions so you can take out just a lunch. Cool them quickly; don't leave a big warm pot on the stove overnight.",
    reason: "Marisol's storage FAQ: a food-safety keep time for leftovers, not a count of days played or missed.",
  },
];

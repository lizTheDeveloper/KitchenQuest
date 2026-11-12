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
  /**
   * Where in that file, as the scan's key path ('triggers.rule.ask_what_else[0]', 'forms.market_list.footnotes[1]').
   * The same words anywhere else are scanned. Step 12's in-page scan matches on `line` inside `[data-content]`.
   */
  where: string;
  /** The line, exactly as shipped. */
  line: string;
  reason: string;
  /**
   * Which scan's pattern the line trips: 'voice' (the content scan in voice-scan.test.ts, the default) or 'countdown'
   * (Step 12's never-rules sweep, which bans "only", "left", "hurry" and "expires" on the plan, market and rescue
   * screens and in their lines). Each scan proves its own entries are needed.
   */
  scan?: 'voice' | 'countdown';
}

export const VOICE_ALLOWLIST: readonly VoiceAllowance[] = [
  {
    file: 'content/bureau/forms.yaml',
    where: 'forms.stall_round.footnotes[0]',
    line: '*Example prices in no particular currency. Your shop will differ.',
    reason: "Form 14-S footnote (M6 Ruling 5): Big Bram's chalkboard teaches cost per serving with example numbers in no currency; the footnote says they are examples, not any shop's prices. Nothing is sold. (Form 12-M dropped its 'Example prices' in M6 Step 4: the list shows no prices.)",
  },
  {
    file: 'content/bureau/forms.yaml',
    where: 'footnotes[15].text',
    line: '*Prices shown are examples. Real prices are set by the market, the weather and, the Bureau suspects, the strawberries.',
    reason: 'Market footnote: the same teaching as the Form 12-M footnote. It says the prices are examples set by the real market; the game sells nothing.',
  },
  {
    file: 'content/bureau/forms.yaml',
    where: 'stamp_names.cost_per_serving',
    line: 'Price per Serving (Butcher)',
    reason: "stamp_names.cost_per_serving: the stall skill Big Bram teaches (spec §3.5, 'price per pound lies'). A shopping skill, not a sale.",
  },
  {
    file: 'content/bureau/forms.yaml',
    where: 'footnotes[25].text',
    line: "*Recipes are taught, gifted and passed on. They are never found, looted or discovered. The Bureau will confiscate the word 'exotic' at the border.",
    reason: 'Map footnote, anti-loot (voice §0.2, §0.3): it names the banned words to say recipes are never treated that way.',
  },
  {
    file: 'content/bureau/forms.yaml',
    where: 'forms.travel.footnotes[0]',
    line: '*Permit void if the bearer calls anything “exotic”, leaves without washing up, or claims to have “discovered” a dish.',
    reason: 'Form 9-T footnote, anti-loot (voice §2 example 5): claiming to have discovered a dish voids the permit.',
  },
  {
    file: 'content/bureau/forms.yaml',
    where: 'footnotes[26].text',
    line: '*Nobody\'s food is exotic. It\'s somebody\'s Tuesday.',
    reason: "Map footnote: voice §0.2's own wording, saying no food is exotic.",
  },
  {
    file: 'content/dialogue/pan.yaml',
    where: 'triggers.travel.map_remark[3]',
    line: "Nobody's food is 'exotic'. It's somebody's Tuesday.",
    reason: "travel.map_remark: voice §0.2's own wording, saying no food is exotic.",
  },
  {
    file: 'content/bureau/forms.yaml',
    where: 'footnotes[29].text',
    line: "*Missed days are not recorded as missed. They're recorded as days. Days are allowed.",
    reason: 'M3 ledger footnote: says missed days cost nothing (voice §0.7, spec §2.3), the very rule the scan protects.',
  },
  {
    file: 'content/dialogue/pan.yaml',
    where: 'triggers.rule.ask_what_else[0]',
    line: "I may have missed one of the ingredients you named. If there's another one to avoid, tell me plainly and I'll read it back.",
    reason: "rule.ask_what_else (M4 Step 7, safety): 'missed' is the Pan missing a word the player said, so nothing severe is lost. No days, no streak.",
  },
  {
    file: 'content/dialogue/pan.yaml',
    where: 'triggers.rule.ask_what_else[1]',
    line: "I may have missed {term}. If you need me to watch for it, tell me plainly and I'll read it back.",
    reason: "rule.ask_what_else (M4 Step 7, safety): 'missed' is the Pan missing an allergen the player named. No days, no streak.",
  },
  {
    file: 'content/cooks/leela.yaml',
    where: 'faq[8].a',
    line: 'Cool it, cover it, and keep it in the fridge for three or four days. It will thicken like it is sulking; warm it with a little hot water and stir. It freezes well for a couple of months, though the coconut can separate a little — stir hard when you warm it and it comes back.',
    reason: "Leela's storage FAQ: a food-safety keep time for leftovers, not a count of days played or missed.",
  },
  {
    file: 'content/cooks/marisol.yaml',
    where: 'faq[8].a',
    line: "In their broth, in the fridge, for three or four days. They freeze very well too, in their broth, for a few months — freeze them in portions so you can take out just a lunch. Cool them quickly; don't leave a big warm pot on the stove overnight.",
    reason: "Marisol's storage FAQ: a food-safety keep time for leftovers, not a count of days played or missed.",
  },
  // Step 12 fix round 1 (I2): the countdown words in plain, unhurried senses. None sets a time limit or a scarcity.
  // M5 final m14: plan.saved[3], plan.dish_unknown[1] and frame.slot_empty[3] were reworded instead ("just a guess",
  // "kept it out", "haven't filled it"), so they need no entry.
  {
    file: 'content/dialogue/pan.yaml',
    where: 'triggers.one_more.refresh[3]',
    line: '{technique} is waiting where you left it. {dish} is a nice way back in, whenever suits.',
    reason: "one_more.refresh: 'left' is the past of leave (where you put it down); with 'whenever suits' it says nothing is lost and there is no deadline.",
    scan: 'countdown',
  },
  {
    file: 'content/dialogue/pan.yaml',
    where: 'triggers.week.move_partial[2]',
    line: "Half there: the plan is on your account, the ticks aren't all. Nothing has left this device; tap Move it again when you're ready.",
    reason: "week.move_partial: 'left' is the past of leave (nothing was taken off the device), a reassurance; 'when you're ready' sets no time.",
    scan: 'countdown',
  },
  // M6 Step 5: the market stalls, scanned now (Ruling 24): food-safety keep times, Big Bram's cost-per-serving teaching
  // and the out-of-stock lines. Everything else the scan caught was reworded (flagged `# REVIEW:` in the stall files).
  {
    file: 'content/market/wen.yaml',
    where: 'triggers.out_of_stock.lines[2]',
    line: 'Sold out of {item}. {swap} will do it. Labelled and checked, as the Bureau insists.',
    reason: "Old Wen's out_of_stock line: stock, not urgency. The out_of_stock line says the item isn't here today and offers a labelled, rules-checked swap; it never hurries the player or counts anything down.",
  },
  {
    file: 'content/market/wen.yaml',
    where: 'questions[0].options[1].reaction',
    line: "That one's ready on Thursday. Lovely if your guacamole is a Thursday guacamole. Leave it on the counter two to five days.",
    reason: "Old Wen's wen-avocado-ripe question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/wen.yaml',
    where: 'questions[10].options[1].reaction',
    line: "The leaves are still trying to grow, using the carrot's water. In two days you'll have a carrot you can tie in a knot.",
    reason: "Old Wen's wen-carrot-tops question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/wen.yaml',
    where: 'questions[12].options[1].reaction',
    line: "Two days on the counter and it's soup. Cilantro likes water and cold.",
    reason: "Old Wen's wen-cilantro-store question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/wen.yaml',
    where: 'item_tips.cilantro.store',
    line: 'Stems in a jar of water in the fridge, loosely bagged. Change the water every two days.',
    reason: "Old Wen's storage tip for cilantro: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/wen.yaml',
    where: 'item_tips.strawberry.store',
    line: 'Unwashed, in the fridge, on paper towel. Rinse just before eating. Two or three days.',
    reason: "Old Wen's storage tip for strawberry: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'triggers.greet.lines[4]',
    line: "Price per pound lies; price per serving tells the truth. That's the first lesson. The second lesson is also that.",
    reason: "Big Bram's greet line: Big Bram's cost-per-serving teaching (spec §3.5 'price per pound lies', M6 Ruling 5). It teaches a shopping skill for the player's own shop; nothing is priced or sold in-app.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'triggers.out_of_stock.lines[2]',
    line: 'Sold out of {item}. {swap} is the next best for that dish. Checked and labelled.',
    reason: "Big Bram's out_of_stock line: stock, not urgency. The out_of_stock line says the item isn't here today and offers a labelled, rules-checked swap; it never hurries the player or counts anything down.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'triggers.farewell.lines[2]',
    line: 'Cheerio! Ground meat within two days, remember. Or freeze it today.',
    reason: "Big Bram's farewell line: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'questions[6].options[0].text',
    line: 'Within one or two days of buying it.',
    reason: "Big Bram's bram-use-by question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'questions[6].options[0].reaction',
    line: "Right. Dates are mostly about the shop's stock, and ground meat is the impatient one: 1–2 days in the fridge, or freeze it. Steaks and roasts give you 3–5.",
    reason: "Big Bram's bram-use-by question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'questions[6].options[1].reaction',
    line: "That's 'sell by' — a note for the shop's stock rotation. For you: ground meat gets cooked or frozen within 1–2 days of buying.",
    reason: "Big Bram's bram-use-by question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'questions[6].options[2].reaction',
    line: "The nose is not a laboratory. The bacteria that make you ill often don't smell at all. Ground meat: cook or freeze within 1–2 days of buying.",
    reason: "Big Bram's bram-use-by question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'questions[6].options[3].reaction',
    line: 'A week is for hard cheese, not ground beef. Grinding spreads surface bacteria all through the meat, so it gets 1–2 days.',
    reason: "Big Bram's bram-use-by question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'questions[6].explain',
    line: 'Raw ground meat should be cooked or frozen within 1–2 days of purchase, and steaks, chops and roasts within 3–5 days, kept at 4°C (40°F) or below.',
    reason: "Big Bram's bram-use-by question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.chuck.store',
    line: 'Fridge, bottom shelf, 3–5 days; freezer for months.',
    reason: "Big Bram's storage tip for chuck: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.short_rib.pick',
    line: 'Meaty on top of the bone, not mostly bone. Price it per serving.',
    reason: "Big Bram's storage tip for short_rib: Big Bram's cost-per-serving teaching (spec §3.5 'price per pound lies', M6 Ruling 5). It teaches a shopping skill for the player's own shop; nothing is priced or sold in-app.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.short_rib.store',
    line: 'Fridge 3–5 days.',
    reason: "Big Bram's storage tip for short_rib: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.shank.store',
    line: 'Fridge 3–5 days.',
    reason: "Big Bram's storage tip for shank: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.strip_steak.store',
    line: 'Fridge 3–5 days. Pat dry and salt before cooking.',
    reason: "Big Bram's storage tip for strip_steak: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.ribeye.store',
    line: 'Fridge 3–5 days.',
    reason: "Big Bram's storage tip for ribeye: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.flank_steak.store',
    line: 'Fridge 3–5 days.',
    reason: "Big Bram's storage tip for flank_steak: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.brisket.store',
    line: 'Fridge 3–5 days.',
    reason: "Big Bram's storage tip for brisket: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.ground_beef.store',
    line: 'Cook or freeze within 1–2 days of buying. Cook to 71°C (160°F).',
    reason: "Big Bram's storage tip for ground_beef: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.chicken_thigh.store',
    line: 'Fridge 1–2 days; freezer for months. Cook to 74°C (165°F).',
    reason: "Big Bram's storage tip for chicken_thigh: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.chicken_breast.store',
    line: 'Fridge 1–2 days. Cook to 74°C (165°F) — and no further, or it dries.',
    reason: "Big Bram's storage tip for chicken_breast: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.whole_chicken.store',
    line: 'Fridge 1–2 days. Keep the carcass for stock.',
    reason: "Big Bram's storage tip for whole_chicken: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.pork_shoulder.store',
    line: 'Fridge 3–5 days.',
    reason: "Big Bram's storage tip for pork_shoulder: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.pork_tenderloin.store',
    line: 'Fridge 3–5 days. Cook to 63°C (145°F) and rest.',
    reason: "Big Bram's storage tip for pork_tenderloin: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.pork_chop.store',
    line: 'Fridge 3–5 days.',
    reason: "Big Bram's storage tip for pork_chop: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'item_tips.lamb_shoulder.store',
    line: 'Fridge 3–5 days.',
    reason: "Big Bram's storage tip for lamb_shoulder: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'faq[8].a',
    line: "'Sell by' is for the shop. 'Use by' is the maker's quality suggestion. For you: ground meat and poultry within 1–2 days of buying, steaks, chops and roasts within 3–5, or freeze.",
    reason: "Big Bram's FAQ answer: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'variants.protein_counter.triggers.greet.lines[1]',
    line: "Ah, a cook! Protein's protein. Today's chalkboard: lentils, beans, tofu, tempeh. The lentils are winning on price, as usual.",
    reason: "Big Bram's greet line (Protein Counter): Big Bram's cost-per-serving teaching (spec §3.5 'price per pound lies', M6 Ruling 5). It teaches a shopping skill for the player's own shop; nothing is priced or sold in-app.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'variants.protein_counter.triggers.greet.lines[4]',
    line: 'Price per serving tells the truth here too. And the truth is: lentils.',
    reason: "Big Bram's greet line (Protein Counter): Big Bram's cost-per-serving teaching (spec §3.5 'price per pound lies', M6 Ruling 5). It teaches a shopping skill for the player's own shop; nothing is priced or sold in-app.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'variants.protein_counter.triggers.farewell.lines[0]',
    line: 'Cheerio! Dried beans keep a year; cooked ones, four or five days in the fridge.',
    reason: "Big Bram's farewell line (Protein Counter): a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'variants.protein_counter.questions[1].explain',
    line: 'Dried lentils and beans are almost always the cheapest protein per serving; divide the price by the servings, not the weight.',
    reason: "Big Bram's bram-pc-cheapest question: Big Bram's cost-per-serving teaching (spec §3.5 'price per pound lies', M6 Ruling 5). It teaches a shopping skill for the player's own shop; nothing is priced or sold in-app.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'variants.protein_counter.item_tips.lentil.store',
    line: 'Airtight jar, cool cupboard, up to a year. Cooked: fridge 4–5 days.',
    reason: "Big Bram's storage tip for lentil (Protein Counter): a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/bram.yaml',
    where: 'variants.protein_counter.item_tips.tofu.store',
    line: 'Opened: cover with fresh water in a container in the fridge, change it daily, use within 3–5 days.',
    reason: "Big Bram's storage tip for tofu (Protein Counter): a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'questions[5].options[0].text',
    line: 'In a container, covered with fresh water, in the fridge; change the water daily and use within 3–5 days.',
    reason: "Okafor-Sato's os-opened-tofu question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'questions[5].options[3].text',
    line: 'In its original water, unchanged, for two weeks.',
    reason: "Okafor-Sato's os-opened-tofu question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'questions[5].options[3].reaction',
    line: 'Two weeks is a long time for tofu to sit in its own bathwater. Fresh water daily, use within 3–5 days.',
    reason: "Okafor-Sato's os-opened-tofu question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'questions[5].explain',
    line: 'Store leftover tofu submerged in fresh water in a covered container in the fridge, change the water daily, and use it within about 3–5 days.',
    reason: "Okafor-Sato's os-opened-tofu question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'questions[6].options[2].text',
    line: 'Yes, for three days.',
    reason: "Okafor-Sato's os-lentil-soak question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'questions[6].options[2].reaction',
    line: "After three days you don't have lentils, you have a science fair. Rinse and simmer — 20–30 minutes.",
    reason: "Okafor-Sato's os-lentil-soak question: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'item_tips.silken_tofu.store',
    line: 'Once opened: fridge, covered, 2–3 days. Never press it.',
    reason: "Okafor-Sato's storage tip for silken_tofu: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'item_tips.soft_tofu.store',
    line: 'Opened: in fresh water in the fridge, change daily, 3–5 days.',
    reason: "Okafor-Sato's storage tip for soft_tofu: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'item_tips.firm_tofu.store',
    line: 'Opened: in fresh water in the fridge, change daily, 3–5 days. Freeze for a chewier texture.',
    reason: "Okafor-Sato's storage tip for firm_tofu: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'item_tips.extra_firm_tofu.store',
    line: 'Opened: in fresh water in the fridge, change daily, 3–5 days.',
    reason: "Okafor-Sato's storage tip for extra_firm_tofu: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'item_tips.canned_bean.store',
    line: 'Cupboard until the date. Opened: transfer to a container, fridge, 3–4 days.',
    reason: "Okafor-Sato's storage tip for canned_bean: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'item_tips.black_bean.store',
    line: 'Dried: airtight, up to a year. Cooked: in their broth, fridge 4–5 days, freezer months.',
    reason: "Okafor-Sato's storage tip for black_bean: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'item_tips.kidney_bean.store',
    line: 'Dried: airtight. Cooked: fridge 4–5 days.',
    reason: "Okafor-Sato's storage tip for kidney_bean: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
  {
    file: 'content/market/okafor-sato.yaml',
    where: 'item_tips.chickpea.store',
    line: 'Keep canned liquid (aquafaba) in the fridge for 2–3 days if you want it.',
    reason: "Okafor-Sato's storage tip for chickpea: a food-safety or ripening keep time (how long the food keeps, in the fridge or on the counter), not a count of days played or missed. Voice §0.7 guards missed days; this teaches storage, as the cooks' storage FAQs do.",
  },
];

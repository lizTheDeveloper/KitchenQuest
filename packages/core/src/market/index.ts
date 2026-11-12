// The market's deciding code (M6): which stall questions a player may see, the Protein Counter, tips and FAQ answers,
// the round order, the option order and scoring, and the Season's Table (the player's seasonal region, if any). Browser-safe: no I/O, no recipe parser, no progress/ (rewards are
// Step 3's, applied by the caller).
export type { AnsweredMap, ItemTip, MarketCtx, StallFaq, StallFile, StallOption, StallQuestion, StallTrigger, StallVariant, StallVariantFile } from './types';
export { faqFor, questionStatus, questionVariant, stallBank, stallVariant, tipFor } from './bank';
export { MAX_ROUND_ANSWERS, nextRound, optionOrder, ROUND_SIZE, scoreAnswer } from './round';
export { validateStallFile } from './validate';
export { countryInScope, isKnownCountry, normalizeCountry } from './country';
export type { SeasonRegion, SeasonTable } from './season';
export { dishSeason, monthOf, seasonalAgrees, seasonalQuestions, seasonOf, seasonRegionFor, validateSeasonTable } from './season';

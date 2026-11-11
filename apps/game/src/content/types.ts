// Content types. Step 3 defines BureauForm (needed by the Bureau form component);
// Step 4 adds the rest of this file.
import type {
  FreshnessThresholds,
  IngredientData,
  ParsedRecipe,
  Quest,
  RuleTerm,
  Substitution,
} from '@kitchenquest/core/engine';

/** The quest types live in core (C33), shared with the API and the quest engine. */
export type { Quest, QuestStep, RiddleOption } from '@kitchenquest/core/engine';

export interface BureauFormField { key: string; label: string; hint?: string }

export interface BureauForm {
  number: string;
  title: string;
  title_aside?: string;
  safety?: boolean;
  fields: BureauFormField[];
  buttons: { confirm: string; decline?: string; undo?: string };
  /** Key into the Bureau file's `stamps` map. */
  stamp: string;
  footnotes?: string[];
}

/** A trigger as shipped to the client: the writers' `when` and `notes` are dropped at build time. */
export interface LineTrigger {
  ai: 'never' | 'allowed';
  lines: string[];
  vars?: Record<string, string>;
}
export interface LineBank {
  persona?: string[];
  triggers: Record<string, LineTrigger>;
}

export interface Faq {
  q: string[];
  a: string;
  a_if_blocked?: string;
  tags?: string[];
}
export interface StallOption { text: string; correct: boolean; reaction: string; contains?: string[] }
export interface StallQuestion {
  id: string;
  game?: string;
  prompt: string;
  options: StallOption[];
  explain: string;
  contains?: string[];
}

export interface CookFile {
  id: string;
  name: string;
  place: string;
  dish: string;
  recipe: string;
  persona: string[];
  intro: string[];
  story: string[];
  quest: Quest;
  gift: string[];
  trust_lines: Record<string, string[]>;
  reactions: { photo: string[]; skip_photo: string[] };
  introduction: string[];
  faq: Faq[];
}
export interface StallFile {
  id: string;
  name: string;
  persona: string[];
  triggers: Record<string, LineTrigger>;
  questions: StallQuestion[];
  /** Other keys (variants, seasonal, item_tips, faq, ...) pass through untouched. */
  [key: string]: unknown;
}
export interface BureauFile {
  forms: Record<string, BureauForm>;
  stamps: Record<string, string>;
  stamp_names: Record<string, string>;
  footnotes: { tag: string; text: string }[];
  disclaimers: Record<string, string>;
}
export interface TechniqueData {
  freshness: FreshnessThresholds;
  techniques: { id: string; name: string }[];
}
export interface GameContent {
  /** First 12 hex of sha256 over all input files, sorted by path. */
  version: string;
  pan: LineBank;
  cooks: Record<string, CookFile>;
  stalls: Record<string, StallFile>;
  bureau: BureauFile;
  /** Slug ('india/kerala/parippu') to parsed recipe, with steps. */
  recipes: Record<string, ParsedRecipe>;
  ingredients: IngredientData;
  substitutions: Substitution[];
  techniques: TechniqueData;
  /** data/rule-terms.json: words that name a rule rather than one ingredient ("vegetarian"). */
  ruleTerms: RuleTerm[];
}

/**
 * What the app bundle carries: everything but the market stalls. No screen shows a stall yet, so their ~135 KB of
 * lines stays out of first paint (the build still validates them; `kq-content` strips them from the module).
 */
export type ClientContent = Omit<GameContent, 'stalls'>;

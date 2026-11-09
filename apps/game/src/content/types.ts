// Content types. Step 3 defines BureauForm (needed by the Bureau form component);
// Step 4 adds the rest of this file.
import type {
  FreshnessThresholds,
  IngredientData,
  ParsedRecipe,
  Substitution,
} from '@kitchenquest/core/engine';

export interface BureauFormField { key: string; label: string; hint?: string }

export interface BureauForm {
  number: string;
  title: string;
  title_aside?: string;
  safety?: boolean;
  fields: BureauFormField[];
  buttons: { confirm: string; decline?: string };
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
export interface RiddleOption { text: string; correct: boolean; reaction: string }
export type QuestStep =
  | { type: 'talk'; lines: string[] }
  | { type: 'riddle'; prompt: string; options: RiddleOption[]; explain: string }
  | { type: 'drill'; skill: string; prompt: string; lines: string[] }
  | { type: 'errand'; stall: string; item: string; lines: string[] }
  | { type: 'cook'; recipe: string };
export interface Quest {
  id: string;
  cook: string;
  title: string;
  unlock: { requires: string[]; trust: number };
  steps: QuestStep[];
  rewards: { xp: number; trust: number; skills: Record<string, number> };
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
}

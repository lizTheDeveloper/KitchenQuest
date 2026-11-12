// Content types: what the build compiles (build/content/compile.ts) and the app bundle carries.
import type {
  FoodGroups,
  Frame,
  FreshnessThresholds,
  IngredientData,
  KeepsMap,
  ParsedRecipe,
  Quest,
  RewardsData,
  RuleTerm,
  SeasonTable,
  StallFile,
  StallId,
  StallMap,
  StallVariantFile,
  Substitution,
  TechniqueNode,
} from '@kitchenquest/core/engine';

/** The quest types live in core (C33), shared with the API and the quest engine. */
export type { Quest, QuestStep, RiddleOption } from '@kitchenquest/core/engine';
/**
 * The market stall types live in core (C33, M6 Step 1), shared with the API (Step 6) and the market functions
 * (`stallBank`, `scoreAnswer`, `keeperLines`, ...). Core's `StallFile` carries `stall`, `art`, `persona?` and `triggers`.
 */
export type { ItemTip, SeasonRegion, SeasonTable, StallFaq, StallFile, StallOption, StallQuestion, StallTrigger, StallVariantFile } from '@kitchenquest/core/engine';

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
  /** Form 14-S only: each minigame's display name, by the stall files' `games:` keys. */
  game?: Record<string, string>;
}

/** A trigger as shipped to the client: the writers' `when` and `notes` are dropped at build time. */
export interface LineTrigger {
  ai: 'never' | 'allowed';
  lines: string[];
  vars?: Record<string, string>;
}
export interface LineBank {
  /** The writers' persona card: never shipped to the client (M6 Step 5); the model's prompt is the server's. */
  persona?: string[];
  triggers: Record<string, LineTrigger>;
}

export interface Faq {
  q: string[];
  a: string;
  a_if_blocked?: string;
  tags?: string[];
}
export interface CookFile {
  id: string;
  name: string;
  place: string;
  dish: string;
  recipe: string;
  /** The writers' persona card: required in the file (the build checks it), never shipped to the client (M6 Step 5). */
  persona?: string[];
  intro: string[];
  story: string[];
  quest: Quest;
  gift: string[];
  trust_lines: Record<string, string[]>;
  reactions: { photo: string[]; skip_photo: string[] };
  introduction: string[];
  faq: Faq[];
}
export interface BureauFile {
  forms: Record<string, BureauForm>;
  stamps: Record<string, string>;
  stamp_names: Record<string, string>;
  footnotes: { tag: string; text: string }[];
  disclaimers: Record<string, string>;
}
/** data/techniques.yaml: the freshness thresholds and every technique with its `adjacent` and `prereqs` (C33). */
export interface TechniqueData {
  freshness: FreshnessThresholds;
  techniques: TechniqueNode[];
}

/** A content/frames/*.yaml file: one Pantry Frame, in core's shape (Ruling 13). */
export type FrameFile = Frame;
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
  /** data/rewards.yaml (Ruling 7): XP amounts, the level curve, stamps and the trust ladder. Read on the device by Step 9. */
  rewards: RewardsData;
  /** content/frames/*.yaml, sorted by id: the Pantry Frames (Ruling 13). */
  frames: FrameFile[];
  /** data/keeps.json: ingredient id → days it keeps once bought (Ruling 12). No entry means no nudge. */
  keeps: KeepsMap;
  /** data/food-groups.json: ingredient or category id → food group, for the plan's balance line. */
  foodGroups: FoodGroups;
  /** data/stalls.json: ingredient or category id → stall, for the market list on the device (C35). */
  stallOf: StallMap;
  /** Each stall's display name: the content/market file's `name`, and `general` from Form 12-M's `general_stall` (C11). */
  stallNames: Record<StallId, string>;
  /** data/seasonality.yaml (Ruling 9): The Season's Table, checked by core `validateSeasonTable`. */
  seasonality: SeasonTable;
}

/**
 * What the first-paint bundle carries (`virtual:kq-content`): everything but the market stalls and The Season's Table.
 * They ship in their own lazy module, `virtual:kq-market` (`MarketContent`, loaded by `src/market/content.ts`), which
 * only the market screens import, so first paint stays under budget (M6 Step 5). The stalls' names reach the client
 * here as `stallNames` (C11), and every M5 field above with them (C35). The ingredient graph's provenance fields
 * (`source`, `fdcId`) are stripped too, and so are the Pan's and the cooks' writer persona cards: nothing on the device
 * reads them (M6 Step 4 ruling, first paint; the stalls' personas are dropped the same way).
 */
export type ClientContent = Omit<GameContent, 'stalls' | 'seasonality'>;

/** A stall as shipped: `persona` and the writers' trigger `when`/`notes` dropped (no model reads them in M6, Ruling 21). */
export type ClientStall = Omit<StallFile, 'persona' | 'variants'> & { variants?: { protein_counter?: Omit<StallVariantFile, 'persona'> } };

/** The lazy market module, `virtual:kq-market` (build/content/market.ts `compileMarket`). */
export interface MarketContent {
  /** Every market stall (not 'general', which has no file). */
  stalls: Record<Exclude<StallId, 'general'>, ClientStall>;
  /** data/seasonality.yaml. Frozen on load (`loadMarket`), so no screen can change a season. */
  seasonality: SeasonTable;
  /** First 12 hex of sha256 over the canonical stall and season JSON: the market's content version (the service worker's cache name). */
  version: string;
}

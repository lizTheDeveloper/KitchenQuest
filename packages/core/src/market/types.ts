// Core's shape of a market stall file (content/market/*.yaml), M6 Step 1. The game's content types re-export these
// (Step 5, C33), and the API reads the same shape (Step 6). Pure types: nothing here runs.
import type { IngredientGraph } from '../ingredients/graph';
import type { Substitution } from '../rules/check';
import type { Rule } from '../rules/types';

export interface StallOption {
  text: string;
  correct: boolean;
  reaction: string;
  contains?: string[];
}

export interface StallQuestion {
  id: string;
  /** Which minigame shape the UI uses: a key of the stall file's own `games:`. */
  game: string;
  prompt: string;
  options: StallOption[];
  explain: string;
  contains?: string[];
  /** Ruling 8: ISO country names this fact is true for; absent = everywhere. */
  countries?: string[];
  /** Ruling 5: value questions only, one entry per option in file order. */
  chalkboard?: { price: number; servings: number }[];
}

export type StallVariant = 'base' | 'protein_counter';

/** A stall keeper's written line bank entry. `when` and `notes` are for writers; the build drops them for the client. */
export interface StallTrigger {
  ai: 'never' | 'allowed';
  lines: string[];
  vars?: Record<string, string>;
  /**
   * Fix round 1 (Task 5 ruling 1): per line, by its index ("0", "1", ...), the graph ids the line names. The build
   * fails a line whose text names a graph food it doesn't declare; `keeperLines` checks the declared ids and the scan.
   */
  contains?: Record<string, string[]>;
  when?: string;
  notes?: string;
}

export interface ItemTip {
  pick: string;
  store: string;
}

/** Ruling 21: a tappable written question. `q[0]` is the chip; `a` is shown only after the rules check (`faqFor`). */
export interface StallFaq {
  q: string[];
  a: string;
  /** Shown instead of `a` when `a` names something the player's rules block or can't verify. */
  a_if_blocked?: string;
  tags?: string[];
}

/** `variants.protein_counter` (Ruling 4): a full stall of its own, used when the player's rules block `meat`. */
export interface StallVariantFile {
  name?: string;
  persona?: string[];
  triggers: Record<string, StallTrigger>;
  questions: StallQuestion[];
  item_tips: Record<string, ItemTip>;
  faq: StallFaq[];
}

export interface StallFile {
  id: string;
  name: string;
  /** The stall's kind ("butcher", "produce", ...). */
  stall: string;
  /** The keeper's sprite key, or null when the keeper is never seen. */
  art: string | null;
  /** Writers' persona card; never shipped to the client (Step 5's `ClientStall` omits it). */
  persona?: string[];
  /** greet, correct, wrong, out_of_stock, out_of_stock_none, medical / allergen_note, ... */
  triggers: Record<string, StallTrigger>;
  /** Minigame key → one-line description. */
  games: Record<string, string>;
  questions: StallQuestion[];
  variants?: { protein_counter?: StallVariantFile };
  /** `seasonal.<region>.<month 1–12>`: Wen's seasonal round. Step 2 picks the region and month. */
  seasonal?: Record<string, Record<string, StallQuestion[]>>;
  item_tips: Record<string, ItemTip>;
  faq: StallFaq[];
}

/** `subs` is carried for callers' convenience; questionStatus, tipFor and faqFor never apply it (a question names the item itself). */
export interface MarketCtx {
  rules: Rule[];
  graph: IngredientGraph;
  subs: Substitution[];
  /** The player's local date, YYYY-MM-DD. */
  date: string;
  /** The player's profile country as written, or null when none is set. */
  country: string | null;
}

/** Per question id: whether it was ever answered correctly, and the local date it was last answered (Step 3 derives it). */
export type AnsweredMap = ReadonlyMap<string, { correct: boolean; lastAt: string }>;

import { z } from 'zod';

// Unknown keys are allowed everywhere except the market stalls (below): writers add notes.
const obj = <T extends z.core.$ZodLooseShape>(shape: T) => z.looseObject(shape);

const TRIGGER_ID = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

const lineTrigger = obj({
  ai: z.enum(['never', 'allowed']),
  when: z.string(),
  lines: z.array(z.string()).min(1, 'needs at least one line'),
  vars: z.record(z.string(), z.string()).optional(),
  notes: z.string().optional(),
});
const triggerMap = z.record(
  z.string().regex(TRIGGER_ID, 'trigger id must be dotted lowercase (a-z, 0-9, _)'),
  lineTrigger,
);

export const lineBank = obj({ persona: z.array(z.string()).optional(), triggers: triggerMap });

const faq = obj({
  q: z.array(z.string()).min(1),
  a: z.string(),
  a_if_blocked: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const riddleOption = obj({ text: z.string(), correct: z.boolean(), reaction: z.string() });

const questStep = z.discriminatedUnion('type', [
  obj({ type: z.literal('talk'), lines: z.array(z.string()).min(1) }),
  obj({ type: z.literal('travel'), place: z.string(), lines: z.array(z.string()) }),
  obj({
    type: z.literal('riddle'),
    prompt: z.string(),
    options: z.array(riddleOption).min(2),
    explain: z.string(),
  }),
  obj({ type: z.literal('drill'), skill: z.string(), prompt: z.string(), lines: z.array(z.string()).min(1) }),
  obj({
    type: z.literal('errand'),
    stall: z.string(),
    item: z.string(),
    lines: z.array(z.string()).min(1),
    /** What the cook says instead when the player's rules block the item (M5 Step 2). */
    adapted: z.array(z.string()).optional(),
  }),
  /** Audit M-3. Empty `lines` and `otherwise` in M5: the game speaks the Pan's quest.recognize line instead. */
  obj({ type: z.literal('recognize'), technique: z.string(), lines: z.array(z.string()), otherwise: z.array(z.string()) }),
  /** `technique` (optional) narrows the stand-ins for a rule-blocked dish to that one of the recipe's skills. */
  obj({ type: z.literal('cook'), recipe: z.string(), technique: z.string().optional() }),
]);

const quest = obj({
  id: z.string(),
  cook: z.string(),
  title: z.string(),
  unlock: obj({ requires: z.array(z.string()), trust: z.number() }),
  steps: z.array(questStep).min(1),
  rewards: obj({ xp: z.number(), trust: z.number(), skills: z.record(z.string(), z.number()) }),
});

export const cookFile = obj({
  id: z.string(),
  name: z.string(),
  place: z.string(),
  dish: z.string(),
  recipe: z.string(),
  persona: z.array(z.string()),
  intro: z.array(z.string()),
  story: z.array(z.string()),
  quest,
  gift: z.array(z.string()),
  trust_lines: z.record(z.string(), z.array(z.string())),
  reactions: obj({ photo: z.array(z.string()), skip_photo: z.array(z.string()) }),
  introduction: z.array(z.string()),
  faq: z.array(faq),
});

// ---- market stalls (M6 Step 5): strict. An unknown key anywhere in a stall file fails the build, with its path, so
// a misspelt `contians:` or `countires:` can never silently drop a rules check or a country scope. Writers' notes go
// in YAML comments, or in a trigger's `when` / `notes`, which the build drops for the client.
const strict = <T extends z.core.$ZodLooseShape>(shape: T) => z.strictObject(shape);
const ids = z.array(z.string());

const stallTrigger = strict({
  ai: z.enum(['never', 'allowed']),
  when: z.string(),
  lines: z.array(z.string()).min(1, 'needs at least one line'),
  vars: z.record(z.string(), z.string()).optional(),
  notes: z.string().optional(),
});
const stallTriggers = z.record(z.string().regex(TRIGGER_ID, 'trigger id must be dotted lowercase (a-z, 0-9, _)'), stallTrigger);

const stallOption = strict({
  text: z.string(),
  correct: z.boolean(),
  reaction: z.string(),
  contains: ids.optional(),
});
const stallQuestion = strict({
  id: z.string(),
  game: z.string(),
  prompt: z.string(),
  options: z.array(stallOption),
  explain: z.string(),
  contains: ids.optional(),
  /** Ruling 8: the ISO country names this fact is true for. */
  countries: ids.optional(),
  /** Ruling 5: one { price, servings } per option, in file order. */
  chalkboard: z.array(strict({ price: z.number(), servings: z.number() })).optional(),
});
const stallQuestions = z.array(stallQuestion);
const itemTips = z.record(z.string(), strict({ pick: z.string(), store: z.string() }));
const stallFaq = z.array(strict({
  q: z.array(z.string()).min(1),
  a: z.string(),
  a_if_blocked: z.string().optional(),
  tags: z.array(z.string()).optional(),
}));

export const stallFile = strict({
  id: z.string(),
  name: z.string(),
  /** The stall's kind ("produce", "butcher", ...). */
  stall: z.string(),
  /** The keeper's sprite key; null for a keeper who is never seen. */
  art: z.string().nullable(),
  persona: z.array(z.string()),
  triggers: stallTriggers,
  games: z.record(z.string(), z.string()),
  questions: stallQuestions,
  variants: strict({
    protein_counter: strict({
      name: z.string().optional(),
      persona: z.array(z.string()).optional(),
      triggers: stallTriggers,
      questions: stallQuestions,
      item_tips: itemTips,
      faq: stallFaq,
    }).optional(),
  }).optional(),
  /** region → month (1–12) → questions: Wen's "Seasonal or well-travelled?" round (Ruling 9). */
  seasonal: z.record(z.string(), z.record(z.string(), stallQuestions)).optional(),
  item_tips: itemTips,
  faq: stallFaq,
});

/** data/seasonality.yaml: only "a map of regions" here; core's `validateSeasonTable` checks each region and names it. */
export const seasonalityFile = z.record(z.string(), z.unknown());

const bureauForm = obj({
  number: z.string(),
  title: z.string(),
  title_aside: z.string().optional(),
  safety: z.boolean().optional(),
  fields: z.array(obj({ key: z.string(), label: z.string(), hint: z.string().optional() })),
  buttons: obj({ confirm: z.string(), decline: z.string().optional(), undo: z.string().optional() }),
  stamp: z.string(),
  footnotes: z.array(z.string()).optional(),
  /** Form 14-S only: each minigame's display name, by the stall files' `games:` keys (M6 Step 5: the known games). */
  game: z.record(z.string(), z.string()).optional(),
});

export const FOOTNOTE_TAGS = ['any', 'empty', 'loading', 'market', 'kitchen', 'map', 'ledger', 'settings'] as const;

export const bureauFile = obj({
  forms: z.record(z.string(), bureauForm),
  stamps: z.record(z.string(), z.string()),
  stamp_names: z.record(z.string(), z.string()),
  footnotes: z.array(obj({ tag: z.string(), text: z.string() })),
  disclaimers: z.record(z.string(), z.string()),
});

/** Only the freshness shape here: the per-technique checks (adjacent, prereqs) are core's `validateTechniques`. */
export const techniquesFile = obj({
  freshness: obj({ warm_after_days: z.number(), rusty_after_days: z.number() }),
  techniques: z.array(z.unknown()),
});

// Checked by core (validateRewards, validateFrames, validateKeeps, validateStallMap, validateFoodGroups), whose
// messages name the field; the schemas only check the top-level shape.
export const rewardsFile = z.unknown();
export const frameFile = z.unknown();
export const idMapFile = z.record(z.string(), z.unknown());

export const ingredientsFile = obj({ ingredients: z.array(obj({ id: z.string(), name: z.string() })) });
/** Only "a list" here: the per-term checks are core's `validateRuleTerms`, whose messages name the term. */
export const ruleTermsFile = z.array(z.unknown());
export const substitutionsFile = z.array(obj({ from: z.string(), to: z.string() }));

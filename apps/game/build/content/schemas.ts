import { z } from 'zod';

// Unknown keys are allowed everywhere: writers add notes.
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
  obj({
    type: z.literal('riddle'),
    prompt: z.string(),
    options: z.array(riddleOption).min(2),
    explain: z.string(),
  }),
  obj({ type: z.literal('drill'), skill: z.string(), prompt: z.string(), lines: z.array(z.string()).min(1) }),
  obj({ type: z.literal('errand'), stall: z.string(), item: z.string(), lines: z.array(z.string()).min(1) }),
  obj({ type: z.literal('cook'), recipe: z.string() }),
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

const stallOption = obj({
  text: z.string(),
  correct: z.boolean(),
  reaction: z.string(),
  contains: z.array(z.string()).optional(),
});
const stallQuestion = obj({
  id: z.string(),
  game: z.string().optional(),
  prompt: z.string(),
  options: z.array(stallOption),
  explain: z.string(),
  contains: z.array(z.string()).optional(),
});
const stallQuestions = z.array(stallQuestion);

export const stallFile = obj({
  id: z.string(),
  name: z.string(),
  persona: z.array(z.string()),
  triggers: triggerMap,
  questions: stallQuestions,
  variants: z.record(z.string(), obj({ questions: stallQuestions.optional() })).optional(),
});

const bureauForm = obj({
  number: z.string(),
  title: z.string(),
  title_aside: z.string().optional(),
  safety: z.boolean().optional(),
  fields: z.array(obj({ key: z.string(), label: z.string(), hint: z.string().optional() })),
  buttons: obj({ confirm: z.string(), decline: z.string().optional() }),
  stamp: z.string(),
  footnotes: z.array(z.string()).optional(),
});

export const FOOTNOTE_TAGS = ['any', 'empty', 'loading', 'market', 'kitchen', 'map', 'ledger', 'settings'] as const;

export const bureauFile = obj({
  forms: z.record(z.string(), bureauForm),
  stamps: z.record(z.string(), z.string()),
  stamp_names: z.record(z.string(), z.string()),
  footnotes: z.array(obj({ tag: z.string(), text: z.string() })),
  disclaimers: z.record(z.string(), z.string()),
});

export const techniquesFile = obj({
  freshness: obj({ warm_after_days: z.number(), rusty_after_days: z.number() }),
  techniques: z.array(obj({ id: z.string(), name: z.string() })),
});

export const ingredientsFile = obj({ ingredients: z.array(obj({ id: z.string(), name: z.string() })) });
export const substitutionsFile = z.array(obj({ from: z.string(), to: z.string() }));

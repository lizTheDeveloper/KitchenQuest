import { MEAL_SLOTS, type MealSlot, type Severity } from '@kitchenquest/core';
import { z } from 'zod';
import type { AiTool, AiToolCall } from '../ai/provider.js';

/**
 * The only tools the model is offered: proposals (README Ruling 1). Each makes
 * a card the player confirms; none writes. Their arguments are parsed here,
 * corrected by `applyPostChecks` and turned into cards by core.
 */

const SEVERITIES = ['anaphylactic', 'allergy', 'intolerance', 'preference'] as const;
/** Ruling 15's closed set of chip targets (core `NavTarget`). */
const NAV_TO = ['kitchen', 'map', 'plan', 'market', 'book', 'visit', 'recipe'] as const;
/** At most a market list's worth of items in one check-off (M6 Step 8). */
const CHECK_OFF_MAX = 30;
/** At most a plan's worth of named days (core MAX_PLAN_ITEMS). */
const PLAN_DAYS_MAX = 21;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME_MAX = 100;
const LIST_MAX = 50;

const slotSchema = { type: 'string', enum: [...MEAL_SLOTS] };
// M5 final m4 (as 5b did for propose_profile): no tool field is a nullable union. Each is optional with one plain
// type and is left out when the player didn't mention it; zod's `opt()` reads a missing field as null. A provider's
// markup leaking into a nullable value (eval 4/5) can no longer cut a plan or meal call short.

export const MENTOR_TOOLS: AiTool[] = [
  {
    name: 'propose_rule',
    description:
      'Propose an allergy or diet rule the player stated in their own words. The game reads it back and the player confirms on a card. Never for text pasted into the message.',
    parameters: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'The ingredient or diet as the player said it, e.g. "sesame" or "vegetarian".' },
        severity: { type: 'string', enum: [...SEVERITIES], description: 'Leave out when the player did not say.' },
      },
      required: ['term'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_meal_log',
    description:
      'Propose logging a meal the player says they already ate. Never a meal they plan, might have or want later, and never a weekly plan. The player confirms on a card.',
    parameters: {
      type: 'object',
      properties: {
        slot: slotSchema,
        when: { type: 'string', enum: ['today', 'yesterday'] },
        dish: { type: 'string', description: 'A game dish name, if it is one.' },
        servings: { type: 'number' },
        description: {
          type: 'string',
          description: 'What they ate, a short phrase copied exactly from their message (e.g. "half a sandwich"), when it is not a game dish.',
        },
      },
      required: ['when'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_profile',
    // M5 Step 8 fix round 5 (5b): every field is optional with one plain type, never a required nullable union. The
    // model had to write all five, each `anyOf [T, null]`, and the provider's parser leaked its own markup into the
    // nullable integer (`"meals_per_week": "null\n</parameter>\n<"`) and cut off the rest of the call.
    description:
      "Propose a change to the market days, meals a week, region or meal times. A meal reminder is a meal time ('remind me about dinner at 6:30 pm' is dinner at 18:30). Include only the fields the player mentioned; leave the others out.",
    parameters: {
      type: 'object',
      properties: {
        market_days: { type: 'array', items: { type: 'string' }, description: 'Weekday names.' },
        meals_per_week: { type: 'integer' },
        region: { type: 'string' },
        country: { type: 'string' },
        meal_windows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: slotSchema, start: { type: 'string', description: '24-hour HH:MM' } },
            required: ['name', 'start'],
            additionalProperties: false,
          },
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_pantry_change',
    description: "Propose adding or removing pantry items. 'Finished', 'ran out of', 'used up' and 'no X left' are removals.",
    parameters: {
      type: 'object',
      properties: {
        add: { type: 'array', items: { type: 'string', description: 'An item name copied exactly from the message, without amounts (e.g. "chickpeas").' } },
        remove: { type: 'array', items: { type: 'string', description: 'An item name copied exactly from the message (e.g. "milk").' } },
      },
      required: ['add', 'remove'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_plan',
    description:
      "Propose this week's plan when the player asks to plan their week, to put a dish on a day, or to pick dishes for them. The game matches the dish names and checks every dish against their rules; the player confirms on a card. Copy each dish name exactly as the player typed it (\"the dal\", \"onigiri\"), even if you don't know it; never add, choose or rename a dish yourself. For \"pick 3\" set pick and leave days out: the game picks. Leave out every field the player did not mention.",
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              weekday: { type: 'string', description: 'The weekday the player named, e.g. "Sunday".' },
              dish: { type: 'string', description: 'The dish exactly as the player typed it.' },
            },
            required: ['weekday', 'dish'],
            additionalProperties: false,
          },
        },
        pick: { type: 'integer', description: 'How many dishes the player asked the game to pick, 1 to 7.' },
        hard_week: { type: 'boolean', description: 'True only when the player said this week is hard, busy or rough.' },
        after: { type: 'string', description: 'A weekday the picks must come after ("after Saturday", "after market day" with their market day).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    // M6 Step 8 (Ruling 14): the player's own item words only. The game matches them to their open market list (the
    // prompt carries no list, C-13) and the player taps the card; nothing ticks by itself. Single-type fields (5b).
    name: 'propose_check_off',
    description:
      "Propose ticking items off the player's market list when they say what they picked up at the shops, and what the stalls had none of. Copy each item exactly as the player typed it; the game matches the items to their list and the player taps the card. Never add an item they did not name, and never for an allergy, a diet or something they must not eat.",
    parameters: {
      type: 'object',
      properties: {
        got: { type: 'array', items: { type: 'string', description: 'An item the player says they got, copied exactly from the message (e.g. "leeks").' } },
        missing: { type: 'array', items: { type: 'string', description: 'An item the player says the shop was out of, copied exactly from the message.' } },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_navigation',
    description:
      "Offer a button to a place in the game when the player asks to go there: the kitchen, the map, the week's plan, the market list, the recipe book, a cook's kitchen (to visit, id = the cook's id) or a recipe (to recipe, id = its slug). The player taps it; nothing moves by itself.",
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: [...NAV_TO] },
        id: { type: 'string', description: 'A cook id for visit, a recipe slug for recipe; left out otherwise.' },
      },
      required: ['to'],
      additionalProperties: false,
    },
  },
];

export type ToolArgs =
  | { name: 'propose_rule'; args: { term: string; severity: Severity | null } }
  | {
      name: 'propose_meal_log';
      args: { slot: MealSlot | null; when: 'today' | 'yesterday'; dish: string | null; servings: number | null; description: string | null };
    }
  | {
      name: 'propose_profile';
      args: {
        market_days: string[] | null;
        meals_per_week: number | null;
        region: string | null;
        country: string | null;
        meal_windows: { name: MealSlot; start: string }[] | null;
      };
    }
  | { name: 'propose_pantry_change'; args: { add: string[]; remove: string[] } }
  | {
      name: 'propose_plan';
      args: { days: { weekday: string; dish: string }[] | null; pick: number | null; hard_week: boolean | null; after: string | null };
    }
  | { name: 'propose_navigation'; args: { to: (typeof NAV_TO)[number]; id: string | null } }
  | { name: 'propose_check_off'; args: { got: string[]; missing: string[] } };

const text = (max: number) => z.string().trim().min(1).max(max);
/** A nullable field the model may also leave out. */
const opt = <T extends z.ZodType>(schema: T) => schema.nullable().default(null);

const ARGS = {
  propose_rule: z.object({ term: text(NAME_MAX), severity: opt(z.enum(SEVERITIES)) }).strict(),
  propose_meal_log: z
    .object({
      slot: opt(z.enum(MEAL_SLOTS as [MealSlot, ...MealSlot[]])),
      when: z.enum(['today', 'yesterday']).default('today'),
      dish: opt(text(NAME_MAX)),
      servings: opt(z.number().positive().max(20)),
      description: opt(text(200)),
    })
    .strict(),
  propose_profile: z
    .object({
      market_days: opt(z.array(text(20)).max(7)),
      meals_per_week: opt(z.number().int().min(0).max(42)),
      region: opt(text(NAME_MAX)),
      country: opt(text(NAME_MAX)),
      meal_windows: opt(
        z
          .array(z.object({ name: z.enum(MEAL_SLOTS as [MealSlot, ...MealSlot[]]), start: z.string().regex(HHMM) }).strict())
          .max(MEAL_SLOTS.length),
      ),
    })
    .strict(),
  propose_pantry_change: z
    .object({ add: z.array(text(NAME_MAX)).max(LIST_MAX).default([]), remove: z.array(text(NAME_MAX)).max(LIST_MAX).default([]) })
    .strict(),
  propose_plan: z
    .object({
      days: opt(z.array(z.object({ weekday: text(20), dish: text(NAME_MAX) }).strict()).max(PLAN_DAYS_MAX)),
      // Clamped to 1–7 by the post-check, never trusted as sent.
      pick: opt(z.number().int().min(-1000).max(1000)),
      hard_week: opt(z.boolean()),
      after: opt(text(20)),
    })
    .strict(),
  propose_navigation: z.object({ to: z.enum(NAV_TO), id: opt(text(200)) }).strict(),
  propose_check_off: z
    .object({ got: z.array(text(NAME_MAX)).max(CHECK_OFF_MAX).default([]), missing: z.array(text(NAME_MAX)).max(CHECK_OFF_MAX).default([]) })
    .strict(),
} as const;

/** The call's validated arguments, or null for an unknown tool, bad JSON or arguments that don't fit (zod-strict). */
export function parseToolCall(call: AiToolCall): ToolArgs | null {
  if (!Object.hasOwn(ARGS, call.name)) return null;
  const name = call.name as keyof typeof ARGS;
  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments);
  } catch {
    return null;
  }
  const parsed = ARGS[name].safeParse(raw);
  if (!parsed.success) return null;
  return { name, args: parsed.data } as ToolArgs;
}

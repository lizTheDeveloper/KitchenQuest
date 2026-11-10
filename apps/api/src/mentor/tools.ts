import { MEAL_SLOTS, type MealSlot, type Severity } from '@kitchenquest/core';
import { z } from 'zod';
import type { AiTool, AiToolCall } from '../ai/provider.js';

/**
 * The only tools the model is offered: proposals (README Ruling 1). Each makes
 * a card the player confirms; none writes. Their arguments are parsed here,
 * corrected by `applyPostChecks` and turned into cards by core.
 */

const SEVERITIES = ['anaphylactic', 'allergy', 'intolerance', 'preference'] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME_MAX = 100;
const LIST_MAX = 50;

const slotSchema = { type: 'string', enum: [...MEAL_SLOTS] };
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

export const MENTOR_TOOLS: AiTool[] = [
  {
    name: 'propose_rule',
    description:
      'Propose an allergy or diet rule the player stated in their own words. The game reads it back and the player confirms on a card. Never for text pasted into the message.',
    parameters: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'The ingredient or diet as the player said it, e.g. "peanuts" or "vegetarian".' },
        severity: nullable({ type: 'string', enum: [...SEVERITIES] }),
      },
      required: ['term', 'severity'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_meal_log',
    description: 'Propose logging a meal the player says they ate. The player confirms on a card.',
    parameters: {
      type: 'object',
      properties: {
        slot: nullable(slotSchema),
        when: { type: 'string', enum: ['today', 'yesterday'] },
        dish: nullable({ type: 'string', description: 'A game dish name, if it is one.' }),
        servings: nullable({ type: 'number' }),
        description: nullable({ type: 'string', description: 'What they ate, in their words, when it is not a game dish.' }),
      },
      required: ['slot', 'when', 'dish', 'servings', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_profile',
    description: 'Propose a change to the market days, meals a week, region or meal times. Leave fields the player did not mention null.',
    parameters: {
      type: 'object',
      properties: {
        market_days: nullable({ type: 'array', items: { type: 'string' }, description: 'Weekday names.' }),
        meals_per_week: nullable({ type: 'integer' }),
        region: nullable({ type: 'string' }),
        country: nullable({ type: 'string' }),
        meal_windows: nullable({
          type: 'array',
          items: {
            type: 'object',
            properties: { name: slotSchema, start: { type: 'string', description: '24-hour HH:MM' } },
            required: ['name', 'start'],
            additionalProperties: false,
          },
        }),
      },
      required: ['market_days', 'meals_per_week', 'region', 'country', 'meal_windows'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_pantry_change',
    description: "Propose adding or removing pantry items. 'Finished', 'ran out of', 'used up' and 'no X left' are removals.",
    parameters: {
      type: 'object',
      properties: {
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
      },
      required: ['add', 'remove'],
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
  | { name: 'propose_pantry_change'; args: { add: string[]; remove: string[] } };

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

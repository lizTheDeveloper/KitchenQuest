// M5 Step 8 fix round 5 (5b): the propose_profile schema defect. The eval's T13 runs got a malformed call,
// `{"market_days": null, "meals_per_week": "null\n</parameter>\n<"}`: the model had to write every field, each a
// nullable union (`anyOf: [T, null]`), and the provider's tool-call parser leaked its own markup into a nullable
// integer and cut off the rest. The fix: every profile field is optional, with one plain type, and is left out
// when the player didn't mention it.
import { describe, expect, test } from 'vitest';
import { normaliseToolArguments } from '../ai/openrouter.js';
import { MENTOR_TOOLS, parseToolCall } from './tools.js';

const profile = MENTOR_TOOLS.find((t) => t.name === 'propose_profile')!;
const params = profile.parameters as { properties: Record<string, Record<string, unknown>>; required?: string[] };

describe('propose_profile schema (5b)', () => {
  test('no field is required, and no field is a nullable union or a null type', () => {
    expect(params.required ?? []).toEqual([]);
    for (const [name, schema] of Object.entries(params.properties)) {
      expect(schema, name).not.toHaveProperty('anyOf');
      expect(schema, name).not.toHaveProperty('oneOf');
      expect(schema.type, name).toBeTypeOf('string');
      expect(schema.type, name).not.toBe('null');
    }
    expect(JSON.stringify(profile.parameters)).not.toMatch(/"null"/);
  });

  test('a call with only the fields the player mentioned parses, the rest null', () => {
    expect(parseToolCall({ id: 'c', name: 'propose_profile', arguments: JSON.stringify({ meal_windows: [{ name: 'dinner', start: '18:30' }] }) })).toEqual({
      name: 'propose_profile',
      args: { market_days: null, meals_per_week: null, region: null, country: null, meal_windows: [{ name: 'dinner', start: '18:30' }] },
    });
    expect(parseToolCall({ id: 'c', name: 'propose_profile', arguments: JSON.stringify({ market_days: ['Friday'] }) })?.args).toMatchObject({ market_days: ['Friday'] });
  });

  test('the leaked markup is still a malformed call, never used', () => {
    expect(parseToolCall({ id: 'c', name: 'propose_profile', arguments: JSON.stringify({ market_days: null, meals_per_week: 'null\n</parameter>\n<' }) })).toBeNull();
  });
});

describe('adjudication A: normalised provider artifacts, then the unchanged strict validation', () => {
  const params = MENTOR_TOOLS.find((t) => t.name === 'propose_profile')!.parameters;
  const parse = (args: object) => parseToolCall({ id: 'c', name: 'propose_profile', arguments: normaliseToolArguments(JSON.stringify(args), params) });

  test('the eval5 payload parses to the dinner window', () => {
    expect(parse({ meal_windows: '[{"name": "dinner", "start": "18:30"}]\n</parameter' })?.args).toMatchObject({ meal_windows: [{ name: 'dinner', start: '18:30' }] });
  });

  test('the eval4 payload is still rejected (an integer is never decoded)', () => {
    expect(parse({ market_days: null, meals_per_week: 'null\n</parameter>\n<' })).toBeNull();
  });

  test('a decoded value that fails the schema is rejected', () => {
    expect(parse({ meal_windows: '[{"name": "dinner", "start": "half six"}]\n</parameter>' })).toBeNull();
    expect(parse({ meal_windows: '{"name": "dinner"}\n</parameter>' })).toBeNull();
    expect(parse({ meal_windows: '[{"name": "dinner", "start": "18:30", "note": "x"}]</parameter>' })).toBeNull();
  });

  test('markup in the middle stays and is rejected', () => {
    expect(parse({ meal_windows: '[{"name": "dinner", "start": "18:30"}]</parameter> and more' })).toBeNull();
  });
});

// M5 final review m4: what 5b did for propose_profile, for every tool: no nullable union anywhere, and only the
// fields every call must carry are required (a missing optional field is read as null by zod `opt()`).
describe('every tool schema (m4)', () => {
  const unions = (node: unknown): string[] =>
    node && typeof node === 'object'
      ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => (k === 'anyOf' || k === 'oneOf' || (k === 'type' && (v === 'null' || Array.isArray(v))) ? [k] : unions(v)))
      : [];
  test.each(MENTOR_TOOLS.map((t) => [t.name, t] as const))('%s has no nullable union', (_name, tool) => {
    expect(unions(tool.parameters)).toEqual([]);
    expect(JSON.stringify(tool.parameters)).not.toMatch(/"null"/);
  });
  test('required fields are only the ones a call cannot go without', () => {
    const required = Object.fromEntries(MENTOR_TOOLS.map((t) => [t.name, (t.parameters as { required?: string[] }).required ?? []]));
    expect(required).toEqual({
      propose_rule: ['term'],
      propose_meal_log: ['when'],
      propose_profile: [],
      propose_pantry_change: ['add', 'remove'],
      propose_plan: [],
      propose_navigation: ['to'],
    });
  });
  test('a call with the optional fields left out parses, each as null', () => {
    expect(parseToolCall({ id: 'c', name: 'propose_plan', arguments: JSON.stringify({ pick: 2 }) })?.args).toEqual({ days: null, pick: 2, hard_week: null, after: null });
    expect(parseToolCall({ id: 'c', name: 'propose_rule', arguments: JSON.stringify({ term: 'sesame' }) })?.args).toEqual({ term: 'sesame', severity: null });
    expect(parseToolCall({ id: 'c', name: 'propose_meal_log', arguments: JSON.stringify({ when: 'today', description: 'soup' }) })?.args).toEqual({ slot: null, when: 'today', dish: null, servings: null, description: 'soup' });
    expect(parseToolCall({ id: 'c', name: 'propose_navigation', arguments: JSON.stringify({ to: 'market' }) })?.args).toEqual({ to: 'market', id: null });
  });
});

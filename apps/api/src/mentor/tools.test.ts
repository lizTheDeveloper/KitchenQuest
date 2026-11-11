// M5 Step 8 fix round 5 (5b): the propose_profile schema defect. The eval's T13 runs got a malformed call,
// `{"market_days": null, "meals_per_week": "null\n</parameter>\n<"}`: the model had to write every field, each a
// nullable union (`anyOf: [T, null]`), and the provider's tool-call parser leaked its own markup into a nullable
// integer and cut off the rest. The fix: every profile field is optional, with one plain type, and is left out
// when the player didn't mention it.
import { describe, expect, test } from 'vitest';
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

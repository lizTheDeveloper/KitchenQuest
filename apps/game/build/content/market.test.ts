// M6 Step 5: the market module's client shape, the strict stall checks on the real files, and the option-order pins.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { contentModule, marketModule, readPins } from '../content-plugin';
import { compileContent, ContentError } from './compile';
import { clientStall, compileMarket, optionPin, pinProblems, PINS_PATH, stallQuestions, updatedPins } from './market';
import { readContentFiles } from './read';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const files = readContentFiles(repoRoot);
const pins = readPins(repoRoot);
const content = compileContent(files, { pins });
const market = compileMarket(content);
const WEN = 'content/market/wen.yaml';
const BRAM = 'content/market/bram.yaml';

function problemsOf(mutated: Record<string, string>): string[] {
  try {
    compileContent(mutated, { pins });
  } catch (e) {
    expect(e).toBeInstanceOf(ContentError);
    return (e as ContentError).problems;
  }
  throw new Error('expected compileContent to throw');
}
/** The real files with one text replaced, exactly once. */
function withEdit(path: string, from: string, to: string): Record<string, string> {
  expect(files[path].split(from).length, `${path}: ${from}`).toBe(2);
  return { ...files, [path]: files[path].replace(from, to) };
}
const expectProblem = (problems: string[], ...needles: string[]) =>
  expect(problems.some((p) => needles.every((n) => p.includes(n))), problems.join('\n')).toBe(true);

describe('compileMarket (M6 Step 5)', () => {
  test('compileMarket strips persona and writer notes; keeps questions, variants, seasonal, item_tips, faq', () => {
    const json = JSON.stringify(market);
    expect(json).not.toMatch(/"persona"|"when"|"notes"/);
    for (const [id, s] of Object.entries(market.stalls)) {
      const src = content.stalls[id];
      expect(s).not.toHaveProperty('persona');
      expect(s.questions).toEqual(src.questions);
      expect(s.item_tips).toEqual(src.item_tips);
      expect(s.faq).toEqual(src.faq);
      expect(s.games).toEqual(src.games);
      expect({ id: s.id, name: s.name, stall: s.stall, art: s.art }).toEqual({ id: src.id, name: src.name, stall: src.stall, art: src.art });
      expect(Object.keys(s.triggers)).toEqual(Object.keys(src.triggers));
      for (const [t, trig] of Object.entries(s.triggers)) {
        const { when: _w, notes: _n, ...kept } = src.triggers[t];
        expect(trig).toEqual(kept);
      }
      // A keeper line's declared foods ship, so Step 9's keeperLines can check them (fix round 1, I1).
      expect(market.stalls.bram.triggers.idle.contains).toEqual({ '1': ['chuck'], '2': ['meat'] });
    }
    const pc = market.stalls.bram.variants?.protein_counter;
    expect(pc).toBeDefined();
    expect(pc).not.toHaveProperty('persona');
    expect(pc?.name).toBe("Big Bram's Protein Counter");
    expect(pc?.questions).toEqual(content.stalls.bram.variants?.protein_counter?.questions);
    expect(pc?.item_tips).toEqual(content.stalls.bram.variants?.protein_counter?.item_tips);
    expect(pc?.faq).toEqual(content.stalls.bram.variants?.protein_counter?.faq);
    expect(market.stalls.wen.seasonal).toEqual(content.stalls.wen.seasonal);
    expect(Object.keys(market.stalls.wen.seasonal?.['pnw-usa'] ?? {}).sort()).toEqual(['1', '11', '12', '2']);
    expect(market.seasonality).toEqual(content.seasonality);
    // Persona text never ships: not even as a substring.
    for (const s of Object.values(content.stalls)) for (const p of s.persona ?? []) expect(json.includes(p), p).toBe(false);
  });

  test('the version is 12 hex, stable, and changes with any stall or season text; key order does not move it', () => {
    expect(market.version).toMatch(/^[0-9a-f]{12}$/);
    expect(compileMarket(content).version).toBe(market.version);
    const wen = content.stalls.wen;
    const edited = { ...content, stalls: { ...content.stalls, wen: { ...wen, name: 'Old Wen.' } } };
    expect(compileMarket(edited).version).not.toBe(market.version);
    const season = { ...content, seasonality: { 'pnw-usa': { ...content.seasonality['pnw-usa'], name: 'PNW' } } };
    expect(compileMarket(season).version).not.toBe(market.version);
    const reordered = { ...content, stalls: { spice: content.stalls.spice, wen, bram: content.stalls.bram, 'okafor-sato': content.stalls['okafor-sato'] } };
    expect(compileMarket(reordered).version).toBe(market.version);
    // A missing stall is refused, never shipped partial.
    const { spice: _spice, ...three } = content.stalls;
    expect(() => compileMarket({ ...content, stalls: three })).toThrow(/spice/);
  });

  test('clientStall drops only persona and writer keys', () => {
    const s = clientStall(content.stalls['okafor-sato']);
    expect(Object.keys(s).sort()).toEqual(Object.keys(content.stalls['okafor-sato']).filter((k) => k !== 'persona').sort());
  });
});

describe('the strict stall checks on the real files (M6 Step 5)', () => {
  test('a stall file with an unknown key / a contains id not in the graph / two correct options → ContentError naming file and path', () => {
    // An unknown key at the top, on a question, and on an option.
    expectProblem(problemsOf(withEdit(WEN, '\ngames:\n', '\nmood: sunny\ngames:\n')), WEN, 'mood');
    expectProblem(problemsOf(withEdit(BRAM, '  - id: bram-braise-cut\n', '  - id: bram-braise-cut\n    contians: [beef]\n')), BRAM, 'questions.0', 'contians');
    // A contains id the graph doesn't have: never "no ingredient".
    expectProblem(problemsOf(withEdit(BRAM, '    contains: [beef]\n    options:\n      - text: "Chuck"', '    contains: [unobtainium]\n    options:\n      - text: "Chuck"')), BRAM, 'questions[0] (bram-braise-cut)', '"unobtainium" is not in the ingredient graph');
    // Two correct options.
    const firstWrong = files[BRAM].indexOf('correct: false');
    const two = { ...files, [BRAM]: `${files[BRAM].slice(0, firstWrong)}correct: true${files[BRAM].slice(firstWrong + 'correct: false'.length)}` };
    expectProblem(problemsOf(two), BRAM, 'questions[0] (bram-braise-cut)', '2 correct options, not exactly one');
  });

  test('a scope naming an unknown country, a currency symbol, scarcity wording in a season label, or chalkboard arithmetic that does not add up fail the build', () => {
    expectProblem(problemsOf({ ...files, [BRAM]: files[BRAM].replace('countries: ["United States"]', 'countries: ["Untied States"]') }), BRAM, 'countries[0] "Untied States" is not a known country name');
    expectProblem(problemsOf(withEdit(BRAM, '{ price: 22.50, servings: 6 }', '{ price: 22.50, servings: 5 }')), BRAM, '(bram-value-braise)', 'states 22.50 ÷ 6, but its chalkboard entry is 22.50 for 5');
    expectProblem(problemsOf(withEdit('data/seasonality.yaml', 'label: "In season here, now"', 'label: "In season, but not for long"')), 'data/seasonality.yaml', 'deadline or scarcity words');
    const reaction = /reaction: "([^"]*)"/.exec(files[WEN]);
    expectProblem(problemsOf(withEdit(WEN, reaction![0], `reaction: "${reaction![1]} Only 2€."`)), WEN, 'has a currency symbol (€)');
  });

  test('fix round 1, I3: the reviewer\'s chalkboard probes fail the build on the real files', () => {
    const probes: [string, string, string][] = [
      ['Chuck: 22.50 ÷ 6 = 3.75', 'Chuck: 24.00 ÷ 6 = 3.75', 'states 24.00 ÷ 6, but its chalkboard entry is 22.50 for 6'],
      ['Chuck: 22.50 ÷ 6 = 3.75', 'Chuck: 22.50 ÷ 6 ≈ 3.70', 'uses "≈"'],
      ['{ price: 22.50, servings: 6 }', '{ price: 22.49, servings: 6 }', 'chalkboard[0] 22.49 ÷ 6 is not exact to the cent'],
      ['chuck 22.50 for 6 servings', 'chuck 21.00 for 6 servings', 'prompt does not list chalkboard[0] (22.50 for 6) in order'],
      ['A treat, not a value. Chuck is 3.75.', 'A treat, not a value. Chuck is 3.50.', "states 3.50, which is no option's price per serving"],
      ['But lentils are 0.25."', 'But lentils are 0.30."', "states 0.30, which is no option's price per serving"],
    ];
    for (const [from, to, needle] of probes) expectProblem(problemsOf(withEdit(BRAM, from, to)), BRAM, needle);
    // M1: a currency symbol in a keeper line fails the build too.
    expectProblem(problemsOf(withEdit(BRAM, '      - "Price per pound lies;', '      - "Chuck is £4 today. Price per pound lies;')), BRAM, 'triggers.greet.lines[4] has a currency symbol (£)');
  });

  test('Wen seasonal disagreeing with data/seasonality.yaml → ContentError naming the question id', () => {
    // The table moves cranberry out of "now" in November; Wen's question still says it's in season.
    const moved = withEdit('data/seasonality.yaml', '      now: [cranberry]\n', '      now: []\n');
    moved['data/seasonality.yaml'] = moved['data/seasonality.yaml'].replace('      depends: [cilantro]\n', '      depends: [cilantro, cranberry]\n');
    const problems = problemsOf(moved);
    const q = (content.stalls.wen.seasonal?.['pnw-usa']['11'] ?? []).find((x) => x.contains?.[0] === 'cranberry');
    expect(q).toBeDefined();
    expectProblem(problems, WEN, q!.id, 'the table says');
  });

  test('the Pan and every stall keep the M6 safety and market triggers (the build requires them)', () => {
    expectProblem(problemsOf(withEdit('content/dialogue/pan.yaml', '  market.no_calendar:\n', '  market.no_calendar_x:\n')), 'pan.yaml', 'required trigger "market.no_calendar" is missing');
    expectProblem(problemsOf(withEdit(WEN, '  out_of_stock_none:\n', '  out_of_stock_nothing:\n')), WEN, 'triggers.out_of_stock_none: required trigger is missing');
  });
});

describe('the option-order pins (Ruling 2)', () => {
  test('every shipped question id is pinned, and the real files match their pins', () => {
    const all = Object.values(content.stalls).flatMap((s) => stallQuestions(s));
    expect(all.length).toBe(93);
    for (const { q } of all) expect(pins[q.id], q.id).toBe(optionPin(q));
    for (const s of Object.values(content.stalls)) expect(pinProblems(s, pins)).toEqual([]);
    // The committed file is what the pin script writes: sorted, no unknown or stale ids beyond the shipped ones.
    expect(JSON.parse(readFileSync(join(repoRoot, PINS_PATH), 'utf8'))).toEqual(updatedPins(Object.values(content.stalls), pins).pins);
  });

  test('an existing question with re-ordered options → fails with "give the question a new id"', () => {
    // Swap the first two options of a Bram question whose two option texts are each written once in the file.
    const once = (t: string) => files[BRAM].split(t).length === 2;
    const q = content.stalls.bram.questions.find((x) => once(`text: "${x.options[0].text}"`) && once(`text: "${x.options[1].text}"`))!;
    expect(q).toBeDefined();
    const [a, b] = q.options.map((o) => `text: "${o.text}"`);
    const swapped = files[BRAM].replace(a, '\u0000').replace(b, a).replace('\u0000', b);
    const problems = problemsOf({ ...files, [BRAM]: swapped });
    expectProblem(problems, BRAM, `(${q.id})`, 'give the question a new id');
    // A changed option text fails the same way; the same edit under a new id needs a pin, which only content:pin adds.
    expectProblem(problemsOf(withEdit(BRAM, a, a.replace(/"$/, '!"'))), `(${q.id})`, 'give the question a new id');
    expectProblem(problemsOf(withEdit(BRAM, `id: ${q.id}\n`, `id: ${q.id}-v2\n`)), `(${q.id}-v2)`, 'has no option-order pin', 'content:pin');
  });

  test('updatedPins adds new ids, keeps every pin, and re-pins a changed one only when asked', () => {
    const bram = content.stalls.bram;
    const q = bram.questions[0];
    const moved = { ...bram, questions: [{ ...q, options: [q.options[1], q.options[0], ...q.options.slice(2)] }, ...bram.questions.slice(1), { ...q, id: 'bram-new-q' }] };
    const out = updatedPins([moved], pins);
    expect(out.added).toEqual(['bram-new-q']);
    expect(out.changed).toEqual([q.id]);
    expect(out.pins[q.id]).toBe(pins[q.id]);
    const re = updatedPins([moved], pins, new Set([q.id]));
    expect(re.repinned).toEqual([q.id]);
    expect(re.pins[q.id]).toBe(optionPin(moved.questions[0]));
    // A removed question's pin stays: the id can't come back with other options.
    const fewer = updatedPins([{ ...bram, questions: bram.questions.slice(1) }], pins);
    expect(fewer.pins[q.id]).toBe(pins[q.id]);
  });
});

describe('the two modules (M6 Step 5)', () => {
  test('the client content module still has no stalls; virtual:kq-market has all four', () => {
    const client = contentModule(content);
    expect(client).not.toMatch(/"stalls"|"seasonality"/);
    expect(client.includes('Price per pound lies')).toBe(false);
    expect(client.includes('"fdcId"')).toBe(false);
    expect(client.includes('"source":"FDC')).toBe(false);
    // No writer persona card ships in first paint either: not the Pan's, not the cooks'.
    expect(client).not.toMatch(/"persona"/);
    for (const cook of Object.values(content.cooks)) for (const p of cook.persona ?? []) expect(client.includes(JSON.stringify(p).slice(1, -1)), p).toBe(false);
    // The client still names the stalls (C11).
    expect(client).toMatch(/"stallNames":\{/);
    const mod = marketModule(market);
    const parsed = JSON.parse(mod.slice('export default '.length, -1)) as typeof market;
    expect(Object.keys(parsed.stalls).sort()).toEqual(['bram', 'okafor-sato', 'spice', 'wen']);
    expect(Object.keys(parsed.seasonality)).toEqual(['pnw-usa']);
    expect(mod.includes(market.version)).toBe(true);
    // The marker the budget check looks for appears in no other module.
    expect(client.includes(market.version)).toBe(false);
  });

  test('the provenance strip keeps every field the device reads', () => {
    const client = JSON.parse(contentModule(content).slice('export default '.length, -1)) as { ingredients: { ingredients: Record<string, unknown>[] } };
    const before = content.ingredients.ingredients;
    expect(client.ingredients.ingredients).toHaveLength(before.length);
    client.ingredients.ingredients.forEach((n, i) => {
      const { source: _s, fdcId: _f, ...rest } = before[i] as unknown as Record<string, unknown>;
      expect(n).toEqual(rest);
    });
    expect(before.some((n) => (n as { fdcId?: number }).fdcId !== undefined)).toBe(true);
  });
});

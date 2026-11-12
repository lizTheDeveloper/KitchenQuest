// M6 Step 4: the shipped stall content, the Season's Table and the market graph nodes, checked with Steps 1–2's
// validators over the real files (node:fs and yaml, like quests-content.test.ts). Core's src/ is type-checked without
// Node's types, so this lives in test/.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { IngredientGraph, buildRuleCard, check, parseRecipe, validateRewards } from '../src/index';
import type { IngredientData, Rule, Substitution } from '../src/index';
import { textMentions } from '../src/ingredients/mentions';
import { faqFor, questionStatus, stallBank, stallVariant, tipFor } from '../src/market/bank';
import { isKnownCountry, normalizeCountry } from '../src/market/country';
import { seasonalAgrees, seasonalQuestions, seasonNote, seasonRegionFor, validateSeasonTable, type SeasonTable } from '../src/market/season';
import type { MarketCtx, StallFile, StallQuestion } from '../src/market/types';
import { validateStallFile } from '../src/market/validate';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const data = JSON.parse(read('data/ingredients.json')) as IngredientData;
const graph = IngredientGraph.fromData(data);
const subs = JSON.parse(read('data/substitutions.json')) as Substitution[];
const terms = JSON.parse(read('data/rule-terms.json')) as { name: string; ids: string[] }[];
const table = parse(read('data/seasonality.yaml')) as SeasonTable;
const STALL_IDS = ['wen', 'bram', 'okafor-sato', 'spice'] as const;
const stalls = Object.fromEntries(STALL_IDS.map((id) => [id, parse(read(`content/market/${id}.yaml`)) as StallFile])) as Record<(typeof STALL_IDS)[number], StallFile>;
const { wen, bram } = stalls;
const okaforSato = stalls['okafor-sato'];
const spice = stalls.spice;

/** The minigame shapes the stall files use (Step 5's build owns the list; these are the twelve shipped). */
const KNOWN_GAMES = new Set(['seasonal', 'ripeness', 'storage', 'cut_match', 'value', 'label', 'safety', 'tofu_match', 'legume_lore', 'blind_sniff', 'freshness', 'substitution']);

const DAY = '2026-11-12';
const rule = (ids: string[], severity: Rule['severity'] = 'allergy'): Rule => ({ id: `r-${ids.join('-')}`, target: { kind: 'category', ids }, type: 'avoid', severity });
const term = (name: string): Rule => ({ ...rule(terms.find((t) => t.name === name)!.ids, 'preference'), id: `t-${name}` });
const ctx = (rules: Rule[], country: string | null = null): MarketCtx => ({ rules, graph, subs, date: DAY, country });

/** Every question bank of a stall file: base, Protein Counter and seasonal. */
const allQuestions = (s: StallFile): StallQuestion[] => [
  ...s.questions,
  ...(s.variants?.protein_counter?.questions ?? []),
  ...Object.values(s.seasonal ?? {}).flatMap((months) => Object.values(months).flat()),
];
const questionTexts = (q: StallQuestion): string[] => [q.prompt, ...q.options.flatMap((o) => [o.text, o.reaction]), q.explain];
const everyQuestion = STALL_IDS.flatMap((id) => allQuestions(stalls[id]).map((q) => [id, q] as const));

describe('the stall files', () => {
  test('every content/market file passes validateStallFile against data/ingredients.json', () => {
    expect(readdirSync(join(ROOT, 'content/market')).filter((f) => f.endsWith('.yaml')).sort()).toEqual(['bram.yaml', 'okafor-sato.yaml', 'spice.yaml', 'wen.yaml']);
    for (const id of STALL_IDS) expect(validateStallFile(stalls[id], graph, { knownGames: KNOWN_GAMES }), id).toEqual([]);
  });

  test('every stall contains id resolves; tofu → soy; asafoetida → wheat (label-dependent); beef, chicken, lamb isA meat', () => {
    const ids = new Set(everyQuestion.flatMap(([, q]) => [...(q.contains ?? []), ...q.options.flatMap((o) => o.contains ?? [])]));
    expect(ids.size).toBe(47); // 48 before Step 4; the asafoetida question no longer lists wheat (the node carries it)
    for (const id of ids) expect(graph.has(id), id).toBe(true);
    expect(graph.pathTo('tofu', 'soy')).toEqual(['tofu', 'soy']);
    expect(graph.pathTo('asafoetida', 'wheat')).toEqual(['asafoetida', 'wheat']);
    expect(graph.get('asafoetida').labelDependent).toBe(true);
    for (const id of ['beef', 'chicken', 'lamb']) expect(graph.get(id).isA, id).toEqual(['meat']);
    // The asafoetida question names the node, which carries the wheat edge.
    expect(spice.questions.find((q) => q.id === 'spice-asafoetida')!.contains).toEqual(['asafoetida']);
  });

  test('a vegetarian rule makes bram protein_counter; a soy rule drops every tofu question; a coeliac rule drops asafoetida', () => {
    expect(stallVariant(bram, ctx([term('vegetarian')]))).toBe('protein_counter');
    expect(stallVariant(bram, ctx([term('vegan')]))).toBe('protein_counter');
    expect(stallVariant(bram, ctx([term('no pork')]))).toBe('base');
    // The Protein Counter is a full stall, not a lesser one: most of its bank reaches a vegetarian.
    const veg = stallBank(bram, ctx([term('vegetarian')]));
    expect(veg.questions.length).toBeGreaterThanOrEqual(8);
    expect(veg.questions.every((q) => q.id.startsWith('bram-pc-'))).toBe(true);
    // A soy rule: every question naming tofu (or tempeh, edamame, soy milk) is dropped, at both stalls.
    const soy = ctx([rule(['soy'])]);
    const tofuQs = everyQuestion.filter(([, q]) => (q.contains ?? []).includes('tofu'));
    expect(tofuQs.length).toBeGreaterThanOrEqual(8);
    for (const [, q] of tofuQs) expect(questionStatus(q, soy), q.id).toBe('blocked');
    for (const s of [okaforSato, bram]) for (const q of stallBank(s, ctx([term('vegetarian'), rule(['soy'])])).questions) expect(textMentions(questionTexts(q), graph).some((id) => graph.pathTo(id, 'soy') !== null), q.id).toBe(false);
    // A coeliac: the asafoetida question, tip and blend FAQ answer never show.
    const coeliac = ctx([{ ...term('coeliac'), severity: 'allergy' }]);
    expect(stallBank(spice, coeliac).questions.map((q) => q.id)).not.toContain('spice-asafoetida');
    expect(tipFor(spice, 'asafoetida', coeliac)).toBeNull();
    expect(faqFor(spice, coeliac).map((f) => f.a).join(' ')).not.toMatch(/asafoetida/i);
    // A vegetarian never meets Bram's beef braise; a vegan never meets an egg or milk question.
    expect(stallBank(bram, ctx([term('vegetarian')])).questions.map((q) => q.id)).not.toContain('bram-braise-cut');
    for (const q of stallBank(bram, ctx([term('vegan')])).questions) expect([...(q.contains ?? []), ...q.options.flatMap((o) => o.contains ?? [])], q.id).not.toEqual(expect.arrayContaining(['egg']));
  });

  test('no stall question text contains a currency symbol ($ £ € ¥ ₹ ₩ ₦ ₱ ¢); each chalkboard matches its reactions; the two price questions have one', () => {
    for (const [id, q] of everyQuestion) for (const t of questionTexts(q)) expect(t, `${id} ${q.id}`).not.toMatch(/[$£€¥₹₩₦₱¢]/);
    const boards = everyQuestion.filter(([, q]) => q.chalkboard !== undefined).map(([, q]) => q);
    expect(boards.map((q) => q.id).sort()).toEqual(['bram-pc-cheapest', 'bram-value-braise']);
    for (const q of boards) {
      const board = q.chalkboard!;
      expect(board).toHaveLength(q.options.length);
      const per = board.map((e) => e.price / e.servings);
      const c = q.options.findIndex((o) => o.correct);
      for (const [k, p] of per.entries()) if (k !== c) expect(per[c], q.id).toBeLessThan(p);
      // Exact arithmetic: every per-serving figure has at most two decimals, so no reaction needs "≈" (M6 carry M4).
      for (const p of per) expect(Math.abs(p * 100 - Math.round(p * 100)), q.id).toBeLessThan(1e-9);
      // Every number a reaction or the prompt cites is a chalkboard price, a serving count or a per-serving figure.
      const allowed = new Set([...board.flatMap((e) => [e.price, e.servings]), ...per].map((n) => n.toFixed(2)));
      for (const t of [q.prompt, ...q.options.map((o) => o.reaction)]) {
        expect(t, q.id).not.toMatch(/≈/);
        for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
          expect(allowed.has(Number(m[0]).toFixed(2)), `${q.id}: ${m[0]} in "${t}"`).toBe(true);
        }
      }
    }
    // The yield question compares no prices on a chalkboard; its example numbers carry no currency.
    const yieldQ = bram.variants!.protein_counter!.questions.find((q) => q.id === 'bram-pc-beans-yield')!;
    expect(yieldQ.chalkboard).toBeUndefined();
    expect(yieldQ.options[0].reaction).toContain('4 × 1.29 = 5.16');
    expect(bram.questions.find((q) => q.id === 'bram-chicken-temp')!.options[0].reaction).not.toMatch(/dollar|cent\b/i);
  });

  test('every agency-naming question has a countries scope; the US label and FSIS-figure questions are scoped', () => {
    const AGENCY = /\b(USDA|FSIS|FDA|FSA|FSS|FSAI|NHS|FSANZ|CFIA|EFSA|FSSAI)\b/i;
    for (const [id, q] of everyQuestion) if (questionTexts(q).some((t) => AGENCY.test(t))) expect(q.countries, `${id} ${q.id}`).toBeDefined();
    const scoped = everyQuestion.filter(([, q]) => q.countries !== undefined).map(([, q]) => q.id).sort();
    expect(scoped).toEqual(['bram-air-chilled', 'bram-grass-finished', 'bram-no-hormones', 'bram-use-by']);
    for (const id of scoped) expect(bram.questions.find((q) => q.id === id)!.countries!.map(normalizeCountry)).toEqual(['united states']);
    // A UK shopper and a player with no country never see them; a US one does. The temperature questions are physics.
    const ids = (country: string | null) => stallBank(bram, ctx([], country)).questions.map((q) => q.id);
    for (const c of ['UK', null]) for (const id of scoped) expect(ids(c), `${c} ${id}`).not.toContain(id);
    for (const id of scoped) expect(ids('USA')).toContain(id);
    for (const id of ['bram-chicken-temp', 'bram-whole-cut-temp']) expect(ids('UK')).toContain(id);
  });

  test('"smuggled" appears nowhere in content/', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    const files = walk(join(ROOT, 'content'));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/smuggl/i);
  });

  test('every FAQ answer that names an ingredient has an a_if_blocked, which names nothing the graph knows', () => {
    for (const id of STALL_IDS) {
      const s = stalls[id];
      for (const f of [...s.faq, ...(s.variants?.protein_counter?.faq ?? [])]) {
        if (f.a_if_blocked !== undefined) expect(textMentions([f.a_if_blocked], graph), `${id}: ${f.a_if_blocked}`).toEqual([]);
        if (textMentions([f.a], graph).length > 0) expect(f.a_if_blocked, `${id}: ${f.q[0]}`).toBeDefined();
      }
    }
    // Under a soy rule the tofu-is-gluten-free answer is replaced, never shown.
    expect(faqFor(okaforSato, ctx([rule(['wheat'])])).map((f) => f.a).join(' ')).not.toMatch(/soy sauce/);
  });

  test('every stall has out_of_stock_none (ai: never, 4 lines, {item}); every item tip is a graph node', () => {
    for (const id of STALL_IDS) {
      const t = stalls[id].triggers.out_of_stock_none;
      expect(t?.ai, id).toBe('never');
      expect(t.lines, id).toHaveLength(4);
      for (const l of t.lines) {
        expect(l, id).toContain('{item}');
        expect(l, id).not.toMatch(/\bbuy\b|[$£€¥₹₩₦₱¢]|\bonly\b|\bleft\b|\bhurry\b/i);
      }
      for (const tips of [stalls[id].item_tips, stalls[id].variants?.protein_counter?.item_tips ?? {}]) for (const k of Object.keys(tips)) expect(graph.has(k), `${id} ${k}`).toBe(true);
    }
    // The re-keyed tips (Step 4): the graph's own ids.
    expect(Object.keys(bram.variants!.protein_counter!.item_tips)).toEqual(expect.arrayContaining(['lentil', 'egg', 'chickpea', 'tofu', 'tempeh', 'seitan', 'paneer', 'greek_yogurt', 'edamame']));
    expect(Object.keys(okaforSato.item_tips)).toEqual(expect.arrayContaining(['bean', 'canned_bean', 'lentil']));
    expect(Object.keys(spice.item_tips)).toEqual(expect.arrayContaining(['dried_red_chili', 'mexican_oregano']));
    // A tip for a soy product never reaches a soy rule.
    for (const id of ['tofu', 'tempeh', 'edamame']) expect(tipFor(bram, id, ctx([term('vegetarian'), rule(['soy'])])), id).toBeNull();
    expect(tipFor(okaforSato, 'yuba', ctx([rule(['soy'])]))).toBeNull();
    expect(tipFor(bram, 'seitan', ctx([term('vegetarian'), { ...term('coeliac'), severity: 'allergy' }]))).toBeNull();
  });

  test('Wen keeps the seasonal question ids; option C is the table\'s "travelled" label; no fallback region', () => {
    const ids = allQuestions(wen).filter((q) => q.game === 'seasonal').map((q) => q.id);
    expect(ids).toHaveLength(17);
    expect(ids).toEqual(expect.arrayContaining(['wen-pnw-11-squash', 'wen-pnw-12-satsuma', 'wen-pnw-1-leek', 'wen-pnw-2-mushroom']));
    expect(Object.keys(wen.seasonal!)).toEqual(['pnw-usa']);
    expect(Object.keys(wen.seasonal!['pnw-usa']).sort()).toEqual(['1', '11', '12', '2']);
    expect(wen.games.seasonal).toMatch(/^Seasonal or well-travelled\?/);
    for (const q of allQuestions(wen).filter((x) => x.game === 'seasonal')) {
      expect(q.prompt, q.id).toMatch(/Seasonal or well-travelled\?$/);
      expect(q.options[2].text, q.id).toBe(table['pnw-usa'].categories.find((c) => c.id === 'travelled')!.label);
    }
  });
});

describe('data/seasonality.yaml (Ruling 9)', () => {
  test('passes validateSeasonTable; wen passes seasonalAgrees; no region other than pnw-usa', () => {
    expect(validateSeasonTable(table, graph)).toEqual([]);
    expect(seasonalAgrees(wen, table)).toEqual([]);
    expect(Object.keys(table)).toEqual(['pnw-usa']);
    const r = table['pnw-usa'];
    expect(r.status).toBe('draft');
    expect(r.categories.map((c) => [c.id, c.label])).toEqual([
      ['now', 'In season here, now'],
      ['stored', 'Local, stored from the autumn harvest'],
      ['travelled', 'Well-travelled: shipped in from far away'],
      ['depends', 'Depends: ask the farmer'],
    ]);
    expect(Object.keys(r.months).sort()).toEqual(['1', '11', '12', '2']);
    expect(r.parent).toBeUndefined();
  });

  test("the table lists each seasonal question's own ingredient id (Step 2 carry), not only an ancestor", () => {
    for (const [m, list] of Object.entries(wen.seasonal!['pnw-usa'])) {
      const entry = table['pnw-usa'].months[m as '1']!;
      for (const q of list) expect(Object.values(entry).flat(), `${m} ${q.id}`).toContain(q.contains![0]);
    }
  });

  test('region phrases never catch the wrong place: Washington DC, Portland ME and South Portland resolve to null (Step 2, I2)', () => {
    const at = (country: string | null, region: string | null) => seasonRegionFor({ country, region }, table);
    for (const region of ['Seattle', 'Seattle, WA', 'Washington State', 'western Washington', 'Portland, Oregon', 'Portland, OR', 'Eugene, Oregon', 'Pacific Northwest', 'PNW']) {
      expect(at('United States', region), region).toBe('pnw-usa');
      expect(at('USA', region), region).toBe('pnw-usa');
    }
    for (const region of ['Washington DC', 'Washington, D.C.', 'Portland ME', 'Portland, Maine', 'South Portland', 'Portland', 'Washington', 'Maine', null]) expect(at('United States', region), String(region)).toBeNull();
    // Another country's Portland or Washington never gets the Pacific Northwest calendar.
    for (const [country, region] of [['United Kingdom', 'Washington, Tyne and Wear'], ['Australia', 'Portland, Victoria'], ['Canada', 'Pacific Northwest'], [null, 'Seattle']] as const) expect(at(country, region), `${country} ${region}`).toBeNull();
    // Nowhere else has a table: Kerala, Oaxaca, Lagos and Melbourne get no calendar (Review Focus 3).
    for (const [country, region] of [['India', 'Kerala'], ['Mexico', 'Oaxaca'], ['Nigeria', 'Lagos'], ['Australia', 'Melbourne']]) expect(at(country, region)).toBeNull();
  });

  test("the season note shows only on an item the rules call ✅; a seasonal round for a strawberry allergy drops the strawberry", () => {
    const nov = { ...ctx([]), date: '2026-11-12' };
    expect(seasonNote('cranberry', 'pnw-usa', table, nov)).toMatchObject({ category: 'now', isNow: true });
    expect(seasonNote('strawberry', 'pnw-usa', table, nov)).toMatchObject({ category: 'travelled' });
    expect(seasonNote('strawberry', 'pnw-usa', table, { ...nov, rules: [rule(['strawberry'])] })).toBeNull();
    expect(seasonNote('cranberry', null, table, nov)).toBeNull();
    const seasonal = seasonalQuestions(wen, 'pnw-usa', 11, table);
    expect(seasonal.map((q) => q.id)).toContain('wen-pnw-11-strawberry');
    expect(stallBank(wen, ctx([rule(['strawberry'])]), seasonal).questions.map((q) => q.id)).not.toContain('wen-pnw-11-strawberry');
    // A berry allergy: no berry question, seasonal or not.
    for (const q of stallBank(wen, ctx([rule(['berry'])]), seasonal).questions) expect(q.contains ?? [], q.id).not.toEqual(expect.arrayContaining(['strawberry']));
  });
});

describe('rewards and stamps', () => {
  test('validateRewards(data/rewards.yaml) passes with market_game; stamp_names has market_game', () => {
    const rewards = parse(read('data/rewards.yaml')) as { xp: Record<string, number>; stamps: Record<string, number> };
    expect(validateRewards(rewards)).toEqual([]);
    expect(rewards.xp.market_game).toBe(5);
    expect(rewards.stamps.market_game).toBe(1);
    const forms = parse(read('content/bureau/forms.yaml')) as { stamp_names: Record<string, string>; forms: Record<string, { footnotes?: string[]; game?: Record<string, string> }> };
    expect(forms.stamp_names.market_game).toBeTruthy();
    // Ruling 5: Form 12-M shows no prices, so its footnote no longer says "Example prices"; Form 14-S carries it.
    expect(forms.forms.market_list.footnotes!.join(' ')).not.toMatch(/price/i);
    expect(forms.forms.stall_round.footnotes).toContain('*Example prices in no particular currency. Your shop will differ.');
    expect(forms.forms.stall_round.footnotes).toContain('*No stall keeper will sell you anything. They are teachers with tables.');
    expect(Object.keys(forms.forms.stall_round.game!).sort()).toEqual([...KNOWN_GAMES].sort());
    expect(forms.forms.stall_round.game!.seasonal).toBe('Seasonal or well-travelled?');
  });
});

/** The edges every node added in M6 Step 4 carries, pinned: a new edge or a lost one fails here and needs review. */
const NEW_NODE_EDGES: Record<string, { isA?: string[]; contains?: string[]; unsafeFor?: string[]; labelDependent?: true; broad?: true }> = {
  beef: { isA: ['meat'] }, chicken: { isA: ['meat'] }, lamb: { isA: ['meat'] },
  chuck: { isA: ['beef'] }, short_rib: { isA: ['beef'] }, shank: { isA: ['beef'] }, strip_steak: { isA: ['beef'] }, ribeye: { isA: ['beef'] }, flank_steak: { isA: ['beef'] }, brisket: { isA: ['beef'] }, ground_beef: { isA: ['beef'] },
  chicken_thigh: { isA: ['chicken'] }, chicken_breast: { isA: ['chicken'] }, whole_chicken: { isA: ['chicken'] },
  pork_shoulder: { isA: ['pork'] }, pork_tenderloin: { isA: ['pork'] }, pork_chop: { isA: ['pork'] }, lamb_shoulder: { isA: ['lamb'] },
  bean: { broad: true }, kidney_bean: { isA: ['bean'] }, chickpea: { isA: ['bean'] }, pea: { isA: ['bean'] }, canned_bean: { isA: ['bean'], labelDependent: true },
  lentil: { isA: ['bean'] }, red_lentil: { isA: ['lentil'] }, toor_dal: { isA: ['bean'] }, edamame: { isA: ['bean'], contains: ['soy'] },
  tofu: { contains: ['soy'] }, silken_tofu: { isA: ['tofu'] }, soft_tofu: { isA: ['tofu'] }, firm_tofu: { isA: ['tofu'] }, extra_firm_tofu: { isA: ['tofu'] }, tofu_puffs: { isA: ['tofu'] },
  yuba: { contains: ['soy'] }, tempeh: { contains: ['soy'], unsafeFor: ['wheat', 'gluten', 'barley'] }, miso: { contains: ['soy'], labelDependent: true }, seitan: { contains: ['wheat'], unsafeFor: ['soy'] }, paneer: { contains: ['milk'] }, greek_yogurt: { contains: ['milk'] },
  avocado: {}, apple: {}, pear: {}, banana: {}, berry: { broad: true }, strawberry: { isA: ['berry'] }, blueberry: { isA: ['berry'] }, cranberry: { isA: ['berry'] },
  carrot: {}, potato: {}, winter_squash: {}, zucchini: {}, kale: {}, leek: { isA: ['allium', 'fodmap_fructan'] }, green_onion: { isA: ['allium', 'fodmap_fructan'] }, mushroom: {}, lemon: {}, mandarin: {}, parsnip: {}, asparagus: {}, nettle: {},
  coriander: {}, cilantro: { isA: ['herb', 'coriander'] }, cabbage: {}, brussels_sprout: {}, ginger: {}, fennel: {}, chili: {},
  cumin: {}, coriander_seed: { isA: ['coriander'] }, cardamom: {}, cinnamon: {}, clove: {}, black_pepper: {}, paprika: { isA: ['chili'] }, fennel_seed: { isA: ['fennel'] }, star_anise: {}, nutmeg: {}, saffron: {}, bay_leaf: {}, oregano: {},
  butternut: { broad: true }, butternut_squash: { isA: ['winter_squash', 'butternut'] }, butternut_nut: { isA: ['tree_nut', 'butternut'] },
  mexican_oregano: { unsafeFor: ['oregano'] }, asafoetida: { contains: ['wheat'], labelDependent: true }, garam_masala: { labelDependent: true }, curry_powder: { labelDependent: true }, furikake: { contains: ['sesame', 'fish', 'soy', 'wheat'], labelDependent: true },
};

describe('the market graph nodes (data/ingredients.json, M6 Step 4)', () => {
  test("graph additions: no node gains an allergen edge its source field does not state (snapshot of new nodes' edges)", () => {
    for (const [id, want] of Object.entries(NEW_NODE_EDGES)) {
      const n = graph.get(id);
      const got = { isA: n.isA, contains: n.contains, unsafeFor: n.unsafeFor, labelDependent: n.labelDependent, broad: n.broad };
      expect(got, id).toEqual({ isA: want.isA, contains: want.contains, unsafeFor: want.unsafeFor, labelDependent: want.labelDependent, broad: want.broad });
      expect(typeof n.source, id).toBe('string');
    }
    expect(Object.keys(NEW_NODE_EDGES)).toHaveLength(88); // 85, plus the butternut ruling's three
    // The existing nodes Step 4 touched: only new isA edges (stricter), and cumin_seed's bare "cumin" moved to `cumin`.
    expect(graph.get('cumin_seed').isA).toEqual(['cumin']);
    expect(graph.resolve('cumin')).toBe('cumin');
    expect(graph.resolve('cumin seeds')).toBe('cumin_seed');
    expect(graph.get('green_chili').isA).toEqual(['chili']);
    expect(graph.get('dried_red_chili').isA).toEqual(['chili']);
    expect(graph.get('black_bean').isA).toEqual(['bean']);
    expect(graph.get('lupin_bean').isA).toEqual(['lupin', 'bean']);
    expect(graph.get('moong_dal').isA).toEqual(['bean']); // fix round 1, C2
  });

  test('every soy, wheat, milk, egg, sesame or fish product added from an item tip carries its edge (tempeh → soy, seitan → wheat, paneer → milk …); leek reaches fodmap_fructan; fennel_seed isA fennel', () => {
    const reaches: [string, string][] = [
      ['tempeh', 'soy'], ['miso', 'soy'], ['edamame', 'soy'], ['yuba', 'soy'], ['tofu', 'soy'], ['silken_tofu', 'soy'], ['soft_tofu', 'soy'], ['firm_tofu', 'soy'], ['extra_firm_tofu', 'soy'], ['tofu_puffs', 'soy'],
      ['seitan', 'wheat'], ['seitan', 'gluten'], ['asafoetida', 'wheat'], ['asafoetida', 'gluten'],
      ['paneer', 'milk'], ['greek_yogurt', 'milk'], ['furikake', 'sesame'], ['furikake', 'fish'],
      ['leek', 'fodmap_fructan'], ['green_onion', 'fodmap_fructan'], ['fennel_seed', 'fennel'],
    ];
    for (const [id, target] of reaches) expect(graph.pathTo(id, target), `${id} → ${target}`).not.toBeNull();
    const line = (id: string, rules: Rule[]) =>
      check(parseRecipe(`---\ntitle: T\ncountry: X\nregion: Y\ncredit: Z\ncook: Z\ndifficulty: 1\nskills: [stirring]\nservings: 1\nlicense: CC-BY-SA-4.0\nstatus: draft\n---\n\nAdd @${graph.get(id).name}{50%g}.\n`), rules, graph, subs, DAY).status;
    for (const [id, target] of reaches) expect(line(id, [rule([target])]), `${id} under ${target}`).not.toBe('ok');
    // Label-dependent blends are never ✅ under any restricting rule.
    for (const id of ['garam_masala', 'curry_powder', 'furikake', 'asafoetida']) expect(line(id, [rule(['celery'])]), id).toBe('unverified');
  });

  test('the curated stall swaps (Ruling 11) are graph ids, each with a note; a swap sharing a rule target lists it in unsafeFor', () => {
    const added = subs.filter((s) => ['shallot', 'green_chili', 'moong_dal'].includes(s.from));
    expect(added.map((s) => `${s.from}→${s.to}`)).toEqual(['shallot→onion', 'green_chili→dried_red_chili', 'moong_dal→red_lentil']);
    for (const s of added) {
      expect(graph.has(s.from) && graph.has(s.to), `${s.from}→${s.to}`).toBe(true);
      expect(s.note, s.from).toMatch(/^Stall swap: /);
    }
    expect(added.find((s) => s.from === 'shallot')!.unsafeFor).toEqual(['shallot']);
    expect(added.find((s) => s.from === 'green_chili')!.unsafeFor).toEqual(['green_chili']);
    expect(added.find((s) => s.from === 'moong_dal')!.unsafeFor).toEqual(['moong_dal']); // fix round 1, I1
    // No curated swap for curry leaves: the stall says out_of_stock_none.
    expect(subs.some((s) => s.from === 'curry_leaf' || s.from === 'curry_leaf_sprig')).toBe(false);
  });
});

describe('country names (Ruling 8, Step 1 carry: checked against ISO 3166-1)', () => {
  test('common short names and ISO 3166-1 "Name, qualifier" forms meet the one name', () => {
    const same: [string, string][] = [
      ['St Lucia', 'Saint Lucia'], ['St. Lucia', 'Saint Lucia'], ['Bosnia', 'Bosnia and Herzegovina'], ['St Kitts and Nevis', 'Saint Kitts and Nevis'],
      ['St Vincent', 'Saint Vincent and the Grenadines'], ['Trinidad', 'Trinidad and Tobago'], ['Antigua', 'Antigua and Barbuda'], ['São Tomé', 'Sao Tome and Principe'],
      ['Kyrgyz Republic', 'Kyrgyzstan'], ['Slovak Republic', 'Slovakia'], ['Macau', 'Macao'], ['Falklands', 'Falkland Islands'],
      ['Iran, Islamic Republic of', 'Iran'], ['Korea, Republic of', 'South Korea'], ["Korea, Democratic People's Republic of", 'North Korea'], ['Tanzania, United Republic of', 'Tanzania'],
      ['Venezuela, Bolivarian Republic of', 'Venezuela'], ['Bolivia, Plurinational State of', 'Bolivia'], ['Moldova, Republic of', 'Moldova'], ['Holy See (Vatican City State)', 'Vatican City'],
      ['Congo, The Democratic Republic of the', 'DR Congo'], ['Virgin Islands, U.S.', 'US Virgin Islands'], ["Lao People's Democratic Republic", 'Laos'],
    ];
    for (const [a, b] of same) {
      expect(normalizeCountry(a), a).toBe(normalizeCountry(b));
      expect(isKnownCountry(a), a).toBe(true);
    }
    // ISO 3166-1 territories are known names now; made-up places are not.
    for (const c of ['Aruba', 'Bermuda', 'Jersey', 'Isle of Man', 'Curaçao', 'Réunion', 'Western Sahara', 'Åland Islands', 'Kosovo']) expect(isKnownCountry(c), c).toBe(true);
    for (const c of ['Atlantis', 'Narnia', 'Washington DC', 'Portland']) expect(isKnownCountry(c), c).toBe(false);
  });
});

// Fix round 1, C1 (Step 1): every shipped question is over 500 characters once its texts are joined, so a scan that
// stops at 500 misses the explanation. Now on the real graph (Step 4 added the market nodes).
test('bram-thaw under "no pork": its explanation names meat (❓ under a partial rule), so it is never shown', () => {
  const thaw = bram.questions.find((q) => q.id === 'bram-thaw')!;
  expect(thaw.explain).toMatch(/^Thaw meat/);
  expect(questionTexts(thaw).join(' | ').length).toBeGreaterThan(500);
  expect(questionStatus(thaw, ctx([]))).toBe('ok');
  expect(questionStatus(thaw, ctx([term('no pork')]))).toBe('unverified');
  expect(stallBank({ ...bram, questions: [thaw] }, ctx([term('no pork')])).questions).toEqual([]);
});

describe('fix round 1 (review C1, C2, I1, I2; data check)', () => {
  const recipe = (lines: string[]) =>
    parseRecipe(`---\ntitle: T\ncountry: X\nregion: Y\ncredit: Z\ncook: Z\ndifficulty: 1\nskills: [stirring]\nservings: 1\nlicense: CC-BY-SA-4.0\nstatus: draft\n---\n\n${lines.map((l) => `Add @${l}{50%g}.`).join('\n')}\n`);
  const statusOf = (line: string, rules: Rule[]) => check(recipe([line]), rules, graph, subs, DAY).status;

  test('C1: the bare words resolve again, so textMentions sees them in stall text', () => {
    const bare: Record<string, string> = { paneer: 'paneer', oregano: 'oregano', clove: 'clove', cloves: 'clove', carrot: 'carrot', carrots: 'carrot', ginger: 'ginger', nettle: 'nettle', nettles: 'nettle', lentil: 'lentil', lentils: 'lentil', berries: 'berry', butternut: 'butternut' };
    for (const [word, id] of Object.entries(bare)) {
      expect(graph.resolve(word), word).toBe(id);
      expect(textMentions([`a little ${word} here`], graph), word).toContain(id);
    }
  });

  test("C1: the reviewer's four leaks are hidden under a rule on the bare-named item", () => {
    const q = (s: StallFile, id: string) => [...s.questions, ...(s.variants?.protein_counter?.questions ?? [])].find((x) => x.id === id)!;
    expect(questionStatus(q(bram, 'bram-pc-paneer'), ctx([term('vegetarian'), rule(['paneer'])]))).not.toBe('ok');
    expect(stallBank(bram, ctx([term('vegetarian'), rule(['paneer'])])).questions.map((x) => x.id)).not.toContain('bram-pc-paneer');
    expect(stallBank(spice, ctx([rule(['oregano'])])).questions.map((x) => x.id)).not.toContain('spice-chili-powder');
    expect(stallBank(spice, ctx([rule(['clove'])])).questions.map((x) => x.id)).not.toContain('spice-sniff-cumin');
    const ugly = faqFor(wen, ctx([rule(['carrot'])])).find((f) => f.q === 'is ugly produce ok');
    expect(ugly?.a ?? '').not.toMatch(/carrot/i);
    // With no rule, each is shown as before.
    expect(stallBank(spice, ctx([])).questions.map((x) => x.id)).toEqual(expect.arrayContaining(['spice-chili-powder', 'spice-sniff-cumin']));
  });

  test('C1: every stall question, tip or FAQ answer that names a graph item is caught: for each item it names, a rule on it hides it', () => {
    for (const id of STALL_IDS) {
      const s = stalls[id];
      for (const q of allQuestions(s)) {
        for (const named of textMentions(questionTexts(q), graph)) {
          const rules = s.variants?.protein_counter?.questions.includes(q) ? [term('vegetarian'), rule([named])] : [rule([named])];
          expect(questionStatus(q, ctx(rules)), `${q.id} names ${named}`).not.toBe('ok');
        }
      }
      for (const f of [...s.faq, ...(s.variants?.protein_counter?.faq ?? [])]) {
        for (const named of textMentions([f.a], graph)) expect(f.a_if_blocked, `${id} "${f.q[0]}" names ${named}`).toBeDefined();
      }
    }
  });

  test('C2: every dal, pulse and bean node is filed under bean, so a "beans" line is never ✅ under a rule on one', () => {
    const pulses = graph.labels().filter((l) => /\b(beans?|dal|lentils?|peas?|chickpeas?|edamame|lupini)\b/.test(l)).map((l) => graph.resolve(l)!);
    for (const id of new Set(pulses)) {
      // "bean curd" (tofu) and "bean curd skin" (yuba) are soy-milk products, not pulses; they reach soy instead.
      if (id === 'bean' || graph.pathTo(id, 'tofu') !== null || id === 'yuba') continue;
      expect(graph.pathTo(id, 'bean'), id).not.toBeNull();
    }
    for (const id of ['moong_dal', 'toor_dal', 'red_lentil', 'lentil']) {
      expect(statusOf('beans', [rule([id], 'anaphylactic')]), id).not.toBe('ok');
      expect(stallBank(okaforSato, ctx([rule([id], 'anaphylactic')])).questions.map((x) => x.id), id).not.toContain('os-foam');
      expect(tipFor(okaforSato, 'bean', ctx([rule([id], 'anaphylactic')])), id).toBeNull();
    }
  });

  test('I1: parippu stays ⛔ under a moong-dal rule (the red-lentil swap is a stall swap only)', () => {
    expect(statusOf('split moong dal', [rule(['moong_dal'], 'anaphylactic')])).toBe('blocked');
    expect(statusOf('moong dal', [rule(['moong_dal'], 'preference')])).toBe('blocked');
  });

  test('I2: Form 9-Q matches Ruling 1 and shows no score', () => {
    const forms = parse(read('content/bureau/forms.yaml')) as { forms: Record<string, { purpose: string; fields: { key: string }[]; footnotes: string[] }> };
    const f = forms.forms.practice_log;
    expect(f.fields.map((x) => x.key)).not.toContain('score');
    expect(f.footnotes.join(' ')).toMatch(/stamp a week for any round played through/);
    expect(f.footnotes.join(' ')).toMatch(/5 XP the first time each question is answered correctly/);
    expect(f.footnotes.join(' ')).not.toMatch(/not stamps|first completions|rationed/);
    expect(f.purpose).toMatch(/ISO week/);
  });

  test('data check: grain tempeh (wheat, gluten, barley) and furikake (soy, wheat)', () => {
    for (const t of ['wheat', 'gluten', 'barley']) expect(statusOf('tempeh', [term('vegetarian'), rule([t])]), t).toBe('blocked');
    expect(statusOf('tempeh', [rule(['rice'])])).toBe('ok'); // not label-dependent: tempeh still reaches other rule-holders
    for (const t of ['soy', 'wheat', 'gluten', 'sesame', 'fish']) expect(statusOf('furikake', [rule([t])]), t).toBe('blocked');
  });
});

describe('butternut is ambiguous: the squash or the tree nut (binding ruling, fix round 1)', () => {
  const recipe = (line: string) =>
    parseRecipe(`---\ntitle: T\ncountry: X\nregion: Y\ncredit: Z\ncook: Z\ndifficulty: 1\nskills: [stirring]\nservings: 1\nlicense: CC-BY-SA-4.0\nstatus: draft\n---\n\nAdd @${line}{50%g}.\n`);
  const statusOf = (line: string, rules: Rule[]) => check(recipe(line), rules, graph, subs, DAY).status;
  const TREE_NUT = rule(['tree_nut'], 'anaphylactic');

  test('"allergic to butternuts" offers a choice (squash or tree nut) through the which-kind card, never a squash-only card', () => {
    for (const term of ['butternut', 'butternuts', 'Butternuts']) {
      const r = buildRuleCard({ term, severity: 'anaphylactic' }, graph, terms as never);
      expect(r.ok, term).toBe(false);
      if (r.ok) continue;
      expect(r.reason, term).toBe('ambiguous');
      if (r.reason === 'ambiguous') expect(r.options.map((o) => o.id).sort(), term).toEqual(['butternut_nut', 'butternut_squash']);
    }
    // The nut choice takes the tree-nut path.
    expect(graph.pathTo('butternut_nut', 'tree_nut')).toEqual(['butternut_nut', 'tree_nut']);
  });

  test('a stall line or recipe line naming a bare "butternut" is hidden under a tree-nut rule (read as both, the worst case)', () => {
    expect(statusOf('butternut', [TREE_NUT])).not.toBe('ok');
    expect(statusOf('butternuts', [TREE_NUT])).not.toBe('ok');
    const q = { ...wen.questions[0], id: 't-butternut', contains: [], prompt: 'Wen holds up a butternut. Which one is ready?' } as StallQuestion;
    expect(questionStatus(q, ctx([TREE_NUT]))).not.toBe('ok');
    expect(questionStatus(q, ctx([]))).toBe('ok');
  });

  test('"butternut squash" stays unambiguous: the squash, not blocked under a tree-nut rule', () => {
    expect(graph.resolve('butternut squash')).toBe('butternut_squash');
    expect(graph.pathTo('butternut_squash', 'winter_squash')).not.toBeNull();
    expect(statusOf('butternut squash', [TREE_NUT])).toBe('ok');
    const card = buildRuleCard({ term: 'butternut squash', severity: 'allergy' }, graph, terms as never);
    expect(card.ok && card.card.rule.target.ids).toEqual(['butternut_squash']);
  });
});

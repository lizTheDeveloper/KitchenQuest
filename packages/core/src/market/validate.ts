// The build's and the API's check of a stall file (M6 Step 1; Step 5's compile and Step 6's boot refuse on any
// problem). Never throws. Each problem names the stall, the key path and, for a question, its id.
import type { IngredientGraph } from '../ingredients/graph';
import { isKnownCountry } from './country';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Ruling 8: a question naming one of these agencies teaches one country's rule, so it needs a `countries:` scope. Any
 * case, abbreviated or written out (fix round 1, M5: FSS and FSAI too).
 */
const AGENCY = new RegExp(
  String.raw`\b(USDA|FSIS|FDA|FSA|FSS|FSAI|NHS|FSANZ|CFIA|EFSA|FSSAI|` +
    [
      'United States Department of Agriculture',
      'Food Safety and Inspection Service',
      'Food and Drug Administration',
      'Food Standards Agency',
      'Food Standards Scotland',
      'Food Safety Authority of Ireland',
      'National Health Service',
      'Food Standards Australia New Zealand',
      'Canadian Food Inspection Agency',
      'European Food Safety Authority',
      'Food Safety and Standards Authority of India',
    ]
      .map((n) => n.replace(/ /g, String.raw`\s+`))
      .join('|') +
    String.raw`)\b`,
  'i',
);
/** Ruling 5: chalkboard prices are example numbers in no particular currency. */
const CURRENCY = /[$£€¥₹₩₦₱¢]/;
/** Ruling 5: a per-serving figure a reaction states ("÷ 6 = 3.75"). */
const PER_SERVING = /=\s*(\d+(?:\.\d+)?)/g;
/**
 * Ruling 5: text that states a price: a number beside "chalkboard" (within four words), a number "a serving", or a
 * number for a pack ("1.79 a bag", "22.50 for 6 servings"). Weights and yields ("per 100 g", "one pound") are not prices.
 */
const PRICE_TEXT: readonly RegExp[] = [
  /\bchalkboard\b\W+(?:[\p{L}'-]+\W+){0,4}?\d/iu,
  /\d\W+(?:[\p{L}'-]+\W+){0,4}?chalkboard\b/iu,
  /\d+(?:[.,]\d+)?\s*[$£€¥₹₩₦₱¢]?\s*(?:a|per|each)\s+serving/i,
  /\d+(?:[.,]\d+)?\s*(?:a|per|each)\s+(?:bag|block|pack|packet|dozen|tin|can|jar|box|bottle|bunch|tub|carton|loaf)\b/i,
  /\d+(?:[.,]\d+)?\s+for\s+\d+\s+servings?\b/i,
];
const VARIANT_KEYS = new Set(['protein_counter']);

/** A question's displayed texts, each with the key path it came from. */
function questionTexts(q: Record<string, unknown>): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  if (typeof q.prompt === 'string') out.push({ at: 'prompt', text: q.prompt });
  if (Array.isArray(q.options)) {
    q.options.forEach((o: unknown, k: number) => {
      if (!isObject(o)) return;
      if (typeof o.text === 'string') out.push({ at: `options[${k}].text`, text: o.text });
      if (typeof o.reaction === 'string') out.push({ at: `options[${k}].reaction`, text: o.reaction });
    });
  }
  if (typeof q.explain === 'string') out.push({ at: 'explain', text: q.explain });
  return out;
}

const round2 = (n: number): string => (Math.round(n * 100 + 1e-9) / 100).toFixed(2);

/**
 * Every problem with a stall file:
 * - not exactly one `correct: true`, or not 3–4 options;
 * - a `contains` id (question or option level) missing from the graph;
 * - an unknown `game` for the stall (the file's own `games:` keys, each of which must be in `knownGames`);
 * - an `item_tips` key not in the graph;
 * - a duplicate question id across `questions`, `variants.*.questions` and `seasonal.*.*`;
 * - a question naming an agency (any case, abbreviated or in full) with no `countries`, or a scope naming an
 *   unknown country (Ruling 8);
 * - Ruling 5's chalkboard arithmetic, a value question stating a price without a chalkboard, and a currency symbol in
 *   any question text;
 * - a `faq` entry with an empty `q`;
 * - and the shape around them (a missing list, a field of the wrong type), so nothing downstream reads a hole.
 */
export function validateStallFile(d: unknown, graph: IngredientGraph, opts: { knownGames: ReadonlySet<string> }): string[] {
  if (!isObject(d)) return ['stall: not an object'];
  const S = isText(d.id) ? d.id : 'stall';
  const problems: string[] = [];
  const say = (msg: string) => problems.push(`${S}: ${msg}`);
  if (!isText(d.id)) say('id is not a non-empty string');
  if (!isText(d.name)) say('name is not a non-empty string');
  if (!isObject(d.triggers)) say('triggers is not a map');

  const games = new Set<string>();
  if (!isObject(d.games)) say('games is not a map');
  else {
    for (const [key, desc] of Object.entries(d.games)) {
      if (!opts.knownGames.has(key)) say(`games.${key}: not a known game`);
      else games.add(key);
      if (!isText(desc)) say(`games.${key}: description is not a non-empty string`);
    }
  }

  // Every question bank in the file, with its key path.
  const banks: { at: string; list: unknown }[] = [{ at: 'questions', list: d.questions }];
  const tipMaps: { at: string; tips: unknown }[] = [{ at: 'item_tips', tips: d.item_tips }];
  const faqs: { at: string; faq: unknown }[] = [{ at: 'faq', faq: d.faq }];
  if (d.variants !== undefined) {
    if (!isObject(d.variants)) say('variants is not a map');
    else {
      for (const [key, v] of Object.entries(d.variants)) {
        const at = `variants.${key}`;
        if (!VARIANT_KEYS.has(key)) say(`${at}: not a known variant`);
        if (!isObject(v)) {
          say(`${at}: not a map`);
          continue;
        }
        if (!isObject(v.triggers)) say(`${at}.triggers is not a map`);
        banks.push({ at: `${at}.questions`, list: v.questions });
        tipMaps.push({ at: `${at}.item_tips`, tips: v.item_tips });
        faqs.push({ at: `${at}.faq`, faq: v.faq });
      }
    }
  }
  if (d.seasonal !== undefined) {
    if (!isObject(d.seasonal)) say('seasonal is not a map');
    else {
      for (const [region, months] of Object.entries(d.seasonal)) {
        if (!isObject(months)) {
          say(`seasonal.${region}: not a map of months`);
          continue;
        }
        for (const [month, list] of Object.entries(months)) {
          const m = Number(month);
          if (!/^\d{1,2}$/.test(month) || m < 1 || m > 12) say(`seasonal.${region}.${month}: not a month 1–12`);
          else banks.push({ at: `seasonal.${region}.${month}`, list });
        }
      }
    }
  }

  const seen = new Map<string, string>();
  for (const { at, list } of banks) {
    if (!Array.isArray(list)) {
      say(`${at}: not a list of questions`);
      continue;
    }
    list.forEach((q: unknown, i: number) => {
      const path = `${at}[${i}]`;
      if (!isObject(q)) return say(`${path}: not an object`);
      const id = isText(q.id) ? q.id : null;
      const where = id === null ? path : `${path} (${id})`;
      const bad = (msg: string) => say(`${where}: ${msg}`);
      if (id === null) bad('id is not a non-empty string');
      else if (seen.has(id)) bad(`duplicate question id, also at ${seen.get(id)}`);
      else seen.set(id, path);
      if (!isText(q.prompt)) bad('prompt is not a non-empty string');
      if (!isText(q.explain)) bad('explain is not a non-empty string');
      if (typeof q.game !== 'string' || !games.has(q.game)) bad(`game ${JSON.stringify(q.game)} is not one of this stall's games`);

      const checkContains = (v: unknown, key: string) => {
        if (v === undefined) return;
        if (!Array.isArray(v)) return bad(`${key} is not a list`);
        for (const c of v) if (typeof c !== 'string' || !graph.has(c)) bad(`${key} "${String(c)}" is not in the ingredient graph`);
      };
      checkContains(q.contains, 'contains');

      const options = Array.isArray(q.options) ? q.options : null;
      if (options === null) bad('options is not a list');
      else {
        if (options.length < 3 || options.length > 4) bad(`has ${options.length} options, not 3–4`);
        let correct = 0;
        options.forEach((o: unknown, k: number) => {
          if (!isObject(o)) return bad(`options[${k}]: not an object`);
          if (!isText(o.text)) bad(`options[${k}].text is not a non-empty string`);
          if (!isText(o.reaction)) bad(`options[${k}].reaction is not a non-empty string`);
          if (typeof o.correct !== 'boolean') bad(`options[${k}].correct is not true or false`);
          if (o.correct === true) correct++;
          checkContains(o.contains, `options[${k}].contains`);
        });
        if (correct !== 1) bad(`has ${correct} correct options, not exactly one`);
      }

      const texts = questionTexts(q);
      if (q.countries !== undefined && (!Array.isArray(q.countries) || q.countries.length === 0 || !q.countries.every(isText))) {
        bad('countries is not a non-empty list of country names');
      } else if (Array.isArray(q.countries)) {
        // Fix round 1, M6: a misspelt name would scope the question to nobody, silently.
        q.countries.forEach((c: unknown, k: number) => {
          if (!isKnownCountry(c as string)) bad(`countries[${k}] ${JSON.stringify(c)} is not a known country name`);
        });
      }
      const agency = texts.find((t) => AGENCY.test(t.text));
      if (agency !== undefined && q.countries === undefined) bad(`${agency.at} names ${AGENCY.exec(agency.text)![1]} but has no countries scope`);
      for (const t of texts) if (CURRENCY.test(t.text)) bad(`${t.at} has a currency symbol (${CURRENCY.exec(t.text)![0]}); chalkboard prices name no currency`);

      if (q.chalkboard !== undefined) {
        const board = q.chalkboard;
        if (q.game !== 'value') bad('has a chalkboard but is not a value question');
        if (!Array.isArray(board) || options === null || board.length !== options.length) bad('chalkboard needs one entry per option');
        else {
          const per: (number | null)[] = board.map((e: unknown, k: number) => {
            const ok = isObject(e) && typeof e.price === 'number' && Number.isFinite(e.price) && e.price > 0 && typeof e.servings === 'number' && Number.isFinite(e.servings) && e.servings > 0;
            if (!ok) {
              bad(`chalkboard[${k}] is not { price, servings } with positive numbers`);
              return null;
            }
            return (e.price as number) / (e.servings as number);
          });
          const c = options.findIndex((o: unknown) => isObject(o) && o.correct === true);
          if (c >= 0 && per.every((p) => p !== null)) {
            const nums = per; // every() narrowed it to number[]
            if (nums.some((p, k) => k !== c && !(nums[c] < p))) bad(`options[${c}] is correct but is not the strict cheapest per serving`);
            options.forEach((o: unknown, k: number) => {
              if (!isObject(o) || typeof o.reaction !== 'string') return;
              for (const m of o.reaction.matchAll(PER_SERVING)) {
                if (Number(m[1]).toFixed(2) !== round2(nums[k])) bad(`options[${k}].reaction states = ${m[1]} but its chalkboard entry gives ${round2(nums[k])} a serving`);
              }
            });
          }
        }
      } else if (q.game === 'value') {
        const priced = texts.find((t) => PRICE_TEXT.some((re) => re.test(t.text)));
        if (priced !== undefined) bad(`${priced.at} states a price but the question has no chalkboard`);
      }
    });
  }

  for (const { at, tips } of tipMaps) {
    if (!isObject(tips)) {
      say(`${at}: not a map`);
      continue;
    }
    for (const [key, tip] of Object.entries(tips)) {
      if (!graph.has(key)) say(`${at}.${key}: not in the ingredient graph`);
      if (!isObject(tip) || !isText(tip.pick) || !isText(tip.store)) say(`${at}.${key}: not { pick, store } text`);
    }
  }

  for (const { at, faq } of faqs) {
    if (!Array.isArray(faq)) {
      say(`${at}: not a list`);
      continue;
    }
    faq.forEach((f: unknown, i: number) => {
      const path = `${at}[${i}]`;
      if (!isObject(f)) return say(`${path}: not an object`);
      if (!Array.isArray(f.q) || f.q.length === 0 || !f.q.every(isText)) say(`${path}.q is empty: it needs at least one non-empty question`);
      if (!isText(f.a)) say(`${path}.a is not a non-empty string`);
      if (f.a_if_blocked !== undefined && !isText(f.a_if_blocked)) say(`${path}.a_if_blocked is not a non-empty string`);
    });
  }
  return problems;
}

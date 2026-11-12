// The voice scan (M5 Step 4, Ruling 24, C29): every line, form and frame the client bundle carries (ClientContent)
// against voice §7's banned words and the never rules. M6 Step 5: the market module (MarketContent) too: every stall
// line, prompt, option, reaction, explanation, tip, FAQ chip and answer, keeper greet/idle/farewell line, the Protein
// Counter's content and The Season's Table's labels. No pattern is weakened: a legitimate teaching line a pattern
// catches is listed, by file, key path and exact text, in VOICE_ALLOWLIST, and an edited line fails again.
import { stepPlainText } from '@kitchenquest/core/engine';
import { describe, expect, it } from 'vitest';
import { loadMarket } from '../market/content';
import { content } from './index';
import type { ClientContent, MarketContent } from './types';
import { VOICE_ALLOWLIST } from './voice-allowlist';

/** One scanned string: where it comes from (file, path) and which line kinds it belongs to. */
interface Scanned {
  file: string;
  where: string;
  text: string;
  /**
   * 'nourishment' (meal logging, Ruling 5), 'rescue' (Use-It-Up), 'frame' (Pantry Frames), 'okafor' (names Okafor-Sato,
   * or is in Okafor-Sato's own file), 'stall' (a market stall file or The Season's Table, M6 Step 5).
   */
  kinds: ReadonlySet<string>;
}

const PAN = 'content/dialogue/pan.yaml';
const BUREAU = 'content/bureau/forms.yaml';

/** Nourishment lines (Ruling 5's daily nourishment and the meal log); rescue and frame lines (audit M-4, M-14). */
function kindsOf(triggerId: string): string[] {
  const k: string[] = [];
  if (/^(log|cooked_for)\./.test(triggerId) || triggerId === 'cook.who_ate') k.push('nourishment');
  if (/^rescue\./.test(triggerId) || triggerId === 'reminder.use_it_up') k.push('rescue');
  if (/^frame\./.test(triggerId)) k.push('frame');
  // M5 final I4: the intake interview and the pantry's lines, where a near-empty cupboard is most likely to come up.
  if (/^(intake|pantry|reminder\.use_it_up)\b/.test(triggerId)) k.push('pantry');
  return k;
}

/** Every string in a tree, with its path. */
function strings(node: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof node === 'string') out.push([path, node]);
  else if (Array.isArray(node)) node.forEach((n, i) => strings(n, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) strings(v, path === '' ? k : `${path}.${k}`, out);
  return out;
}

/** A scanned string; a line naming Okafor-Sato is also of kind 'okafor' (voice §0.11). */
const scanned = (file: string, where: string, text: string, kinds: readonly string[] = []): Scanned => ({
  file,
  where,
  text,
  kinds: new Set([...kinds, ...(/Okafor-Sato/.test(text) ? ['okafor'] : []), ...(CUPBOARD.test(text) ? ['cupboard'] : [])]),
});

/** What the client bundle shows: lines, forms, frames, recipes' words and the names of things. */
function collect(c: ClientContent): Scanned[] {
  const out: Scanned[] = [];
  const add = (file: string, where: string, text: string, kinds: string[] = []): void => void out.push(scanned(file, where, text, kinds));
  // (No persona cards: they never ship to the client, M6 Step 5; the server's prompt is checked by the API's own tests.)
  for (const [id, t] of Object.entries(c.pan.triggers)) t.lines.forEach((l, i) => add(PAN, `triggers.${id}[${i}]`, l, kindsOf(id)));
  for (const [id, cook] of Object.entries(c.cooks)) for (const [where, text] of strings(cook, '')) add(`content/cooks/${id}.yaml`, where, text);
  for (const [where, text] of strings(c.bureau, '')) add(BUREAU, where, text);
  for (const f of c.frames) {
    const file = `content/frames/${f.id}.yaml`;
    add(file, 'title', f.title, ['frame']);
    add(file, 'credit', f.credit, ['frame']);
    f.steps.forEach((s, i) => add(file, `steps[${i}]`, s, ['frame']));
  }
  for (const [slug, r] of Object.entries(c.recipes)) {
    const file = `recipes/${slug}.cook`;
    add(file, 'title', r.meta.title);
    // What the ingredient list shows: each line's display name and its note (fix round 1, M6).
    r.ingredients.forEach((l, i) => {
      if (l.displayName !== null) add(file, `ingredients[${i}].displayName`, l.displayName);
      if (l.note !== null) add(file, `ingredients[${i}].note`, l.note);
    });
    r.steps.forEach((s, i) => add(file, `steps[${i}]`, stepPlainText(r, s)));
  }
  for (const t of c.techniques.techniques) add('data/techniques.yaml', t.id, t.name);
  c.rewards.trust.names.forEach((n, i) => add('data/rewards.yaml', `trust.names[${i}]`, n));
  for (const [id, n] of Object.entries(c.stallNames)) add(id === 'general' ? BUREAU : `content/market/${id}.yaml`, `stallNames.${id}`, n);
  return out;
}

/**
 * The kinds every line of a market file has: 'stall' for a stall file or The Season's Table, and 'okafor' for every
 * line in Okafor-Sato's own file (never gendered, voice §0.11, named or not).
 */
function fileKinds(file: string): string[] {
  if (file === 'content/market/okafor-sato.yaml') return ['stall', 'okafor'];
  return /^content\/market\/|^data\/seasonality\.yaml$/.test(file) ? ['stall'] : [];
}

/** The market module (M6 Step 5): every string of every stall, and The Season's Table, by file and key path. */
function collectMarket(m: MarketContent): Scanned[] {
  const out: Scanned[] = [];
  for (const [id, stall] of Object.entries(m.stalls)) {
    const file = `content/market/${id}.yaml`;
    for (const [where, text] of strings(stall, '')) out.push(scanned(file, where, text, fileKinds(file)));
  }
  for (const [where, text] of strings(m.seasonality, '')) out.push(scanned('data/seasonality.yaml', where, text, fileKinds('data/seasonality.yaml')));
  return out;
}

/** M5 final I4: scarcity words and joke cues about a cupboard ("rice, half an onion, and regret"). */
const SCARCITY =
  /\b(regret\w*|sad\w*|pathetic|bare|empty (?:fridge|cupboard|shelf|shelves|pantry|kitchen)|tragic|tumbleweeds?|meagre|meager|slim pickings|sorry state|perfectly acceptable inventory|(?:worked|work|made do|make do|managed|manage) with less|better stocked|stocked than|desperat\w*|grim|lol|haha)\b/i;
/** A line that talks about the player's cupboard: its scarcity words are scanned wherever it is (M5 final I4). */
const CUPBOARD = /\b(cupboards?|fridge|pantry(?! bureau)|shelf|shelves|larder)\b/i;

const NUMBER_WORD = String.raw`(?:\d+|X|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;

/** The patterns, by what they guard. Each applies to every line unless `kinds` narrows it. */
const PATTERNS: { name: string; re: RegExp; kinds?: string }[] = [
  // voice §0.2 and §7
  { name: 'exotic/ethnic/weird/strange/unusual', re: /\b(exotic|ethnic|weird|strange|unusual)\b/i },
  { name: 'authentic', re: /\bauthentic\w*/i },
  { name: 'moralised food', re: /\b(guilt[- ]free|cheat day|junk food|junk|clean eating|sinful)\b/i },
  { name: 'praise for eating less', re: /\b(skipped a meal|good job)\b/i },
  { name: 'gendered endearment', re: /\b(mijo|mija)\b/i },
  { name: 'accents', re: /\bbroken English\b/i },
  { name: 'Okafor-Sato is never he or she', re: /\b(he|she|him|his|her|hers)\b/i, kinds: 'okafor' },
  // voice §0.3: recipes are taught and gifted, never loot
  { name: 'loot words', re: /\b(unlock\w*|loot\w*|collect\w*|acquir\w*|discover\w*|captur\w*|conquer\w*)\b/i },
  // "found" about a recipe: within a few words of recipe or dish, either way round ("found a new recipe", "the recipes
  // you found"); "I can't find {term} in the ledger, so I can't check dishes" is about an ingredient name.
  { name: 'found/find about recipes', re: /\b(?:found|find|finds|finding)\s+(?:[\w']+\s+){0,3}?(?:recipes?|dish(?:es)?)\b|\b(?:recipes?|dish(?:es)?)\s+(?:[\w']+\s+){0,3}?(?:found|find|finds|finding)\b/i },
  { name: 'x/9 completion', re: /\b\d+\s*\/\s*\d+\b/ },
  // voice §0.7, spec §2.3: missed days cost nothing; no streaks
  { name: 'streak', re: /\bstreaks?\b/i },
  { name: 'missed', re: /\bmissed\b/i },
  { name: 'x days', re: new RegExp(String.raw`\b${NUMBER_WORD}\s+(?:days|weeks)\b`, 'i') },
  // audit §4.2: no cuisine is a version of another
  { name: 'version of', re: /\bversions? of\b/i },
  // never rules 3, 5, 7: no selling, no price, no Guild
  { name: 'selling', re: /\b(guild|prices?|pricing|upgrade\w*|premium|subscri\w*)\b|[$£€]\s?\d/i },
  // Ruling 17: stamps are spent nowhere until M10
  { name: 'spending stamps', re: /\b(spend|spends|spent|spending)\b/i },
  // M6 Ruling 6 and Ruling 5 (Step 5): nothing is "smuggled"; no currency symbol anywhere (chalkboard prices name none)
  { name: 'smuggled', re: /\bsmuggl\w*/i },
  { name: 'currency symbol', re: /[$£€¥₹₩₦₱¢]/ },
  // M6 (never rule 5, voice §5): a stall keeper never hurries, counts down or calls stock scarce; a spice is never
  // "mysterious" (the mystery is the merchant).
  {
    name: 'stall scarcity or countdown',
    re: /\b(sold out|sell(?:s|ing)? out|selling fast|hurry\w*|last chance|running out|while (?:stocks?|supplies) last|limited (?:time|stock|supply|offer)|only \w+ left|(?:almost|nearly) gone|before (?:it'?s|they'?re) gone|ends? soon|ending soon|don'?t miss)\b/i,
    kinds: 'stall',
  },
  { name: 'mysterious spice', re: /\bmysterious\w*/i, kinds: 'stall' },
  // §9: never claim HIPAA
  { name: 'HIPAA', re: /\bHIPAA\b|\bmedical[- ]grade\b/i },
  // spec §2.3, voice §0.10: no hours or calories in nourishment or rescue lines
  { name: 'hours or calories', re: new RegExp(String.raw`\b${NUMBER_WORD}\s*(?:hours?|hrs?)\b|\b(?:calories|calorie|kcal)\b`, 'i'), kinds: 'nourishment' },
  { name: 'hours or calories', re: new RegExp(String.raw`\b${NUMBER_WORD}\s*(?:hours?|hrs?)\b|\b(?:calories|calorie|kcal)\b`, 'i'), kinds: 'rescue' },
  // audit M-4: a sparse cupboard is never a joke
  { name: 'sparse cupboard', re: /\b(only|just|empty|bare|sad)\b/i, kinds: 'frame' },
  { name: 'sparse cupboard', re: /\b(only|just|empty|bare|sad)\b/i, kinds: 'rescue' },
  // M5 final I4 (audit M-4): no joke about what is, or isn't, in the cupboard, in intake and pantry lines, or in any
  // line that names the cupboard, fridge, pantry or a shelf. Scarcity words and joke cues alike.
  { name: 'scarcity joke', re: SCARCITY, kinds: 'pantry' },
  { name: 'scarcity joke', re: SCARCITY, kinds: 'cupboard' },
];

/**
 * Keyed by location (file and path) and exact text (fix round 1, M7): the same words anywhere else are scanned. Each
 * entry excuses only its own patterns (M6 Step 5 fix round 1, M2).
 */
const allowed = new Map(VOICE_ALLOWLIST.map((a) => [`${a.file}\0${a.where}\0${a.line}`, new Set(a.patterns ?? [])]));
/** This scan's own entries; the 'countdown' ones are proven needed by Step 12's never-rules sweep (e2e). */
const VOICE_ENTRIES = VOICE_ALLOWLIST.filter((a) => (a.scan ?? 'voice') === 'voice');

/** Every pattern hit in `items` outside the allowlist, as "file where: pattern: text". */
function scan(items: readonly Scanned[]): string[] {
  const problems: string[] = [];
  for (const it of items) {
    const excused = allowed.get(`${it.file}\0${it.where}\0${it.text}`);
    // {vars} are filled in by code; their names are not words the player reads.
    const text = it.text.replace(/\{\w+\}/g, 'X');
    for (const p of PATTERNS) {
      if (p.kinds !== undefined && !it.kinds.has(p.kinds)) continue;
      if (excused?.has(p.name) === true) continue;
      if (p.re.test(text)) problems.push(`${it.file} ${it.where}: ${p.name}: ${it.text}`);
    }
  }
  return problems;
}

const market = await loadMarket();
const shipped = [...collect(content), ...collectMarket(market)];
const line = (text: string, kinds: string[] = [], file = PAN, where = 'planted'): Scanned =>
  scanned(file, where, text, [...kinds, ...fileKinds(file.replace(/#.*$/, ''))]);

describe('voice scan of the client content (C29)', () => {
  it('scans the lines, forms, frames, recipes and names the bundle carries', () => {
    const files = new Set(shipped.map((s) => s.file));
    for (const f of [PAN, BUREAU, 'content/cooks/leela.yaml', 'content/frames/fried-rice.yaml', 'recipes/india/kerala/parippu.cook']) expect(files, f).toContain(f);
    expect(shipped.length).toBeGreaterThan(1000);
    expect(shipped.filter((s) => s.kinds.has('frame')).length).toBeGreaterThan(10);
    expect(shipped.filter((s) => s.kinds.has('rescue')).length).toBeGreaterThan(10);
    expect(shipped.filter((s) => s.kinds.has('nourishment')).length).toBeGreaterThan(10);
  });

  it('finds no banned word, loot word, streak, price or sparse-cupboard joke outside the allowlist', () => {
    expect(scan(shipped)).toEqual([]);
  });

  it('every allowlist entry is a shipped line, has a reason, and is caught by a pattern (so it needs the entry)', () => {
    for (const a of VOICE_ALLOWLIST) {
      expect(shipped.some((s) => s.file === a.file && s.where === a.where && s.text === a.line), `${a.file} ${a.where}: ${a.line}`).toBe(true);
      expect(a.reason.length, a.line).toBeGreaterThan(20);
    }
    for (const a of VOICE_ENTRIES) expect(scan([line(a.line, [], `${a.file}#unlisted`)]), a.line).not.toEqual([]);
  });

  it('fix round 1, M2: an entry excuses only the patterns it was justified for, and names exactly the ones its line trips', () => {
    // A new pattern that trips an allowlisted line fails here until the entry is re-justified for it.
    const mismatched: string[] = [];
    for (const a of VOICE_ENTRIES) {
      const tripped = [...new Set(scan([line(a.line, [], `${a.file}#unlisted`)]).map((h) => h.split(': ')[1]))].sort();
      if (JSON.stringify([...(a.patterns ?? [])].sort()) !== JSON.stringify(tripped)) mismatched.push(`${a.where}: ${JSON.stringify(tripped)}`);
    }
    // A location excuses nothing beyond its own patterns: with none listed, the exact line fails at its own place.
    for (const a of VOICE_ENTRIES) {
      const key = `${a.file}\0${a.where}\0${a.line}`;
      const kept = allowed.get(key)!;
      allowed.set(key, new Set());
      expect(scan([line(a.line, [], a.file, a.where)]), a.line).not.toEqual([]);
      allowed.set(key, kept);
    }
    expect(mismatched).toEqual([]);
  });

  it('an allowlisted line edited by one word fails again', () => {
    for (const a of VOICE_ENTRIES) {
      // One word added at the end: the caught words stay, the exact line is gone.
      const edited = `${a.line} Indeed.`;
      expect(edited).not.toBe(a.line);
      expect(scan([line(edited, [], a.file, a.where)]), edited).not.toEqual([]);
    }
  });

  it('an allowlisted line pasted somewhere else in the same file fails: the entry pins one place (fix round 1, M7)', () => {
    for (const a of VOICE_ENTRIES) {
      expect(scan([line(a.line, [], a.file, a.where)]), a.line).toEqual([]);
      expect(scan([line(a.line, [], a.file, `${a.where}.elsewhere`)]), a.line).not.toEqual([]);
    }
  });

  it('scans recipe ingredient display names and notes (fix round 1, M6)', () => {
    const recipe = Object.values(content.recipes)[0];
    const planted: ClientContent = {
      ...content,
      recipes: { 'x/y/z': { ...recipe, ingredients: recipe.ingredients.map((l, i) => (i === 0 ? { ...l, displayName: 'exotic beef', note: 'cheap cut, example price' } : l)) } },
    };
    const hits = scan(collect(planted).filter((x) => x.file === 'recipes/x/y/z.cook'));
    expect(hits.some((h) => h.includes('displayName'))).toBe(true);
    expect(hits.some((h) => h.includes('.note'))).toBe(true);
  });

  it.each([
    ['you lost your streak', []],
    ['Spend it on a hat', []],
    ['Stamp earned: X. Spend it on a hat. For me.', []],
    ['You missed three days.', []],
    ['Recipe acquired!', []],
    ['You found a new recipe.', []],
    ['Unlock the Guild for more.', []],
    ['Our dal is a version of their soup.', []],
    ['HIPAA-compliant records.', []],
    ['The Pantry Guild price is $5.', []],
    ['Okafor-Sato says he has tofu.', []],
    ['That curry is so exotic.', []],
    ['It has been six hours since you ate.', ['nourishment']],
    ['That meal was 400 calories.', ['nourishment']],
    ['Only an onion? Sad cupboard.', ['frame']],
    ['The cupboard is bare, so here is a tiny sauce.', ['rescue']],
    ['Use it in 2 days or lose it.', ['rescue']],
    // M5 final I4: the shipped intake joke, and its cousins, anywhere a cupboard comes up.
    ["Last one: what's in the cupboard? Roughly. 'Rice, half an onion, and regret' is a perfectly acceptable inventory.", ['pantry']],
    ["Last one: what's in the cupboard? Roughly. 'Rice, half an onion, and regret' is a perfectly acceptable inventory.", []],
    ['An empty fridge? Classic.', []],
    ['Tumbleweeds in there, I see.', ['pantry']],
    ['That shelf looks pathetic.', []],
    ["{items}. Excellent. I can work with that. I've worked with less. 1911.", ['pantry']],
    ["Pantry noted: {items}. You're better stocked than a lighthouse I once knew.", ['pantry']],
  ])('a planted %j fails', (text, kinds) => {
    expect(scan([line(text, kinds)])).not.toEqual([]);
  });

  it('the narrow patterns stay narrow: plain teaching lines pass', () => {
    for (const text of ['I found more than one thing that could be X. Tap the one you mean.', "Wash your hands, then the step.", 'Toast counts. Toast always counts.']) {
      expect(scan([line(text)]), text).toEqual([]);
    }
    // "just" in a line that is not a frame or rescue line is fine; in one, it fails.
    expect(scan([line('Cooked for just me.')])).toEqual([]);
    expect(scan([line('Just enough for a sauce.', ['frame'])])).not.toEqual([]);
  });
});

describe('voice scan of the market module (M6 Step 5)', () => {
  const marketLines = collectMarket(market);
  const at = (file: string, where: RegExp) => marketLines.filter((x) => x.file === file && where.test(x.where));

  it('every MarketContent string passes the voice scan; "smuggled" and currency symbols are patterns', () => {
    // It reaches every kind of stall content: lines, prompts, options, reactions, explanations, tips, FAQ chips and
    // answers, keeper greet/idle/farewell, the Protein Counter's own content, Wen's seasonal round and the table.
    const WEN = 'content/market/wen.yaml';
    const BRAM = 'content/market/bram.yaml';
    for (const [file, where] of [
      [WEN, /^triggers\.greet\.lines\[0\]$/], [WEN, /^triggers\.idle\.lines\[0\]$/], [WEN, /^triggers\.farewell\.lines\[0\]$/],
      [WEN, /^questions\[0\]\.prompt$/], [WEN, /^questions\[0\]\.options\[0\]\.text$/], [WEN, /^questions\[0\]\.options\[0\]\.reaction$/], [WEN, /^questions\[0\]\.explain$/],
      [WEN, /^seasonal\.pnw-usa\.11\[0\]\.options\[2\]\.reaction$/], [WEN, /^item_tips\.avocado\.pick$/], [WEN, /^faq\[0\]\.q\[0\]$/], [WEN, /^faq\[0\]\.a$/],
      [BRAM, /^variants\.protein_counter\.triggers\.greet\.lines\[0\]$/], [BRAM, /^variants\.protein_counter\.questions\[0\]\.prompt$/],
      [BRAM, /^variants\.protein_counter\.faq\[0\]\.a_if_blocked$/], [BRAM, /^variants\.protein_counter\.item_tips\.\w+\.store$/], [BRAM, /^variants\.protein_counter\.name$/],
      ['content/market/okafor-sato.yaml', /^questions\[0\]\.prompt$/], ['content/market/spice.yaml', /^triggers\.allergen_note\.lines\[0\]$/],
      ['data/seasonality.yaml', /^pnw-usa\.categories\[2\]\.label$/], ['data/seasonality.yaml', /^pnw-usa\.name$/],
    ] as const) expect(at(file, where).length, `${file} ${String(where)}`).toBeGreaterThan(0);
    expect(marketLines.length).toBeGreaterThan(1500);
    expect(marketLines.filter((x) => x.kinds.has('okafor')).length).toBeGreaterThan(200);
    // No persona text ships, so none is scanned as shipped.
    expect(marketLines.some((x) => /(^|\.)persona(\[|$)/.test(x.where))).toBe(false);
    expect(scan(marketLines)).toEqual([]);
  });

  it.each([
    ['Seasonal or smuggled?', 'content/market/wen.yaml'],
    ['These strawberries were smuggled in.', 'content/market/wen.yaml'],
    ['Chuck is 4.50 a serving, or about £4.', 'content/market/bram.yaml'],
    ['Lentils: 1.75¢ a serving.', 'content/market/bram.yaml'],
    ['¥200 for the block.', 'content/market/okafor-sato.yaml'],
    ['A bag for ₹50.', 'content/market/spice.yaml'],
    ['Only 3 left, so grab them!', 'content/market/wen.yaml'],
    ['Hurry: the chuck is selling fast.', 'content/market/bram.yaml'],
    ['Sold out soon, last chance.', 'content/market/wen.yaml'],
    ['A mysterious spice from far away.', 'content/market/spice.yaml'],
    ['An exotic bean.', 'content/market/okafor-sato.yaml'],
    ['He presses it twice, then nods.', 'content/market/okafor-sato.yaml'],
    ['Our dal is a version of your soup.', 'content/market/spice.yaml'],
    ['Well-travelled: only two weeks left', 'data/seasonality.yaml'],
  ])('a planted stall line %j fails', (text, file) => {
    expect(scan([line(text, [], file, 'planted')])).not.toEqual([]);
  });

  it('the stall patterns are scoped: the same plain storage words pass, and the Pan may say "left" or "only"', () => {
    for (const text of ['Fridge, in a bag or a drawer.', 'Tops off, then in the fridge.', 'Weigh it by the serving.']) {
      expect(scan([line(text, [], 'content/market/wen.yaml')]), text).toEqual([]);
    }
    // "hurry" is a stall pattern; a Pan line is scanned by the Step 12 countdown sweep instead.
    expect(scan([line('No hurry at all.', [], PAN)])).toEqual([]);
    expect(scan([line('No hurry at all.', [], 'content/market/wen.yaml')])).not.toEqual([]);
  });
});


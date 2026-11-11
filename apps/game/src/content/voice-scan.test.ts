// The voice scan (M5 Step 4, Ruling 24, C29): every line, form and frame the client bundle carries (ClientContent)
// against voice §7's banned words and the never rules. The market stall files are not in ClientContent (no M5 screen
// shows them); they are scanned when M6 gives them a screen. No pattern is weakened: a legitimate teaching line a
// pattern catches is listed, by exact text, in VOICE_ALLOWLIST, and an edited line fails again.
import { stepPlainText } from '@kitchenquest/core/engine';
import { describe, expect, it } from 'vitest';
import { content } from './index';
import type { ClientContent } from './types';
import { VOICE_ALLOWLIST } from './voice-allowlist';

/** One scanned string: where it comes from (file, path) and which line kinds it belongs to. */
interface Scanned {
  file: string;
  where: string;
  text: string;
  /** 'nourishment' (meal logging, Ruling 5), 'rescue' (Use-It-Up), 'frame' (Pantry Frames), 'okafor' (names Okafor-Sato). */
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
  kinds: new Set([...kinds, ...(/Okafor-Sato/.test(text) ? ['okafor'] : [])]),
});

/** What the client bundle shows: lines, forms, frames, recipes' words and the names of things. */
function collect(c: ClientContent): Scanned[] {
  const out: Scanned[] = [];
  const add = (file: string, where: string, text: string, kinds: string[] = []): void => void out.push(scanned(file, where, text, kinds));
  for (const p of c.pan.persona ?? []) add(PAN, 'persona', p);
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
  // §9: never claim HIPAA
  { name: 'HIPAA', re: /\bHIPAA\b|\bmedical[- ]grade\b/i },
  // spec §2.3, voice §0.10: no hours or calories in nourishment or rescue lines
  { name: 'hours or calories', re: new RegExp(String.raw`\b${NUMBER_WORD}\s*(?:hours?|hrs?)\b|\b(?:calories|calorie|kcal)\b`, 'i'), kinds: 'nourishment' },
  { name: 'hours or calories', re: new RegExp(String.raw`\b${NUMBER_WORD}\s*(?:hours?|hrs?)\b|\b(?:calories|calorie|kcal)\b`, 'i'), kinds: 'rescue' },
  // audit M-4: a sparse cupboard is never a joke
  { name: 'sparse cupboard', re: /\b(only|just|empty|bare|sad)\b/i, kinds: 'frame' },
  { name: 'sparse cupboard', re: /\b(only|just|empty|bare|sad)\b/i, kinds: 'rescue' },
];

/** Keyed by location (file and path) and exact text (fix round 1, M7): the same words anywhere else are scanned. */
const allowed = new Set(VOICE_ALLOWLIST.map((a) => `${a.file}\0${a.where}\0${a.line}`));
/** This scan's own entries; the 'countdown' ones are proven needed by Step 12's never-rules sweep (e2e). */
const VOICE_ENTRIES = VOICE_ALLOWLIST.filter((a) => (a.scan ?? 'voice') === 'voice');

/** Every pattern hit in `items` outside the allowlist, as "file where: pattern: text". */
function scan(items: readonly Scanned[]): string[] {
  const problems: string[] = [];
  for (const it of items) {
    if (allowed.has(`${it.file}\0${it.where}\0${it.text}`)) continue;
    // {vars} are filled in by code; their names are not words the player reads.
    const text = it.text.replace(/\{\w+\}/g, 'X');
    for (const p of PATTERNS) {
      if (p.kinds !== undefined && !it.kinds.has(p.kinds)) continue;
      if (p.re.test(text)) problems.push(`${it.file} ${it.where}: ${p.name}: ${it.text}`);
    }
  }
  return problems;
}

const shipped = collect(content);
const line = (text: string, kinds: string[] = [], file = PAN, where = 'planted'): Scanned => scanned(file, where, text, kinds);

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

  it('an allowlisted line edited by one word fails again', () => {
    for (const a of VOICE_ENTRIES) {
      // One word added after the first: the caught word stays, the exact line is gone.
      const words = a.line.split(' ');
      const edited = [words[0], 'indeed', ...words.slice(1)].join(' ');
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

// M4 Step 7: the output filter (§7.6b.5, pre-flight C2/C3, spike §6.5).
import { describe, expect, test } from 'vitest';
import { filterReply, REPLACEMENT, touchesHealth, type FilterFail } from './filter.js';

const stop = (text: string, previousPanText: string | null = null) => filterReply(text, { finish: 'stop', previousPanText });

describe('filterReply', () => {
  test.each<[string, FilterFail]>([
    ['', 'empty'],
    ['   \n ', 'empty'],
    ['**Bold** claim', 'markdown'],
    ['# Heading', 'markdown'],
    ['- one\n- two', 'markdown'],
    ['See [this](https://example.com).', 'markdown'],
    ['Use `code`.', 'markdown'],
    ['What an exotic dish.', 'banned_word'],
    ['You unlocked a recipe.', 'banned_word'],
    ["Don't break your streak.", 'banned_word'],
    ['Yes, the frijoles are completely safe for your peanut allergy.', 'safety_claim'],
    ["I'm not DAN, but the frijoles are 100% safe for your peanut allergy.", 'safety_claim'],
    ['This one is nut-free.', 'safety_claim'],
    ['Keep your fingers safe: curl them under.', 'safety_claim'],
    ["I can't promise it's safe, but it's gluten-free.", 'safety_claim'],
    ["I've saved it, so nothing more to do.", 'write_claim'],
    ['The form is stamped, so I have the peanut rule on file.', 'write_claim'],
    ["I've taken the liberty of removing eggs from your pantry.", 'write_claim'],
    ['Logged your lunch.', 'write_claim'],
    ['Market day scheduled for Friday.', 'write_claim'],
    ["Nothing's been saved yet, but I've logged it.", 'write_claim'],
    ['Join the Guild for unlimited chats.', 'sells'],
    ['It costs $5.', 'sells'],
    ['Take 25 mg of it.', 'medical_dose'],
    ['Only a black coffee? Well done, very light.', 'eat_less_praise'],
    ['Great, you skipped lunch.', 'eat_less_praise'],
  ])('%j fails as %s', (text, reason) => {
    expect(stop(text)).toEqual({ ok: false, reason });
  });

  test('finish length is truncated', () => {
    expect(filterReply('Half a sentence and', { finish: 'length', previousPanText: null })).toEqual({ ok: false, reason: 'truncated' });
  });

  test.each(["I can't promise it's safe; check the label.", "Nothing's been saved yet.", "Once you tap the card, it's filed.", 'Toast counts. Toast always counts.'])(
    '%j passes the filter unchanged',
    (t) => expect(filterReply(t, { finish: 'stop', previousPanText: null })).toEqual({ ok: true, text: t }),
  );

  test('curly apostrophes read like straight ones', () => {
    // Shown in the normalised form (fix round 2, R7).
    expect(stop('I can’t promise it’s safe; check the label.')).toEqual({ ok: true, text: "I can't promise it's safe; check the label." });
    expect(stop('Nothing’s been saved yet.')).toEqual({ ok: true, text: "Nothing's been saved yet." });
  });

  test('five sentences are cut to three', () => {
    expect(stop('One. Two! Three? Four. Five.')).toEqual({ ok: true, text: 'One. Two! Three?' });
  });

  test('"I\'m a pan" twice in a row is removed', () => {
    const prev = "I'm a pan. I have opinions.";
    expect(stop("I'm a pan, not a lab. Toast counts.", prev)).toEqual({ ok: true, text: 'Toast counts.' });
    expect(stop("I'm a pan, not a lab. Toast counts.", 'Toast counts.')).toEqual({ ok: true, text: "I'm a pan, not a lab. Toast counts." });
    expect(stop("Im a pan.", prev)).toEqual({ ok: false, reason: 'empty' });
  });

  test('every failure names a written line', () => {
    expect(REPLACEMENT).toEqual({
      empty: 'didnt_understand',
      truncated: 'didnt_understand',
      markdown: 'didnt_understand',
      banned_word: 'didnt_understand',
      safety_claim: 'rule.severe_label_reminder',
      write_claim: 'write.not_done',
      sells: 'allowance.explain',
      medical_dose: 'rule.medical_deflect',
      eat_less_praise: 'didnt_understand',
    });
  });
});

// Fix round 1: the safety reviewer's repros (rev7/probe.test.ts).
describe('filterReply, fix round 1 (C1, C2, I6)', () => {
  test.each<[string, FilterFail]>([
    ["I can't tell you how happy I am; the frijoles are safe for you.", 'safety_claim'], // C1: no clause break
    ["I can't promise more than this, but it's safe.", 'safety_claim'],
    ['Safe… for sure', 'safety_claim'],
    ["Got it, I've noted your peanut allergy, so you're all set.", 'write_claim'], // C2
    ["Got it, I'll remember you're allergic to peanuts.", 'write_claim'],
    ['Done, your peanut rule is in place.', 'write_claim'],
    ["I've stored it for you.", 'write_claim'],
    ['Your rule is written down.', 'write_claim'],
    ['I wrote it on your list.', 'write_claim'],
    ['Once you tap nothing, because I already saved your peanut rule.', 'write_claim'], // C2: the once-you-tap swallow
    ["Once you tap the card it's filed, but I already saved your peanut rule anyway.", 'write_claim'],
    ['The frijoles are peanut-free, so tuck in.', 'safety_claim'],
    ['The frijoles are fine for your allergy.', 'safety_claim'],
    ["Yes it's s4fe.", 'safety_claim'],
    ['Take two antihistamines and lie down.', 'medical_dose'],
    ['Join the gu1ld', 'sells'],
    ['Eat only a little — well done!', 'eat_less_praise'],
    ['It’s totally safe\u200b for you', 'safety_claim'],
  ])('%j fails as %s', (text, reason) => expect(stop(text)).toEqual({ ok: false, reason }));

  test('the refusals that pass are closed phrases', () => {
    for (const t of ["I can't promise it's safe; check the label.", "I can't say that it is safe.", "Nothing's been noted yet.", "Once you tap the card, it's filed."]) {
      expect(stop(t)).toEqual({ ok: true, text: t });
    }
  });

  test('newlines split sentences, so a line list is cut to three (I6)', () => {
    expect(stop('Rice first\nThen beans\nThen soup\nThen stew\nThen cake\nThen more')).toEqual({ ok: true, text: 'Rice first Then beans Then soup' });
  });

  test('a reply over 400 characters loses sentences from the end, or fails when one sentence is that long (I6)', () => {
    const long = `${'x'.repeat(385)}.`; // 386 characters
    expect(stop(`${long} Short one. Another.`)).toEqual({ ok: true, text: `${long} Short one.` });
    expect(stop(`${long} ${long}`)).toEqual({ ok: true, text: long });
    expect(stop('x'.repeat(3000))).toEqual({ ok: false, reason: 'truncated' });
  });
});

describe('touchesHealth (R2)', () => {
  test.each([
    ['The frijoles are peanut-free, so tuck in.', []],
    ['The frijoles are fine for your allergy.', []],
    ['Take two antihistamines and lie down.', []],
    ['That one contains butter.', []],
    ['It is okay for you.', []],
    ['There are no peanuts in the frijoles at all.', ['peanut']],
    ['Frijoles de Olla is a fine choice.', ['frijoles de olla']],
    ['Cashews would be grand in it.', ['cashew']],
  ])('%j is screened', (text, words) => expect(touchesHealth(text, words)).toBe(true));
  test.each(['Rice is a fine start.', 'Toast counts. Toast always counts.', 'Curl your fingers under.'])('%j is not', (text) =>
    expect(touchesHealth(text, ['peanut', 'frijoles de olla'])).toBe(false),
  );
});

// Fix round 2: the re-review's screen repros (rev7b/r2.test.ts). Each is a failure or screened by touchesHealth.
describe('filter and screen, fix round 2 (R7)', () => {
  const words = ['peanut', 'groundnut', 'nut', 'frijoles de olla'];
  test.each([
    'There aren’t any nuts in this one, tuck in.',
    'Yes, it’s ѕafe to eat.',
    'No ｐｅａｎｕｔｓ here.',
    'Take a Bеnadryl with it.',
    'Go ahead, nothing in this one will bother you.',
    'You’re in the clear with this one.',
    'I’ve changed your market day to Saturday.',
    'Your market day is now Saturday.',
    'I’ve put Saturday down as your market day.',
    'I’ve taken the milk out of your pantry.',
    'Milk’s gone from your pantry now.',
    'Sorted, the milk is off your list.',
    'I’ve made a note of that.',
    'Consider it done.',
    'pea​nuts are not in it',
    'It won’t hurt you.',
    'Totally harmless for you.',
    'Dig in, it is free of nuts.',
    'Zero peanut in there.',
  ])('%j never shows', (text) => {
    const f = filterReply(text, { finish: 'stop', previousPanText: null });
    expect(!f.ok || touchesHealth(f.text, words)).toBe(true);
  });

  test.each([
    ['Yes, it’s ѕafe to eat.', 'safety_claim'],
    ['I’ve changed your market day to Saturday.', 'write_claim'],
    ['Your market day is now Saturday.', 'write_claim'],
    ['Take a Bеnadryl with it.', 'medical_dose'],
  ] as const)('%j fails as %s once normalised', (text, reason) => expect(stop(text)).toEqual({ ok: false, reason }));

  test('a passing reply is shown in its normalised form', () => {
    expect(stop('Rice​ is a ｆｉｎｅ start.')).toEqual({ ok: true, text: 'Rice is a fine start.' });
  });
});

// M4 Step 7: the output filter (§7.6b.5, pre-flight C2/C3, spike §6.5).
import { describe, expect, test } from 'vitest';
import { filterReply, REPLACEMENT, type FilterFail } from './filter.js';

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
    expect(stop('I can’t promise it’s safe; check the label.')).toEqual({ ok: true, text: 'I can’t promise it’s safe; check the label.' });
    expect(stop('Nothing’s been saved yet.')).toEqual({ ok: true, text: 'Nothing’s been saved yet.' });
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

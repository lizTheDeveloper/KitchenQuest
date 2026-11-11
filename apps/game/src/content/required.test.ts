import { describe, expect, it } from 'vitest';
import { content } from './index';
import { REQUIRED_DISCLAIMERS, REQUIRED_PAN_TRIGGERS } from './required';

// M4 Step 2: the written lines the server and the scripted engine emit by id. The first line of
// each is the plan's wording, verbatim; Steps 7–11 rely on these ids existing and on `ai: never`.
const NEW_TRIGGERS: Record<string, string> = {
  'rule.unknown_term':
    "I can't find {term} in the Bureau's ingredient ledger yet, so I can't check dishes for it. Nothing's been saved. Please check every recipe and label yourself, and tell me if you'd like to file something close to it.",
  'rule.which_one': "I found more than one thing that could be {term}. Tap the one you mean, so I file the right one.",
  'rule.tap_needed':
    "For an allergy, I need a tap on the card itself, not just a yes. Please check {ingredient} on the card and tap 'Stamp it'.",
  'confirm.tap_card': "There's more than one card open. Tap the one you mean, so I'm sure which.",
  'write.not_done':
    "Nothing's been written down yet. If you'd like me to, tell me plainly and I'll show you the card to stamp.",
  'consent.health_first':
    'Before I can file that, the Bureau needs your say-so to keep health details. Tap the card, then tell me again.',
  'child.grownup':
    "I'm glad you're cooking. I can only take notes from a grown-up, so please fetch the grown-up you cook with. And use the big knives only with them right beside you.",
  'allowance.explain':
    "I've a daily allowance of chat, and I'll tell you when it runs out. Recipes, cooking, allergy and diet rules, logging and the market always work, every day, for nothing.",
  'log.needs_account':
    'I can keep a food log once you\'re signed in. Settings has the sign-in. Everything else works on this device as it is.',
  'profile.readback': '{summary}. Shall I ink it?',
  'pantry.readback': '{summary}. Shall I update the pantry?',
  'ai.try_again': "I've kept what you said. Tap 'Try again' in a moment, or use the buttons below.",
  'mentor.ai_unavailable':
    "The line to the Bureau's gone quiet, so I'm answering from the script. Allergies, logging, recipes and the market all still work.",
  'forget.done':
    "Forgotten. The conversation's gone from the Bureau's files. Your saved rules, meals and pantry are where you left them.",
};

const VARS: Record<string, string[]> = {
  'rule.unknown_term': ['term'],
  'rule.which_one': ['term'],
  'rule.tap_needed': ['ingredient'],
  'profile.readback': ['summary'],
  'pantry.readback': ['summary'],
};

const ALSO_REQUIRED = [
  'rule.readback', 'rule.readback.no_spelling', 'rule.severity_unclear', 'rule.stamped', 'rule.not_quite',
  'rule.voided', 'rule.void_confirm', 'rule.emergency', 'rule.medical_deflect', 'log.confirm_readback',
  'log.logged', 'pantry.added', 'pantry.removed', 'schedule.set', 'schedule.bad_time', 'undo', 'undo.nothing',
  'didnt_understand', 'rate_limited', 'intake.open', 'intake.market_day.ask', 'intake.market_day.followup',
  'intake.meals_per_week.ask', 'intake.meals_per_week.followup', 'intake.region.ask', 'intake.region.followup',
  'intake.allergies.ask', 'intake.allergies.followup', 'intake.allergies.none', 'intake.pantry.ask',
  'intake.pantry.followup', 'intake.skip', 'intake.complete',
];

const C16 = "The Pan and the cooks are AI characters. Don't rely on them for medical advice.";
const triggers = content.pan.triggers;
const lines = (id: string): string[] => triggers[id]?.lines ?? [];

describe('M4 Pan triggers', () => {
  it('requires every new trigger, the triggers the mentor emits, and the AI disclaimer', () => {
    for (const id of [...Object.keys(NEW_TRIGGERS), ...ALSO_REQUIRED]) expect(REQUIRED_PAN_TRIGGERS, id).toContain(id);
    expect(REQUIRED_DISCLAIMERS).toContain('ai_characters');
  });

  it('pins every safety and mentor trigger to ai: never', () => {
    const ruleIds = Object.keys(triggers).filter((id) => id.startsWith('rule.'));
    expect(ruleIds.length).toBeGreaterThan(10);
    const ids = [
      ...Object.keys(NEW_TRIGGERS), ...ruleIds,
      'log.confirm_readback', 'log.low_intake_checkin', 'rule.emergency', 'rule.medical_deflect', 'child.grownup', 'allowance.explain',
    ];
    for (const id of ids) {
      expect(triggers[id], id).toBeDefined();
      expect(triggers[id].ai, id).toBe('never');
    }
  });

  it.each(Object.entries(NEW_TRIGGERS))('%s opens with the plan line and has 3–4 lines', (id, first) => {
    expect(lines(id)[0]).toBe(first);
    if (id === 'child.grownup') expect(lines(id)).toEqual([first]);
    else {
      expect(lines(id).length, id).toBeGreaterThanOrEqual(3);
      expect(lines(id).length, id).toBeLessThanOrEqual(4);
    }
    expect(new Set(lines(id)).size, `${id} repeats a line`).toBe(lines(id).length);
  });

  it.each(Object.keys(NEW_TRIGGERS))('%s uses only its declared variables, in every line', (id) => {
    const declared = VARS[id] ?? [];
    expect(Object.keys(triggers[id].vars ?? {}).sort()).toEqual([...declared].sort());
    for (const line of lines(id)) {
      const used = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(new Set(used), line).toEqual(new Set(declared));
    }
  });

  it('never sells, names the Guild, a plan or a price in the allowance and fallback lines (never rule 7)', () => {
    const selling = /\b(guild|upgrade|subscri\w*|premium|plan|tier)\b|\$\s?\d|£\s?\d/i;
    for (const id of ['allowance.explain', 'rate_limited', 'ai_unavailable', 'mentor.ai_unavailable']) {
      expect(lines(id).length, id).toBeGreaterThan(0);
      for (const line of lines(id)) expect(line, id).not.toMatch(selling);
    }
  });

  it('says in every allowance line that allergy and diet rule help is never capped (pre-flight C6)', () => {
    for (const line of lines('allowance.explain')) expect(line).toMatch(/allergy and diet rules/i);
  });

  describe('no write is claimed before the stamp', () => {
    // First person ("I've saved"), passive ("it's filed", "is saved"), and the idioms ("on file", "noted down"). A line that
    // says nothing was saved ("nothing's been saved", "not saved yet") is the opposite and is allowed.
    const claim = new RegExp([
      String.raw`\bI(?:'ve| have)\s+(?:written|saved|filed|logged|stamped|inked|noted|recorded|kept)\b`,
      String.raw`(?<!\bnot\s)(?<!n't\s)(?<!\bnothing\s)(?<!\bnothing's\sbeen\s)\b(?:it|that|this|they|these)(?:'s|'re| is| are| has been| have been)\s+(?:now |already |all )?(?:filed|saved|logged|stamped|inked|recorded|noted|kept)\b`,
      String.raw`\b(?:saved|filed|logged|stamped|inked|recorded) it\b`,
      String.raw`\bon file\b`,
      String.raw`(?<!\bbeen\s)\b(?:noted|written|jotted|put) down\b`,
      String.raw`\bfiled away\b`,
      String.raw`(?<!\bnothing)(?<!\bnot)(?:'s| has| have) been\s+(?:filed|saved|logged|stamped|inked|recorded|noted|kept)\b`,
      String.raw`^\s*(?:noted|saved|filed|logged|recorded|stamped)\b\s*[.!,]`,
      String.raw`\bin the ledger\b`,
    ].join('|'), 'i');
    // Lines that say what counts as a record ("Only a card you've stamped is on file") describe the stamp; they claim nothing.
    // Exempt by id and exact line, so the same words anywhere else are still scanned.
    const EXEMPT = new Set(["write.not_done|I haven't written anything down yet. Only a card you've stamped is on file. Tell me what to file and I'll show you a card to stamp."]);
    const intakeAsks = Object.keys(triggers).filter((id) => /^intake\..+\.ask$/.test(id));

    it('matches the phrasings it is meant to catch, and lets a "nothing saved" line through', () => {
      for (const bad of ["It's filed.", "That's saved now.", "I've saved it.", "All on file.", "Noted down.", "I have written that down.", 'Stamped it.', "They're logged.", "That's been filed in the ledger, just stamp it.", "It's been saved.", "Noted.", "Saved.", "Done, it's in the ledger."]) {
        expect(bad, bad).toMatch(claim);
      }
      for (const good of ["Nothing's been saved yet.", "It isn't saved until you stamp it.", "Before I file it, check the card.", "Not saved yet.", "Nothing is filed.", "It hasn't been saved.", "Nothing has been saved."]) {
        expect(good, good).not.toMatch(claim);
      }
    });

    it('exempts exactly one line, by id: write.not_done explaining what counts as a record', () => {
      expect(EXEMPT.size).toBe(1);
      const [key] = [...EXEMPT];
      const [id, line] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      expect(lines(id)).toContain(line);
      expect(line).toMatch(claim); // so it needs the exemption, which can't cover the same words in another line
    });

    it('covers every intake ask line', () => {
      expect(intakeAsks.length).toBeGreaterThan(4);
    });

    it('holds for every line spoken before a stamp', () => {
      const ids = [
        'write.not_done', 'rule.severity_unclear', 'rule.which_one', 'rule.tap_needed', 'confirm.tap_card', 'consent.health_first', 'rule.unknown_term',
        'rule.readback', 'rule.readback.no_spelling', 'profile.readback', 'pantry.readback', 'log.confirm_readback', ...intakeAsks,
      ];
      for (const id of ids) {
        expect(lines(id).length, id).toBeGreaterThan(0);
        for (const line of lines(id)) if (!EXEMPT.has(`${id}|${line}`)) expect(line, id).not.toMatch(claim);
      }
    });
  });

  it('keeps the "I\'m a pan" act out of plain safety lines', () => {
    for (const id of ['rule.tap_needed', 'rule.unknown_term', 'child.grownup']) {
      for (const line of lines(id)) expect(line, id).not.toMatch(/\bI(?:'|’)?m a pan\b|\bI am a pan\b/i);
    }
  });

  it('never claims anything was saved or kept when the mentor AI is unavailable', () => {
    for (const line of lines('mentor.ai_unavailable')) expect(line).not.toMatch(/\b(saved|kept|logged|stored|photo)\b/i);
  });

  it('says plainly that nothing was saved for an unknown term', () => {
    for (const line of lines('rule.unknown_term')) {
      expect(line).toMatch(/nothing(?:'s| has) been saved|haven't saved|not saved/i);
      expect(line).toMatch(/label/i);
    }
  });
});

describe('M4 Bureau forms', () => {
  const { forms, disclaimers, stamps } = content.bureau;

  it('has the C-16 disclosure verbatim', () => {
    expect(disclaimers.ai_characters).toBe(C16);
  });

  it.each([
    ['consent_health', '3-C/HEALTH', 'Permission to Keep Health Details'],
    ['consent_ai', '3-C/AI', 'Permission for the AI to See Your Rules and Meals'],
  ])('%s is a plain safety form whose only field is the notice', (id, number, title) => {
    const form = forms[id];
    expect(form).toMatchObject({ number, title, safety: true, stamp: 'confirmed_by_apprentice' });
    expect(form.fields).toEqual([{ key: 'notice', label: 'What this covers' }]);
    expect(form.buttons).toEqual({ confirm: 'I agree', decline: 'Not now' });
    expect(form.footnotes).toEqual(['*Saying no costs nothing. You can play every part of the game without it.']);
  });

  it('has the profile amendment form for profile cards', () => {
    const form = forms.profile;
    expect(form).toMatchObject({ number: '1-A/AMEND', title: 'Amendment to Form 1-A', safety: false, stamp: 'inked' });
    expect(form.fields).toEqual([
      { key: 'market_days', label: 'Market day(s)' },
      { key: 'meals_per_week', label: 'Meals cooked per week' },
      { key: 'region', label: 'Country and region', hint: 'For seasonal produce. No addresses.' },
      { key: 'meal_windows', label: 'Meal times' },
    ]);
    expect(form.buttons).toEqual({ confirm: 'Ink it ✔', decline: 'Leave in pencil', undo: 'Undo' });
    expect(form.footnotes).toHaveLength(1);
    expect(form.footnotes?.[0]).toMatch(/^\*/);
    expect(stamps[form.stamp]).toBe('INKED');
  });
});

describe('M4 rule terms', () => {
  it('ships data/rule-terms.json in the compiled content', () => {
    expect(content.ruleTerms.map((t) => t.name)).toEqual(expect.arrayContaining(['vegetarian', 'vegan', 'no pork']));
    expect(content.ruleTerms.find((t) => t.name === 'no pork')?.severity).toBeNull();
  });
});

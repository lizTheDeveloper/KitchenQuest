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

describe('M5 Step 2: the rule-adapted quest lines', () => {
  it("core's ERRAND_ADAPTED_TRIGGER and COOK_ADAPTED_TRIGGER are required, ai: never, and every line names the cook", async () => {
    const { COOK_ADAPTED_TRIGGER, ERRAND_ADAPTED_TRIGGER } = await import('@kitchenquest/core/engine');
    for (const id of [ERRAND_ADAPTED_TRIGGER, COOK_ADAPTED_TRIGGER]) {
      expect(REQUIRED_PAN_TRIGGERS).toContain(id);
      const t = content.pan.triggers[id];
      expect(t.ai, id).toBe('never');
      expect(t.lines.length, id).toBeGreaterThanOrEqual(4);
      for (const line of t.lines) expect(line, id).toContain('{cook}');
    }
  });
});

describe('M5 Step 3 fix round 1: the sacred-dish plan line', () => {
  it("core's PLAN_DISH_SACRED_TRIGGER is required, ai: never, names the dish, and never says unknown or blocked", async () => {
    const { PLAN_DISH_SACRED_TRIGGER } = await import('@kitchenquest/core/engine');
    expect(REQUIRED_PAN_TRIGGERS).toContain(PLAN_DISH_SACRED_TRIGGER);
    const t = content.pan.triggers[PLAN_DISH_SACRED_TRIGGER];
    expect(t.ai).toBe('never');
    expect(t.lines.length).toBeGreaterThanOrEqual(4);
    for (const line of t.lines) {
      expect(line).toContain('{dish}');
      expect(line).not.toMatch(/don't know|unknown|blocked|unlock|locked/i);
    }
  });
});

describe('M5 Step 4: the weekly-loop lines', () => {
  /** The first line of every ai: never M5 trigger, verbatim: code and Steps 8–11 rely on these exact read-backs. */
  const FIRST_LINES: Record<string, string> = {
    'plan.readback': "Here's the week as I have it: {summary}. Shall I plan it?",
    'plan.dish_unknown': "I don't know a dish called {dish}. None of the cooks has taught it, so I haven't guessed. Which dish did you mean?",
    'plan.unverified_dish': "{dish} gets a ❓: I can't verify everything in it against your rules. Check the labels before you cook it.",
    'plan.fewer_than_asked': "{count} dishes pass your rules this week, and that's what I've picked. I won't fill the gaps with dishes I can't check.",
    'rescue.unverified': "I can't check a dish for the {item} against your rules, so I won't suggest one. Your own judgement, or the compost, is fine.",
    'frame.slot_empty': "I can't fill the {slot} with anything that passes your rules, so it stays unfilled. I won't guess. Pick something you've checked, or choose another frame.",
    'margin.readback': 'In the margin: {summary}. Shall I write it in?',
    'margin.blocked': "That change clashes with your rules: {finding}. I won't put it in the notes you cook from.",
    'margin.needs_account': "Margin notes live with your account, so they're kept private. Sign in from Settings, and the margin is yours.",
    'log.dish_offer': 'Log {dish} as a meal? One tap, or skip it.',
    'book.exported': "Your Recipe Book is saved to your device. It's yours, always free.",
    'nav.offer': 'Tap to go to {place}.',
  };
  /** Every {var} each M5 trigger declares (the plan's table). */
  const M5_VARS: Record<string, string[]> = {
    'plan.readback': ['summary'],
    'plan.dish_unknown': ['dish'],
    'plan.unverified_dish': ['dish'],
    'plan.fewer_than_asked': ['count'],
    'one_more.offer': ['technique', 'known', 'dish', 'day'],
    'one_more.refresh': ['technique', 'dish'],
    'one_more.accepted': ['day'],
    'market.ticked_pantry': ['items'],
    'rescue.offer': ['item', 'technique', 'dish'],
    'rescue.compost': ['item'],
    'rescue.unverified': ['item'],
    'frame.offer': ['frame', 'technique'],
    'frame.slot_empty': ['slot'],
    'margin.readback': ['summary'],
    'margin.blocked': ['finding'],
    'log.dish_offer': ['dish'],
    'quest.recognize': ['technique', 'cook'],
    'quest.travel_anyway': ['cook'],
    'certificate.technique': ['technique'],
    'nav.offer': ['place'],
  };

  it('requires every M5 trigger, each with the plan\'s ai value', async () => {
    const { M5_LOOP_TRIGGERS_AI } = await import('./required');
    expect(Object.keys(M5_LOOP_TRIGGERS_AI)).toHaveLength(30);
    for (const [id, ai] of Object.entries(M5_LOOP_TRIGGERS_AI)) {
      expect(REQUIRED_PAN_TRIGGERS, id).toContain(id);
      expect(triggers[id], id).toBeDefined();
      expect(triggers[id].ai, id).toBe(ai);
    }
    for (const id of Object.keys(FIRST_LINES)) expect(M5_LOOP_TRIGGERS_AI[id as keyof typeof M5_LOOP_TRIGGERS_AI], id).toBe('never');
    expect(Object.entries(M5_LOOP_TRIGGERS_AI).filter(([, ai]) => ai === 'never').map(([id]) => id).sort()).toEqual(Object.keys(FIRST_LINES).sort());
  });

  it.each(Object.entries(FIRST_LINES))('%s opens with its pinned line and has 3–6 distinct lines', (id, first) => {
    expect(lines(id)[0]).toBe(first);
    expect(lines(id).length, id).toBeGreaterThanOrEqual(3);
    expect(lines(id).length, id).toBeLessThanOrEqual(6);
    expect(new Set(lines(id)).size, `${id} repeats a line`).toBe(lines(id).length);
  });

  it('every ai: allowed M5 trigger ships 4–6 written lines (Ruling 21)', async () => {
    const { M5_LOOP_TRIGGERS_AI } = await import('./required');
    for (const [id, ai] of Object.entries(M5_LOOP_TRIGGERS_AI)) {
      if (ai !== 'allowed') continue;
      expect(lines(id).length, id).toBeGreaterThanOrEqual(4);
      expect(lines(id).length, id).toBeLessThanOrEqual(6);
    }
  });

  it.each(Object.keys(M5_VARS))('%s declares exactly its variables', (id) => {
    expect(Object.keys(triggers[id].vars ?? {}).sort()).toEqual([...M5_VARS[id]].sort());
    // An ai: never line uses every declared variable, so no read-back is missing its content.
    if (triggers[id].ai === 'never') {
      for (const line of lines(id)) {
        const used = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        expect(new Set(used), line).toEqual(new Set(M5_VARS[id]));
      }
    }
  });

  it('declares no variables for the M5 triggers without any', async () => {
    const { M5_LOOP_TRIGGERS_AI } = await import('./required');
    for (const id of Object.keys(M5_LOOP_TRIGGERS_AI).filter((t) => !(t in M5_VARS))) expect(triggers[id].vars, id).toBeUndefined();
  });

  it('read-backs claim nothing before the tap', () => {
    for (const id of ['plan.readback', 'margin.readback']) {
      for (const line of lines(id)) expect(line, id).not.toMatch(/\b(saved|filed|logged|stamped|kept|on file)\b/i);
    }
  });

  it('says the compost line as one line, and "just me" gets equal warmth', () => {
    expect(lines('rescue.compost')).toContain('Compost counts. The worms send their thanks.');
    expect(lines('cooked_for.alone')).toContain("Feeding yourself counts. It's the first person on the list.");
  });

  it("'not this week' is a full answer, and a refresher is an invitation, never a warning", () => {
    for (const line of lines('one_more.offer')) expect(line, line).not.toMatch(/\b(must|should|need to|before it|lose|losing|fading|rusty)\b/i);
    for (const line of lines('one_more.refresh')) expect(line, line).not.toMatch(/\b(fading|rusty|losing|lose|warning|before it's gone|slipping)\b/i);
    for (const line of lines('one_more.declined')) expect(line, line).not.toMatch(/\b(shame|pity|sadly|missed|next time)\b/i);
  });

  it('quest.recognize never says one kitchen\'s dish is a version of another\'s', () => {
    for (const line of lines('quest.recognize')) expect(line).not.toMatch(/\bversions? of\b|\bsame as\b|\blike (?:a|the) [a-z]+ (?:dish|recipe)\b/i);
  });

  it('rewrites the lines the rulings contradict (C30): stamps buy nothing, introductions open no country, techniques have tiers', () => {
    // The `when` texts are writer-only and dropped from the bundle; build/content/compile.test.ts pins them.
    for (const line of lines('stamp_earned')) expect(line).not.toMatch(/\b(spend|spent|buy|hat)\b/i);
    for (const line of lines('introduction_received')) expect(line).not.toMatch(/new country|new pin|opening/i);
    for (const line of lines('skill_up')) expect(line).not.toMatch(/\blevel\b/i);
    expect(triggers.skill_up.vars).toEqual({ technique: expect.any(String) });
  });
});

describe('M5 Step 4: the Bureau forms', () => {
  const { forms, stamp_names: stampNames, stamps } = content.bureau;
  const keys = (id: string) => forms[id].fields.map((f) => f.key);

  it('7-W gains days, hard_week and one_more; 12-M gains stall, for_dish and general_stall', () => {
    expect(forms.plan.number).toBe('7-W');
    expect(keys('plan')).toEqual(expect.arrayContaining(['days', 'hard_week', 'one_more']));
    expect(forms.market_list.number).toBe('12-M');
    expect(keys('market_list')).toEqual(expect.arrayContaining(['stall', 'for_dish', 'general_stall']));
  });

  it.each([
    ['margin_note', '2-M/MARGIN'],
    ['cooked_for', '5-S/SHARED TABLE'],
    ['technique_certificate', '51-T'],
    ['frame', '8-F/FRAME'],
  ])('has the new form %s (%s) with a stamp the Bureau defines', (id, number) => {
    expect(forms[id].number).toBe(number);
    expect(forms[id].stamp in stamps).toBe(true);
    for (const note of forms[id].footnotes ?? []) expect(note).toMatch(/^\*/);
  });

  it('the margin note is a plain safety form (health data, Ruling 9); Shared Table asks for no names', () => {
    expect(forms.margin_note.safety).toBe(true);
    expect(forms.margin_note.title_aside).toBeUndefined();
    expect(forms.cooked_for.fields.map((f) => f.hint ?? '').join(' ')).toMatch(/No names/);
  });

  it('names every StampId (C13)', () => {
    for (const id of ['quest_done', 'certificate', 'market_run']) expect(stampNames[id], id).toMatch(/\w/);
  });
});

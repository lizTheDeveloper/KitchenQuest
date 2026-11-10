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

  it('never claims a write in lines that run before any stamp', () => {
    const claim = /\bI(?:'ve| have) (written|saved|filed|logged|stamped|inked)\b|\bsaved it\b/i;
    for (const id of ['write.not_done', 'rule.severity_unclear', 'rule.which_one', 'rule.tap_needed', 'confirm.tap_card', 'consent.health_first', 'rule.unknown_term']) {
      for (const line of lines(id)) expect(line, id).not.toMatch(claim);
    }
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

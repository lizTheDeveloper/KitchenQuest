// M7 Step 1 (Ruling 9, Step 10): cook-mode commands, a whole-utterance closed grammar. Anything more is not a command.
import { describe, expect, test } from 'vitest';
import { cookCommand, type CookCommand } from './commands';

describe('cookCommand', () => {
  test.each([
    ['next', 'next'],
    ['next step please', 'next'],
    ['go back', 'back'],
    ['say that again', 'repeat'],
    ['what do I need', 'ingredients'],
    ['start the timer', 'timer_start'],
    ['stop the timer', 'timer_stop'],
    ['stop listening', 'stop_listening'],
  ] as [string, CookCommand][])('"%s" → %s', (said, command) => {
    expect(cookCommand(said)).toBe(command);
  });

  test('case, punctuation, a leading "okay" or "Pan" and a trailing "please" or "thanks" do not matter', () => {
    expect(cookCommand('Next!')).toBe('next');
    expect(cookCommand('  OK, next step.  ')).toBe('next');
    expect(cookCommand('Pan, go back please')).toBe('back');
    expect(cookCommand('Repeat that, thanks')).toBe('repeat');
    expect(cookCommand('what do i need?')).toBe('ingredients');
  });

  test('"next add the peanuts" → null', () => {
    for (const t of ['next add the peanuts', 'stop', 'back of the spoon', 'the timer', 'I need eggs', '', 'next next']) expect(cookCommand(t), t).toBeNull();
  });
});

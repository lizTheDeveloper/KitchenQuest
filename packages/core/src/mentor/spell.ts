import { capText } from './intents';

const LETTER = /\p{L}/u;

/**
 * An ingredient spelled out for a severe read-back: 'peanut' → 'P-E-A-N-U-T', 'tree nut' →
 * 'T-R-E-E N-U-T'. Letters are upper-cased (`en` locale); anything that isn't a letter is dropped.
 */
export function spell(name: string): string {
  return capText(name)
    .normalize('NFC')
    .split(/\s+/)
    .map((word) =>
      [...word]
        .filter((ch) => LETTER.test(ch))
        .map((ch) => ch.toLocaleUpperCase('en'))
        .join('-'),
    )
    .filter((word) => word !== '')
    .join(' ');
}

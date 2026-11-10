import { h } from '../ui/dom';
import { registerScreen, type Screen } from './app';
import type { Route } from './router';

const placeholder = (title: string): (() => Screen) => () => ({
  title,
  mount(el) { el.append(h('h1', null, title)); },
});

/** Each of these is replaced by its own task's screen. */
export function registerPlaceholderScreens(): void {
  const names: [Route['name'], string][] = [
    ['kitchen', 'Kitchen'], ['map', 'Map'], ['visit', 'Visit'], ['recipes', 'Recipes'], ['recipe', 'Recipe'], ['cook', 'Cook'],
    ['rules', 'Your rules'], // replaced by the rules screen (M4 Step 11, rules/rules-screen.ts)
  ];
  for (const [name, title] of names) registerScreen(name, placeholder(title));
}

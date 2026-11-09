import { RecipeError } from './types';
import type { ParsedRecipe, RecipeStep, StepItem } from './types';

function itemText(recipe: ParsedRecipe, item: StepItem): string {
  switch (item.type) {
    case 'text':
      return item.value;
    case 'cookware':
      return item.name;
    case 'ingredient': {
      const ingredient = recipe.ingredients[item.index];
      if (!ingredient) throw new RecipeError([`step refers to missing ingredient ${item.index + 1}`]);
      return ingredient.displayName ?? ingredient.name;
    }
    case 'timer': {
      const timer = recipe.timers[item.index];
      if (!timer) throw new RecipeError([`step refers to missing timer ${item.index + 1}`]);
      const length = [timer.quantity, timer.unit].filter((p) => p !== null).join(' ');
      return timer.name ? `(${timer.name}: ${length})` : `(${length})`;
    }
  }
}

/** One step as a single line of plain text, for screen readers and previews. */
export function stepPlainText(recipe: ParsedRecipe, step: RecipeStep): string {
  return step.items.map((item) => itemText(recipe, item)).join('').replace(/\s+/g, ' ').trim();
}

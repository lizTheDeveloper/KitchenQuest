// Browser-safe entry: everything in index.ts except parseRecipe, so nothing here pulls in the
// Cooklang WASM. Keep it that way: never import the recipe parser here.
export { CORE_VERSION } from './version';
export * from './recipe/types';
export { timerSeconds } from './recipe/timers';
export { stepPlainText } from './recipe/steps';
export * from './toolkit/toolkit';
export * from './ingredients/types';
export { IngredientGraph } from './ingredients/graph';
export * from './rules/types';
export { validateRules, isActive, isValidDate } from './rules/active';
export { check, DISCLAIMER, validateSubstitutions } from './rules/check';
export type { CheckStatus, Substitution, Finding, CheckResult } from './rules/check';
export { toGrams } from './nutrition/units';
export { nutritionPerServing } from './nutrition/compute';
export type { NutritionResult } from './nutrition/compute';

export type RecipeStatus = 'draft' | 'reviewed';

export interface RecipeMeta {
  title: string;
  country: string;
  region: string;
  credit: string;
  cook: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  skills: string[];
  servings: number;
  license: string;
  status: RecipeStatus;
  sacred: boolean;
}

export interface RecipeIngredient {
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
}

export interface RecipeTimer {
  name: string | null;
  quantity: number | null;
  unit: string | null;
}

export interface ParsedRecipe {
  meta: RecipeMeta;
  ingredients: RecipeIngredient[];
  timers: RecipeTimer[];
  source: string;
}

export class RecipeError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Invalid recipe: ${problems.join('; ')}`);
    this.name = 'RecipeError';
    this.problems = problems;
  }
}

export type Nutrient =
  | 'energy_kcal'
  | 'protein_g'
  | 'fat_g'
  | 'carb_g'
  | 'fiber_g'
  | 'sugars_g'
  | 'sodium_mg';

export interface IngredientNode {
  id: string; // snake_case, unique
  name: string;
  aliases?: string[];
  isA?: string[]; // e.g. cashew -> ['tree_nut']
  contains?: string[]; // e.g. soy_sauce -> ['wheat', 'soy']
  labelDependent?: boolean; // store-bought compound; contents vary by brand
  per100g?: Partial<Record<Nutrient, number>>;
  densityGPerMl?: number; // for volume units
  gramsPerUnit?: number; // for unitless counts ("2 eggs")
  defaultGrams?: number; // for "to taste" / no quantity
  fdcId?: number; // USDA FoodData Central id (provenance)
}

export interface IngredientData {
  ingredients: IngredientNode[];
}

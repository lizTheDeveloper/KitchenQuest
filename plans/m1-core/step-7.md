# Step 7 — Seed data, canon recipes, canon validation

**Files:**
- Create: `data/ingredients.json` (shape `IngredientData`), `data/substitutions.json` (shape `Substitution[]`)
- Create: `recipes/LICENSE`, `recipes/CONTRIBUTING.md`, `recipes/india/kerala/parippu.cook`, `recipes/mexico/oaxaca/frijoles-de-olla.cook`, `recipes/japan/osaka/onigiri.cook`
- Create: `packages/core/test/canon.test.ts`

**Interfaces:**
- Consumes: `parseRecipe` (Step 2), `IngredientGraph` (Step 3), `check`, `Substitution` (Step 5), `nutritionPerServing` (Step 6).

- [ ] **7.1 Recipes.** Port the three Cooklang recipes from `prototype/quest.html` (search for the `.cook` text blocks) into the files above. Front matter per Global Constraints, `status: draft`, `license: CC-BY-SA-4.0`, `credit` naming the community ("Home cooks of Kochi, Kerala", etc.). Keep the prototype's quantities. They're plausible but unreviewed, which is what `draft` means.
- [ ] **7.2 License and contributing.** `recipes/LICENSE`: the official CC BY-SA 4.0 legal code text from `https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt`. `CONTRIBUTING.md`: file layout (`recipes/<country>/<region>/<slug>.cook`), required front matter, the review rule (a reviewer from that cuisine's community before `reviewed`), crediting, `sacred: true` meaning, and that imports from other people's posts can't be contributed without the author's permission (spec §10).
- [ ] **7.3 Seed data.** One `IngredientNode` per ingredient used by the three recipes, plus the allergen and category nodes their rules need: `nut`, `tree_nut`, `peanut`, `coconut`, `milk`, `egg`, `wheat`, `gluten`, `soy`, `fish`, `shellfish`, `sesame`, `mustard`, `fodmap_fructan`, `allium`. Link onion and garlic `isA` `allium` and `fodmap_fructan`. Each food node gets `per100g` for all seven nutrients from USDA FoodData Central, with its `fdcId`, plus `densityGPerMl`, `gramsPerUnit` or `defaultGrams` where its recipes need them. Substitutions: at least `garlic → garlic_infused_oil`, `ghee → neutral_oil`, `lard → neutral_oil`, `bonito_flakes → shio_kombu`, `soy_sauce → tamari`, `soy_sauce → coconut_aminos`.
- [ ] **7.4 Write the canon test** `canon.test.ts` (loads `data/` and every `recipes/**/*.cook` with `fs`):
  - `graph data loads`: `IngredientGraph.fromData` doesn't throw.
  - `every canon recipe parses`: `parseRecipe` succeeds for each file.
  - `every canon ingredient resolves`: `check(recipe, [], graph, subs, '2026-11-09').findings` is `[]` for each recipe.
  - `canon metadata`: every recipe has `license === 'CC-BY-SA-4.0'` and a non-empty `credit`; the folder path's country matches `meta.country` (case-insensitive, hyphen = space).
  - `nutrition is complete`: for each recipe, `missing` is `[]` (salt-style defaults are allowed to make it `estimated`).
  - `coconut allergy blocks parippu`: a severe avoid rule on `coconut` makes `parippu.cook` `blocked` (grated coconut has no substitution), matching the prototype's behavior.
- [ ] **7.5 Run** `npm test`. Expected: PASS. Fix data, not the test, when it fails.
- [ ] **7.6 Commit** `feat: seed ingredient data, first three canon recipes, canon validation`

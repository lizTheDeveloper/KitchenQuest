# Contributing to the Kitchen Quest recipe canon

The canon is an open library of home-cooking recipes. Every recipe is shared under
[CC BY-SA 4.0](LICENSE): anyone may cook, share and adapt it, as long as they credit it
and share their adaptations under the same license.

## File layout

One recipe per file, at `recipes/<country>/<region>/<slug>.cook`:

- `<country>` and `<region>` are lowercase, with hyphens for spaces
  (`recipes/new-zealand/otago/...`). The country folder must match the `country` field
  in the front matter.
- `<slug>` is the dish's name in lowercase with hyphens (`frijoles-de-olla.cook`).

Recipes are written in [Cooklang](https://cooklang.org/docs/spec/): `@ingredient{quantity%unit}`,
`#cookware{}`, `~{time%unit}`. Comments (`-- ...`) hold notes for the cook.

## Front matter

Every file starts with YAML front matter. These keys are required:

```yaml
---
title: Frijoles de Olla
country: Mexico
region: Oaxaca
credit: Drafted by Kitchen Quest editors from the home cooking of Oaxaca — awaiting community review
cook: dona-marisol         # the in-game cook who teaches it
difficulty: 1              # 1 (easiest) to 5
skills: [legumes, heat-control, patience]
servings: 6                # more than 0
license: CC-BY-SA-4.0      # always this value in the canon
status: draft              # draft | reviewed
sacred: false              # optional, defaults to false
---
```

## Writing ingredients

The allergy checker and the nutrition calculator read every ingredient, so they must be
able to understand each one:

- **Names** must match an entry in `data/ingredients.json`, by its name or one of its
  aliases. Plurals are fine (`shallots` finds `shallot`). If your ingredient is missing,
  add it in the same change, with its USDA FoodData Central nutrition and the allergen links
  it needs (`isA`, `contains`). Mark store-bought products whose contents vary by brand
  (soy sauce, tortillas, pappadam) as `labelDependent`.
- **Quantities** can be whole numbers, decimals or fractions (`@salt{3/4%tsp}`,
  `@sugar{1 1/2%tsp}`). For a range (`@chillies{1-2}`), nutrition and limits use the larger
  number, to stay on the safe side.
- **Units** are `g`, `kg`, `mg`, `oz`, `lb`, `ml`, `l`, `tsp`, `tbsp` or `cup`, or none for a
  count. Put other measures in the name: `@garlic cloves{2}`, `@epazote sprigs{2}`,
  `@nori sheets{2}`, not `@garlic{2%cloves}`.

`packages/core/test/canon.test.ts` checks all of this. Run `npm test` before you open a pull
request.

## Review

A recipe ships as `status: draft` until at least one reviewer **from that cuisine's
community** has cooked it and signed off. Only then can it become `status: reviewed`.
Drafts are playable in the game and labeled as drafts. A reviewer may change quantities,
steps and names. They are the authority on the dish.

## Credit

A draft's `credit` says where it came from without claiming the community's name: "Drafted by
Kitchen Quest editors from the home cooking of Kochi, Kerala — awaiting community review".
Once a reviewer from that community signs off, the credit can name the community and the people
who contributed or reviewed the recipe ("Home cooks of Kochi, Kerala; reviewed by ..."). Contributors
are credited in the game, on the cook's card.

## Sacred foods

`sacred: true` marks a ceremonial or sacred dish. It is kept out of the XP and photo loop and
is shown only as a story. A sacred recipe enters the canon only if a contributor from that
tradition approves it.

## Other people's recipes

Don't contribute a recipe copied or imported from someone else's post, video, blog or book.
Imports stay private to the player who imported them. One can enter the canon only through a
separate promotion flow, with the original author's permission and a review.

# Step 4 — Content pipeline: build-time load and validation, techniques data

Everything the game reads is compiled at build time into one virtual module, `virtual:kq-content`. That covers `content/**/*.yaml`, the canon `recipes/**/*.cook`, `data/ingredients.json`, `data/substitutions.json` and the new `data/techniques.yaml`. Recipes are parsed with core `parseRecipe` in Node, so no WASM reaches the browser. Any invalid file fails `vite build` and the dev server with a message naming the file.

**Files:**
- Create: `apps/game/src/content/types.ts` (extends the `BureauForm` from Step 3), `apps/game/src/content/required.ts`, `apps/game/src/content/index.ts`, `apps/game/src/virtual.d.ts`
- Create: `apps/game/build/content/read.ts`, `apps/game/build/content/schemas.ts`, `apps/game/build/content/compile.ts`, `apps/game/build/content/compile.test.ts`, `apps/game/build/content-plugin.ts`
- Create: `data/techniques.yaml`
- Modify: `recipes/india/kerala/parippu.cook` (`cook: leela`), `recipes/mexico/oaxaca/frijoles-de-olla.cook` (`cook: marisol`). Cook ids are the `content/cooks/<id>.yaml` file names. The recipes said `ammachi-leela` and `dona-marisol`.
- Modify: `content/dialogue/pan.yaml` (add the two triggers below), `content/README.md` (document `data/techniques.yaml` and the two triggers in one short paragraph), `apps/game/vite.config.ts` (add the plugin; `server.fs.allow: [repoRoot]`)

**Interfaces:**
- Produces:
```ts
// src/content/types.ts (field names as in content/README.md's schema)
export interface LineTrigger { ai: 'never' | 'allowed'; when: string; lines: string[]; vars?: Record<string, string>; notes?: string }
export interface LineBank { persona?: string[]; triggers: Record<string, LineTrigger> }
export interface CookFile { id: string; name: string; place: string; dish: string; recipe: string; persona: string[]; intro: string[]; story: string[]; quest: Quest; gift: string[]; trust_lines: Record<string, string[]>; reactions: { photo: string[]; skip_photo: string[] }; introduction: string[]; faq: Faq[] }
export interface StallFile { id: string; name: string; persona: string[]; triggers: Record<string, LineTrigger>; questions: StallQuestion[]; /* other keys passed through */ }
export interface BureauFile { forms: Record<string, BureauForm>; stamps: Record<string, string>; stamp_names: Record<string, string>; footnotes: { tag: string; text: string }[]; disclaimers: Record<string, string> }
export interface TechniqueData { freshness: FreshnessThresholds; techniques: { id: string; name: string }[] }
export interface GameContent {
  version: string;                          // first 12 hex of sha256 over all input files, sorted by path
  pan: LineBank; cooks: Record<string, CookFile>; stalls: Record<string, StallFile>; bureau: BureauFile;
  recipes: Record<string, ParsedRecipe>;    // slug ('india/kerala/parippu') → parsed, with steps
  ingredients: IngredientData; substitutions: Substitution[]; techniques: TechniqueData;
}
// src/content/required.ts
export const REQUIRED_PAN_TRIGGERS: readonly string[];   // the list below
// build/content/read.ts
export function readContentFiles(repoRoot: string): Record<string, string>;   // repo-relative path → text
// build/content/compile.ts
export class ContentError extends Error { problems: string[] }
export function compileContent(files: Record<string, string>): GameContent;  // throws ContentError with every problem, each prefixed by its path
// build/content-plugin.ts
export function kqContent(opts: { repoRoot: string }): Plugin;   // resolves 'virtual:kq-content'; addWatchFile for every input; ContentError → this.error(problems.join('\n'))
// src/content/index.ts (runtime)
export const content: GameContent;
export const graph: IngredientGraph;           // IngredientGraph.fromData(content.ingredients), built once
export function techniqueName(id: string): string;
```
- `REQUIRED_PAN_TRIGGERS`: `greet.first_ever`, `greet.morning`, `greet.afternoon`, `greet.evening`, `greet.late_night`, `greet.return_after_gap`, `cook.start`, `cook.step_quip`, `cook.timer_start`, `cook.timer_done`, `cook.done`, `travel.map_remark`, `travel.depart`, `ai_unavailable`, `thanks`, `intake.ios_home_screen`, `voice.not_yet`, `toolkit.rusty_invite`.
- The runtime imports from `@kitchenquest/core/engine` only. Build code may import `@kitchenquest/core`. If the default config loader can't import the workspace TypeScript package, switch the game's scripts to `vite --configLoader runner`.

**Checks `compileContent` performs** (each failure is one problem string):
- YAML parses (with the `yaml` package, strict), and each file matches its zod schema (`schemas.ts`). Unknown keys are allowed: writers add notes.
- Line banks: trigger ids match `^[a-z0-9_]+(\.[a-z0-9_]+)*$`. `ai` is `never` or `allowed`. `lines` is non-empty. Every `REQUIRED_PAN_TRIGGERS` id exists in `pan.yaml`.
- Recipes: every `.cook` parses with `parseRecipe` (the error names the path). Every timer passes `timerSeconds`. `meta.cook` is a cook id. Every `meta.skills` entry is a technique id.
- Cooks: the file name equals `id`, and `recipe` exists. `quest.cook` equals `id`. `quest.unlock.requires` names existing quest ids. A `cook` step's `recipe` exists. An `errand`'s `stall` is a stall id. A `riddle` has exactly one `correct: true` and every option has a `reaction`. A `drill`'s `skill` is a technique id. `trust_lines` keys lie in 1–5.
- Stalls: every question has 3–4 options with exactly one `correct: true`. This also applies to `variants.*.questions`.
- Bureau: `forms.travel` and `forms.certificate` exist. Every form's `stamp` is a key of `stamps`. Footnote tags lie in `any | empty | loading | market | kitchen | map | ledger | settings`.
- Data: `IngredientGraph.fromData` succeeds, `validateSubstitutions` returns `[]`, and `validateThresholds` returns `[]`. Technique ids are unique.
- The line-count guidance in `content/README.md` ("6+ photo reactions" and the like) is writer guidance and is **not** enforced.

**`data/techniques.yaml`** (CC BY-SA like `content/`; the thresholds are spec §17's "about 6 weeks" and "about 4 months"):
```yaml
# Technique Toolkit data (spec §17). Thresholds are tunable here, not in code.
freshness: { warm_after_days: 42, rusty_after_days: 120 }
techniques:
  - { id: legumes, name: "Legumes" }
  - { id: heat-control, name: "Heat control" }
  - { id: tempering, name: "Tempering" }
  - { id: grains, name: "Grains" }
  - { id: shaping, name: "Shaping" }
  - { id: patience, name: "Patience" }
  - { id: knife, name: "Knife skills" }
```
Add any further drill skill ids the real content uses. The compile test against the real repo will list them.

**New Pan triggers** (writer review welcome; plain, no jokes about anything but the Pan):
```yaml
  voice.not_yet:
    ai: never
    when: The player uses hold-to-talk before live voice exists. Removed when the voice milestone ships.
    lines:
      - "I can't hear you yet. The Bureau is still fitting my ears. Type to me instead, or tap a button."
      - "Nothing came through. Voice arrives in a later delivery. The text box works now."
      - "Hold-to-talk is fitted but not yet connected. I'm a pan; I'm good at waiting. Type in the meantime."
  toolkit.rusty_invite:
    ai: allowed
    when: Shown beside a Rusty technique on the knife roll. An invitation, never a warning (spec §17).
    vars:
      technique: "the technique's name, e.g. 'Tempering'"
    notes: "No guilt, no urgency, no numbers. The technique is still the player's."
    lines:
      - "Your {technique}'s gone a bit rusty. Fancy a refresher?"
      - "{technique} hasn't been out of the drawer in a while. Still yours. A refresher, some evening?"
      - "{technique}: a little rusty, still yours. One dish would sharpen it right up."
```

- [ ] **4.1 Tests** (`compile.test.ts`; fixtures are in-memory `files` maps built from a minimal valid set):
  - `compileContent(readContentFiles(repoRoot))` succeeds on the real repo. Its recipes keys are exactly `['india/kerala/parippu','japan/osaka/onigiri','mexico/oaxaca/frijoles-de-olla']`. `techniques.freshness` deep-equals `{ warmAfterDays: 42, rustyAfterDays: 120 }`. Every recipe has `steps.length > 0`.
  - Each check in the list above has one failing fixture whose problem string contains the file path and the offending value. Examples: `recipes/x/y/z.cook` with `cook: nobody` → contains `nobody`; a riddle with two correct options → contains `exactly one`; a recipe timer `~{5}` → contains `timer`; `pan.yaml` missing `cook.start` → contains `cook.start`; `warm_after_days: 200` → a threshold problem.
  - Several problems in different files are all reported in one `ContentError`, not just the first.
  - `version` changes when any input byte changes, and is stable when the input is unchanged.
- [ ] **4.2 Run** `npm test -w @kitchenquest/game -- build/content` → FAIL.
- [ ] **4.3 Implement** schemas, compile, read, the plugin, runtime `content/index.ts`, the data file, the recipe `cook:` fixes and the new triggers. If the real content fails a check for a reason other than the two known cook ids, fix it only when it is an obvious typo. Otherwise stop and report it. Never loosen a check to make real content pass.
- [ ] **4.4 Run** `npm test -w @kitchenquest/game && npm run build -w @kitchenquest/game` → PASS. Then break a copy of `content/dialogue/pan.yaml` locally: `vite build` must fail with the path in the message. Restore it.
- [ ] **4.5 Commit** `feat(game): build-time content compile and validation; techniques data`

// The drill-first hint (M6 Ruling 16, closing M5 Ruling 4's "suggests the drill first"): advisory only. When a skill of
// the recipe has a prereq the player hasn't reached Seen in, and a cook's quest has a drill step that teaches that
// prereq, the recipe and cook screens say `cook.drill_first` beside the Cook button with a chip to that cook. Cook
// stays enabled and nothing is gated. Nothing shows in Family Table or for a sacred dish. Game-side on purpose: only the
// game uses it, and core `toolkit/` is eval-hashed (Ruling 22).
import type { ParsedRecipe, Quest, TechniqueNode, ToolkitState } from '@kitchenquest/core/engine';
import { content, techniqueName } from '../content';
import { routeHref } from '../shell/router';
import { h } from '../ui/dom';
import { writtenLine } from '../week/plan-view';

/** A technique the player has reached at least Seen in. */
const seen = (toolkit: ToolkitState, id: string): boolean => Object.hasOwn(toolkit.techniques, id);

/**
 * The first skill of the recipe (in the recipe's own order) with a prereq below Seen that some quest's drill step
 * teaches (the first such prereq, then the first quest in `quests` order): that prereq, the drill's cook and the
 * quest. Null when none, or for a sacred dish.
 */
export function drillFirstFor(recipe: ParsedRecipe, toolkit: ToolkitState, techniques: TechniqueNode[], quests: Quest[]): { technique: string; cook: string; questId: string } | null {
  if (recipe.meta.sacred) return null;
  for (const skill of recipe.meta.skills) {
    const node = techniques.find((t) => t.id === skill);
    for (const pre of node?.prereqs ?? []) {
      if (seen(toolkit, pre)) continue;
      const quest = quests.find((q) => q.steps.some((s) => s.type === 'drill' && s.skill === pre));
      if (quest !== undefined) return { technique: pre, cook: quest.cook, questId: quest.id };
    }
  }
  return null;
}

/**
 * The hint as an element: the line, and a chip that opens the cook's kitchen (`{ to: 'visit', cook }`). Never a
 * warning style, never a ❗; the Cook button beside it stays as it is.
 */
export function drillFirstEl(text: string, chip: { label: string; href: string }): HTMLElement {
  return h('div', { class: 'drill-first', role: 'note' },
    h('p', { class: 'drill-first-line', 'data-content': '' }, text),
    h('a', { class: 'btn btn-secondary drill-first-go', href: chip.href, 'data-content': '' }, chip.label));
}

/**
 * M6 Ruling 16: the drill-first hint for a dish, or null: none in Family Table, for a sacred dish, while the toolkit is
 * still loading, or when every prereq the cooks' drills teach is at Seen. Advisory only.
 */
export function drillFirstHint(slug: string, toolkit: ToolkitState | null, familyTable: boolean): HTMLElement | null {
  if (familyTable || toolkit === null || !Object.hasOwn(content.recipes, slug)) return null;
  const recipe = content.recipes[slug];
  const hint = drillFirstFor(recipe, toolkit, content.techniques.techniques, Object.values(content.cooks).map((c) => c.quest));
  if (hint === null || !Object.hasOwn(content.cooks, hint.cook)) return null;
  const cook = content.cooks[hint.cook].name;
  return drillFirstEl(writtenLine('cook.drill_first', { technique: techniqueName(hint.technique), cook }), {
    // The `go` chip `{ to: 'visit', cook }`, in nav.offer's words for that place (core navPlace: "{cook}'s kitchen").
    label: writtenLine('nav.offer', { place: `${cook}'s kitchen` }),
    href: routeHref({ name: 'visit', cookId: hint.cook }),
  });
}


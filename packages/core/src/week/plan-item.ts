// One item of a week's plan. A leaf module (no imports) so `mentor/cards.ts`'s `PlanCard` can name it without a
// cycle (week/plan → mentor/route → mentor/cards); `week/plan.ts` re-exports it.
export type PlanItem =
  | { day: number /* 0–6, offset from weekStart */; kind: 'dish'; slug: string; servings: number }
  | { day: number; kind: 'lesson'; slug: string }; // One More Technique's drill day (Step 2)

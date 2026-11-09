# Step 2b — Entitlements and usage metering (spec §16)

**Files:** Create `apps/api/src/entitlements/entitlements.ts` (+ test), `apps/api/src/usage/usage.ts` (+ test); new migration; modify `apps/api/src/db/schema.ts`.

**Tables:**
- `entitlements(id uuid pk, user_id → users cascade, kind text not null, source text not null, starts_at timestamptz not null, ends_at timestamptz null, created_at)`.
  - `kind` ∈ `guild`, `household_member`, `bursary`, `founding`, `seat_licence`, `accessibility_voice`.
  - `source` ∈ `stripe`, `manual`, `school`, `org`.
  - No price, payment details or card data are ever stored here.
- `usage_events(id bigserial pk, user_id → users cascade, feature text not null, units integer not null, cost_microusd integer not null, created_at)`.
  - `feature` ∈ `mentor_text`, `voice_stt`, `voice_tts`, `photo_reaction`, `ingest`.
  - No prompt, transcript or response content.

**Interfaces:**
```ts
export type EntitlementKind = 'guild'|'household_member'|'bursary'|'founding'|'seat_licence'|'accessibility_voice';
export async function activeEntitlements(db: Db, userId: string, now: Date): Promise<EntitlementKind[]>;
export async function grant(db: Db, userId: string, kind: EntitlementKind, source: string, startsAt: Date, endsAt?: Date): Promise<void>;
export async function recordUsage(db: Db, userId: string, feature: UsageFeature, units: number, costMicroUsd: number): Promise<void>;
export async function usageSince(db: Db, userId: string, feature: UsageFeature, since: Date): Promise<number>;  // sum of units
```
- `GET /me` gains `entitlements: EntitlementKind[]`.
- No route grants entitlements in M2. Payments come later; `grant` is used by tests and an admin script `npm run grant -w @kitchenquest/api -- <email> <kind> [days]`.

- [ ] **2b.1 Tests:**
  - `activeEntitlements` respects `starts_at` and `ends_at` (inclusive start, exclusive end) using the injected clock.
  - Deleting a user cascades both tables.
  - `usage_events` has no text column able to hold content: assert the column list exactly.
  - `usageSince` sums correctly across features.
- [ ] **2b.2 Run** → FAIL. **2b.3 Implement.** **2b.4 Run** → PASS.
- [ ] **2b.5 Commit** `feat(api): entitlements and content-free usage metering`

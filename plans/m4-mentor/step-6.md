# Step 6 — API: conversations, transcripts, proposals, notices

This step holds the storage the agent needs, and nothing more:
- Conversations: content-free rows.
- Transcripts: sealed per user (C-12). They are stored only with `health_data` consent; without it they are kept in memory only. They are kept 30 days and the player can clear them.
- Proposals: a sealed, short-lived record of each card the server showed. This is what Step 8's guard checks.

The consent notices change so that the words match what is now kept and sent.

**Files:**
- Create: `apps/api/src/mentor/constants.ts`, `apps/api/src/mentor/conversations.ts`, `apps/api/src/mentor/memory.ts`, `apps/api/src/mentor/proposals.ts`, generated migration `apps/api/drizzle/00NN_mentor.sql`
- Create: `docs/compliance/notices/health_data-v2.md`, `docs/compliance/notices/ai_health-v1.md`
- Modify:
  - `apps/api/src/db/schema.ts`
  - `apps/api/src/jobs/retention.ts`: register `messages`, `conversations` and `mentor_proposals`
  - `apps/api/src/consent/notices.ts`: `health_data` → `noticeFile('health_data', 'v2')`, `ai_health` → `noticeFile('ai_health', 'v1')`, `ACCEPTED_VERSIONS = { health_data: ['v2'], ai_health: ['v1'] }`
  - `apps/api/src/consent/health-data.ts`: `HEALTH_TABLES` += `messages` and `mentorProposals`
  - `apps/api/src/account/routes.ts`: export `conversations`, with messages decrypted, and `proposals`, decrypted, status only
  - `apps/api/test/architecture.test.ts`: health lists += `messages`, `mentorProposals` / `messages`, `mentor_proposals`
  - `apps/api/test/consent.test.ts` and any test hard-coding `'v1'` for health_data: use `NOTICES.health_data.version`
  - `docs/compliance/data-inventory.md`: I-1, I-4, I-7 rows and §6 columns
- Test: `apps/api/test/mentor-store.test.ts`, extend `apps/api/test/retention.test.ts`, `apps/api/test/account.test.ts`, `apps/api/test/consent.test.ts`

**Tables:**
- `conversations(id uuid pk, user_id → users cascade, started_at, last_turn_at, turn_seq integer not null default 0)`. No content.
- `messages(id uuid pk, conversation_id → conversations cascade, user_id → users cascade, seq integer not null, role text check in ('player','pan'), sealed bytea not null, created_at)`, unique `(conversation_id, seq)`. Seal context is `{ table: 'messages', userId, rowId }`. The value is `StoredMessage` (below).
- `mentor_proposals(id uuid pk, user_id → users cascade, conversation_id → conversations on delete set null, turn_seq integer, kind text check in ProposalKind, severe boolean not null, status text check in ('open','confirmed','rejected','expired','undone'), sealed bytea not null, undo_sealed bytea null, write_ref uuid null, channel text null check in ('tap','typed_yes'), created_at, expires_at, decided_at null)`. Seal context is `{ table: 'mentor_proposals', userId, rowId }` for `sealed` (the `ProposalCard`) and `{ table: 'mentor_proposals.undo', userId, rowId }` for `undo_sealed`.

**Interfaces:**
- Consumes: `ProposalCard`, `ServerCard`, `ReplyPart` (Step 1); `sealFor`/`openFor`, `registerRetention`, `hasConsent` (M2).
- Produces:
```ts
// mentor/constants.ts — the Global Constraints values, exported (PROPOSAL_TTL_MS, UNDO_WINDOW_MS, TRANSCRIPT_RETENTION_DAYS, HISTORY_MESSAGES, MEMORY_TTL_MS, CONVERSATION_IDLE_MS, TURNS_PER_MINUTE, FREE_AI_TURNS_PER_DAY, GUILD_AI_TURNS_PER_DAY, MAX_TEXT)
// mentor/conversations.ts
export type StoredMessage = { role: 'player'; text: string } | { role: 'pan'; parts: ReplyPart[]; proposalIds: string[] };
/** The caller's conversation when `id` is theirs and its last turn was within CONVERSATION_IDLE_MS, else a new one. Never another user's. */
export async function openConversation(tx: Tx, userId: string, id: string | null, now: Date): Promise<{ id: string; turnSeq: number }>;
export async function bumpTurn(tx: Tx, conversationId: string, now: Date): Promise<number>;   // turn_seq + 1, last_turn_at = now
/** Persists only when `persist` (health_data consent); otherwise writes to `memory`. */
export async function appendMessages(tx: Tx, keyring: Keyring, memory: MemoryHistory, userId: string, conversationId: string, msgs: StoredMessage[], persist: boolean, now: Date): Promise<void>;
export async function recentMessages(db: Db | Tx, keyring: Keyring, memory: MemoryHistory, userId: string, conversationId: string, persist: boolean, now: Date): Promise<StoredMessage[]>;   // last HISTORY_MESSAGES, oldest first
export async function forgetConversations(tx: Tx, memory: MemoryHistory, userId: string, conversationId?: string): Promise<number>;   // deletes rows and memory; returns conversations removed
// mentor/memory.ts (in-process only; N-2 style; never on disk)
export class MemoryHistory {
  constructor(opts: { ttlMs: number; max: number });
  get(key: string, nowMs: number): StoredMessage[];
  push(key: string, msgs: StoredMessage[], nowMs: number): void;
  delete(keyPrefix: string): void;          // key = `${userId}:${conversationId}`; prefix `${userId}:` forgets all of a user's
  sweep(nowMs: number): void;               // wired to sweepPeriodically
}
export class MemoryFlags {                  // e.g. conversations where a child spoke (Step 7); in memory only, never stored (§19)
  constructor(opts: { ttlMs: number });
  has(key: string, nowMs: number): boolean;
  add(key: string, nowMs: number): void;
  sweep(nowMs: number): void;
}
// mentor/proposals.ts
export interface LoadedProposal { id: string; userId: string; conversationId: string | null; turnSeq: number | null; kind: ProposalKind; severe: boolean;
  status: 'open' | 'confirmed' | 'rejected' | 'expired' | 'undone'; card: ProposalCard; expiresAt: Date; decidedAt: Date | null; writeRef: string | null; undo: unknown | null }
export async function createProposal(tx: Tx, keyring: Keyring, p: { userId: string; conversationId: string | null; turnSeq: number | null; card: ProposalCard }, now: Date): Promise<ServerCard>;
export async function lockProposal(tx: Tx, keyring: Keyring, userId: string, id: string, now: Date): Promise<LoadedProposal | null>;   // FOR UPDATE; null when not theirs; an open one past expires_at reads as 'expired' (and is updated so)
export async function openProposalsOfTurn(tx: Tx, keyring: Keyring, userId: string, conversationId: string, turnSeq: number, now: Date): Promise<LoadedProposal[]>;
export async function markDecided(tx: Tx, id: string, status: 'confirmed' | 'rejected' | 'undone', channel: 'tap' | 'typed_yes' | null, writeRef: string | null, undo: unknown | null, keyring: Keyring, userId: string, now: Date): Promise<void>;
```
- Retention (C-6, C-12):
  - `messages`: delete where `created_at < now − 30 days`.
  - `conversations`: delete where `last_turn_at < now − 30 days`.
  - `mentor_proposals`: delete where `created_at < now − 24 hours` (well past `PROPOSAL_TTL_MS` and `UNDO_WINDOW_MS`).
- Notice texts. Each file has the same structure as `health_data-v1.md`, `Status: DRAFT wording, pending lawyer review (C-30)` and its declared SHA-256. Text between the markers:
  - `health_data-v2` (replaces v1; v1 grants stop counting; there are no real users yet): "Kitchen Quest can store your allergies, intolerances and diet rules, so it can check recipes for you. This covers rules you keep for religious or cultural reasons, such as halal, kosher, Jain, vegetarian or fasting rules, as well as rules for your health. It also keeps the meals you log, and your conversations with the Pan for 30 days unless you clear them sooner. Later it can also store your food journeys and symptoms. This is health information, and a religious or cultural diet can also show your beliefs. We encrypt it, never sell it, never use it for ads, and never share it with an employer, school or insurer. You can withdraw this at any time, and you can play without it."
  - `ai_health-v1` (replaces the inline `2026-11-09` text): "Let the Pan and the cooks, who are AI characters, see your allergies, diet rules and what you tell them about your meals, so their help fits you. Only what a reply needs is sent, without your email or name, to an AI provider that may not keep it or train on it. Without this, the Pan still works: allergies and meals are handled by the Bureau's written script, and every suggestion is still checked against your rules on our side."

- [ ] **6.1 Write the failing tests:**
```ts
test('messages are stored sealed only with health_data consent', async () => {
  // consenting user: appendMessages(persist=true) → messages rows exist, raw sealed has no 'peanut'
  // non-consenting user: persist=false → 0 messages rows; recentMessages returns them from memory
});
test('memory history expires after MEMORY_TTL_MS and is capped at HISTORY_MESSAGES', ...);
test('openConversation never returns another user\'s conversation and starts fresh after CONVERSATION_IDLE_MS', ...);
test('forgetConversations removes rows and memory for the user only', ...);
test('retention: messages older than 30 days go, newer stay; proposals older than 24 h go', ...);   // injected clock
test('lockProposal: other user → null; past expires_at → status expired', ...);
test('proposal payload is sealed: no "peanut" in mentor_proposals.sealed', ...);
test('health_data v1 grants no longer count; v2 does', ...);   // hasConsent false for a v1 grant, needsReconsent lists health_data
test('notice files hash-check at boot', ...);                 // the existing consent.test.ts check covers both new files
test('withdraw health_data with delete removes messages and proposals', ...);
test('export lists conversations with decrypted messages; delete removes every mentor row', ...);
```
- [ ] **6.2 Run** `npm test -w @kitchenquest/api -- mentor-store retention account consent architecture inventory` → FAIL.
- [ ] **6.3 Implement.** Compute each notice's SHA-256 with the existing `noticeSha256` and write it into the file.
- [ ] **6.4 Run** `npm test -w @kitchenquest/api` → PASS.
- [ ] **6.5 Commit** `feat(api): sealed 30-day transcripts, memory-only without consent, sealed proposals; consent notices name them`

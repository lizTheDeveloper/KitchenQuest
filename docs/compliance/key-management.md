# Key management (C-2, C-3, C-4, C-5)

How Kitchen Quest protects health data at rest, and how the keys behind it are made, kept, rotated and retired. Code: `apps/api/src/crypto/` (`keyring.ts`, `userkeys.ts`, `seal.ts`), `apps/api/scripts/rekey.ts`, `apps/api/src/audit/audit.ts`.

## Design

```
DATA_KEYS ring key (env, active = DATA_KEY_ID)
  └─ wraps → user_keys.wrapped (one random 32-byte data key per user, bound to that user id)
                └─ seals → health columns (rules.sealed, later journeys, symptoms, meals, transcripts)
```

- **Algorithm:** AES-256-GCM with a random 96-bit IV per value, in the application. The database never sees plaintext health data or any key.
- **Envelope encryption (C-4):** each user has a data key, stored only wrapped by a ring key in `user_keys(user_id, key_id, wrapped)`. `key_id` names the ring key that wrapped it.
- **Context binding (C-3):** additional authenticated data is `header ∥ "kq/v1" ∥ table ∥ user_id ∥ row_id`, each part length-prefixed. A blob copied to another user's row, another row or another table fails to open. The row id is generated in the application before insert. The wrapped data key is bound to its user id in the same way, so swapping wrapped keys between users fails too.
- **Crypto-shredding (C-4):** deleting an account cascades to `user_keys`. Once that row is gone, every copy of the user's health data, in backups included, is unreadable even with the full ring. This is what makes "deleted from backups" true without rewriting backups, **provided backups of `user_keys` age out too** (backup retention, C-35: 30 days). A restored backup older than the deletion would bring the wrapped key back; restores must re-apply deletions logged since the backup (`audit_events` action `account.delete`, Step 7) before going live.
- **Purpose keys:** other secrets are derived from the active ring key with HKDF-SHA256 (`Keyring.derive(purpose)`), so the ring key itself only wraps data keys. Today: `audit-pseudonym` (below).

API (later steps rely on these names):

```ts
sealFor(db, keyring, { table, userId, rowId }, value): Promise<Buffer>   // creates the user's data key on first use
openFor<T>(db, keyring, { table, userId, rowId }, sealed): Promise<T>     // throws if the context differs or the key is gone
```

## Configuration

| Variable | Meaning |
|---|---|
| `DATA_KEYS` | The ring: `id:base64,id:base64` (or a JSON object `{"id":"base64"}`). Every key is 32 bytes. Ids are 1–64 of `A-Z a-z 0-9 _ -`. |
| `DATA_KEY_ID` | The active id: new data keys are wrapped with it. Must be in `DATA_KEYS`. |

Boot fails, naming the variable, if `DATA_KEYS` is missing or malformed, any key isn't 32 bytes, `DATA_KEY_ID` is missing or not in the ring, or the retired `DATA_KEY` is still set. Error messages name key ids, never key material. The `Keyring` object prints and serializes as `{activeId, ids}` only.

## Generation

```bash
echo "k$(date +%Y)a:$(openssl rand -base64 32)"
```

Generate on a trusted machine with a working CSPRNG. Name keys by year plus a letter so the active one is obvious. Never generate keys in CI, chat, tickets or a shared terminal.

## Storage

- **Not in the repository** (`.env` is gitignored; `.env.example` holds no key), **not in the database or its backups**, not in logs, GlitchTip, CI variables of forks, or container images.
- Production: the host's secret store or a root-only env file (`0600`) on the API host, outside the backup set of the database server. If the API and database share a host, exclude the env file from database backups explicitly.
- Local development and tests use throwaway keys only (`test/helpers/config.ts` holds a fixed test-only key).

## Escrow

Losing every copy of a ring key loses every user's health data. Keep **two** escrow copies of each live ring key, held so no single person can lose or misuse them:

1. A password-manager entry shared between the security owner (C-41) and one other named person, **and**
2. A sealed offline copy (printed or on an encrypted USB key) in a separate physical location.

Record in the incident log (C-32) who holds each copy. Escrow copies of a retired key are destroyed only after it has left the ring and the backup retention period (C-35) has passed, since a restore of an older backup may still need it to unwrap `user_keys`.

## Rotation

Rotate **annually**, and **immediately** when a key-holder leaves (C-42 offboarding) or a key may have been exposed.

1. Generate the new key (`k2027a`). Escrow it.
2. Deploy with both keys: `DATA_KEYS=k2026a:…,k2027a:…`, `DATA_KEY_ID=k2027a`. New users' data keys are wrapped with the new key; existing data still opens.
3. Run `npm run rekey -w @kitchenquest/api` with the same environment. It re-wraps every `user_keys` row not under the active key, in batches (`REKEY_BATCH_SIZE`, default 500), idempotently, prints `user_keys: N re-wrapped, M remaining`, exits non-zero if anything remains, and writes a `keys.rekey` audit event. Re-run until `0 remaining`. Health columns are not touched: they are sealed with per-user data keys, which do not change.
4. Deploy with the old key removed from `DATA_KEYS`.
5. After the backup retention period, destroy the old key's escrow copies.

Exposure of a ring key alone (without the database) reveals nothing. Exposure of a ring key **and** a database copy reveals that copy's data keys: rotate the ring, and treat it as a breach (C-32). Re-keying individual users' data keys (re-sealing their health rows) is not implemented; add it if a data key itself is ever suspected exposed.

## Audit log (C-5)

`audit_events` is content-free (no health content, email or token) and **append-only**:

- A trigger (`migrations/0004_audit_append_only.sql`, a custom migration) raises on every `UPDATE`, `DELETE` and `TRUNCATE`, for every role including the app's.
- Two maintenance functions are the only exceptions. Each sets a transaction-local flag (`kq.audit_pseudonymize`, `kq.audit_purge_before`) that the trigger checks, and the trigger still allows only the narrow change:
  - `audit_pseudonymize(user_id, pseudonym)` (account delete, C-8): replaces that user's id in `subject_user_id`/`actor_id` with `p:` + 64 hex. Every other column must be unchanged. The pseudonym is HMAC-SHA256 of the user id under `Keyring.derive('audit-pseudonym')`, so the database alone cannot link it back to the id; once the ring key it came from is retired, no one can.
  - `audit_purge_before(cutoff)` (retention, C-6): deletes rows older than the cutoff, clamped to the **database's** `now() - 24 months`, so a skewed or hostile app clock cannot delete younger rows.
- **Limit:** today the app connects as the table owner, so the trigger is the control and a compromised app could set the flag itself. It still could only swap a user id for a pseudonym-shaped value or delete rows over 24 months old. At launch (C-42) the app gets its own role: revoke `UPDATE, DELETE, TRUNCATE` on `audit_events` from it, keep `INSERT, SELECT`, and grant `EXECUTE` on the two functions (they are `SECURITY DEFINER`). A superuser can still disable triggers; operator database access is break-glass and logged (C-5).

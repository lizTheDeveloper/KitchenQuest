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
- **Pseudonym key:** `PSEUDONYM_KEY` is a separate 32-byte key used only to HMAC deleted users' ids in the audit log (below). It is not part of the ring and is **not rotated** with it, so a user's pseudonym is the same whenever it is computed.

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

| `PSEUDONYM_KEY` | 32 bytes, base64. HMAC key for audit-log pseudonyms (C-5). |

Boot fails, naming the variable, if `DATA_KEYS` is missing or malformed, any key isn't 32 bytes, `DATA_KEY_ID` is missing or not in the ring, `PSEUDONYM_KEY` is missing or not 32 bytes, or the retired `DATA_KEY` is still set. Errors about a `DATA_KEYS` entry name it by position ("entry 2"), never by its id or value, because a malformed entry (a bare key in the old `DATA_KEY` format, a swapped JSON pair) would otherwise print key material. The `Keyring` prints and serializes as `{activeId, ids}` only, and `PSEUDONYM_KEY` as `[secret]`.

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

Escrow `PSEUDONYM_KEY` the same way. Losing it only means new pseudonyms no longer match old ones; it does not lose data.

Record in the incident log (C-32) who holds each copy. Escrow copies of a retired key are destroyed only after it has left the ring and the backup retention period (C-35) has passed, since a restore of an older backup may still need it to unwrap `user_keys`.

## Rotation

Rotate **annually**, and **immediately** when a key-holder leaves (C-42 offboarding) or a key may have been exposed.

1. Generate the new key (`k2027a`). Escrow it.
2. Deploy with both keys: `DATA_KEYS=k2026a:…,k2027a:…`, `DATA_KEY_ID=k2027a`. New users' data keys are wrapped with the new key; existing data still opens.
3. Run `npm run rekey -w @kitchenquest/api` with the same environment. It re-wraps every `user_keys` row not under the active key, in batches (`REKEY_BATCH_SIZE`, default 500), idempotently, prints `user_keys: N re-wrapped, M remaining`, exits non-zero if anything remains, and always writes a `keys.rekey` audit event (target `active=<id> outcome=ok|incomplete|failed rewrapped=N remaining=M`), failed runs included. Re-run until `0 remaining`. Health columns are not touched: they are sealed with per-user data keys, which do not change.
4. Deploy with the old key removed from `DATA_KEYS`.
5. After the backup retention period, destroy the old key's escrow copies.

`PSEUDONYM_KEY` is not rotated on the annual schedule. Rotate it only if it is exposed: pseudonyms written afterwards won't match earlier ones, which is acceptable because each user is pseudonymized once.

Exposure of a ring key alone (without the database) reveals nothing. Exposure of a ring key **and** a database copy reveals that copy's data keys: rotate the ring, and treat it as a breach (C-32). Re-keying individual users' data keys (re-sealing their health rows) is not implemented; add it if a data key itself is ever suspected exposed.

## Audit log (C-5)

`audit_events` is content-free (no health content, email or token) and append-only by trigger. Migrations: `0004_audit_append_only.sql` and `0006_audit_pseudonymize_hardening.sql` (both custom).

- A trigger raises on every `UPDATE`, `DELETE` and `TRUNCATE`, whichever role runs them.
- Two maintenance functions are the only intended exceptions. `EXECUTE` on both is revoked from `PUBLIC`. Each sets transaction-local flags that the trigger checks, and even then the trigger allows only a narrow change:
  - `audit_pseudonymize(user_id uuid, pseudonym_key bytea)` (account delete, C-8). It refuses while a `users` row with that id exists, so Step 7 deletes the user first and then calls it **in the same transaction**. The function computes the pseudonym itself as `p:` + hex HMAC-SHA256(user id, key). The caller passes the key, never the pseudonym. The app sends `PSEUDONYM_KEY` as hex text (`decode(…, 'hex')`), so the key never appears as raw bytes in a driver or drizzle message. Errors are re-thrown without their parameters, and the log scrubber drops everything after drizzle's `params:`. The key is never stored in the database, so the database alone cannot link a pseudonym back to an id. Keep server-side parameter logging off for this statement (`log_statement` below `all`, no `auto_explain` parameter logging).
  - What the trigger checks for that update: the flagged id is a uuid with no `users` row; only that id is replaced in `subject_user_id`/`actor_id`; the new value is **equal to the pseudonym flag** the function set (`kq.audit_pseudonym`); and every other column is unchanged. The trigger does **not** recompute the HMAC (it has no key), so it cannot tell a pseudonym made with `PSEUDONYM_KEY` from one made with any other key. A non-uuid actor such as an operator name can never be rewritten.
  - **Caller-chosen key:** anyone with `EXECUTE` on `audit_pseudonymize` (today the app, as owner) can pass a key of their choosing. For ids that no longer belong to a user, they can therefore write a pseudonym under a key Kitchen Quest does not hold. That breaks linkability for that subject (the security trail stays, under an unknown pseudonym) but cannot touch live users' rows. It stays possible until C-42, when only a separate role holds `EXECUTE`.
  - `audit_purge_before(cutoff)` (retention, C-6) deletes rows older than the cutoff, clamped to the **database's** `now() - 24 months`, so a skewed app clock cannot delete younger rows.

**Threat model, today:** the app connects as the owner of `audit_events`. An owner can `ALTER TABLE … DISABLE TRIGGER`, drop the trigger, or replace the functions, so **the trigger protects against application bugs and mistakes, not against a compromised app or anyone holding the app's database credentials.** Tamper resistance against those needs the separate roles in C-42: a migration/owner role that holds the schema, and an app role with only `INSERT, SELECT` on `audit_events`, `EXECUTE` on the two SECURITY DEFINER functions, and no ownership. Until then, nothing makes the audit log tamper-evident against the app itself; shipping events off-host (C-32) would. A superuser can always bypass all of this; operator database access is break-glass and logged (C-5).

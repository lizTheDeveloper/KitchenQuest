/**
 * Namespaces (the first int4 key of `pg_advisory_xact_lock(classId, key)`)
 * for the API's transaction-scoped advisory locks. The second key is
 * `hashtext(...)` of the locked name, so two namespaces never share a lock,
 * whatever their names hash to. A hash collision inside one namespace only
 * serializes two unrelated writers; it never lets two writers of the same
 * name run together. Add a namespace here, never reuse a number.
 */
export const ADVISORY_LOCK = {
  /** `lockSignInEmail`: a sign-in email, lowercased. */
  signInEmail: 1,
  /** `lockUserRules`: one user's rule writes. */
  rules: 2,
  /** `lockUserPantry`: one user's pantry writes (taken after `rules`, before the consent row). */
  pantry: 3,
} as const;

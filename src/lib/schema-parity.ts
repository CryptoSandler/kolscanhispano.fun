/**
 * Whether a database has every migration this checkout carries.
 *
 * **The incident this closes is dated 2026-08-27 in `CLAUDE.md`.** The `preview`
 * database was five migrations behind, so every Preview deployment would have
 * met a schema it did not have — and nothing asked. It happened again in
 * miniature on 2026-09-02 (`scripts/schema-versions.mts` has that one: a route
 * answering `500` with `relation "listing_attempts" does not exist`, on a batch
 * whose suite was green).
 *
 * Both were the same shape: **the suite proves the schema is right in `tests`,
 * and says nothing about the other two databases.** A green suite is not
 * evidence about a database it never opened.
 *
 * The comparison is against the **migration files in the checkout**, not against
 * another database. `tests` is itself only a database that could be behind; the
 * directory is what both of them are supposed to have, so comparing to it is the
 * stronger question and it needs one connection instead of two.
 *
 * Pure, so the interesting half is testable with no database at all: the script
 * reads the two lists and this decides.
 */

/** `018_audit_append_only.sql` -> `018_audit_append_only`, the ledger's spelling. */
export function versionOf(filename: string): string {
  return filename.replace(/\.sql$/, "");
}

export type Parity =
  | { ok: true; applied: number }
  /** In the checkout, not in the database. The deploy would meet a missing table. */
  | { ok: false; missing: string[]; applied: number };

/**
 * **Only one direction is a failure**, and which one matters.
 *
 * A migration in the checkout that the database has not applied is the incident:
 * code ships expecting a column that is not there. The reverse — a database
 * carrying a version this checkout does not have — is an older branch looking at
 * a database a newer one already migrated, which is the normal state of every
 * feature branch and not a fault. Failing on it would make the check cry wolf
 * on every branch that is merely behind `main`, and a check that cries wolf is
 * a check people learn to re-run until it passes.
 */
export function schemaParity(files: string[], applied: string[]): Parity {
  const have = new Set(applied);
  const missing = files.map(versionOf).filter((version) => !have.has(version));
  return missing.length === 0
    ? { ok: true, applied: have.size }
    : { ok: false, missing, applied: have.size };
}

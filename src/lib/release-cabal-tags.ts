import { query } from "./db";

/**
 * Releases the tags of cabals that dissolved more than thirty days ago.
 *
 * **This function is the thirty days.** `migrations/016` explains why they could
 * not be a predicate: `WHERE dissolved_at > now() - INTERVAL '30 days'` on a
 * partial unique index is refused — `functions in index predicate must be marked
 * IMMUTABLE` — and Postgres is right to refuse it, because an index whose
 * membership changes with the clock is silently wrong the moment a row ages out
 * and nothing rebuilds it. So holding a tag is a fact in a column, and releasing
 * one is a write. This is that write.
 *
 * **Late is the safe direction, and the code is written to fail that way.** A
 * tag released a day late is an inconvenience; one released a day early is
 * somebody's identity handed to a stranger while they might still come back. So
 * the window is compared against `dissolved_at` in the database's own clock, and
 * a run that does not happen leaves every tag held.
 *
 * The cabal keeps its name, its members and its history. Only the three or four
 * letters go back into the namespace, which is the whole of what the owner's
 * decision released.
 */
export async function releaseCabalTags(): Promise<string[]> {
  const released = await query<{ tag: string }>(
    // **The CTE is not decoration.** `RETURNING tag` after `SET tag = NULL`
    // returns the *new* row, so it answered `[null]`: the count was right and
    // every value was gone. So the tags are read in a CTE that also takes the
    // row locks, and the update joins against it.
    //
    // `RETURNING OLD.tag` would say the same thing in one statement, and it
    // **arrived in Postgres 18** — this database could use it. Verified
    // 2026-09-04 with `SHOW server_version` against all three: production,
    // preview and tests are all on `18.6 (c5250a2)`.
    //
    // It stays a CTE anyway, and the reason is what this job is. It runs on a
    // cron, monthly-ish in effect, and its failure is silent and slow — a tag
    // not released looks exactly like a tag not yet due, and the log line would
    // read `released 0` either way. Six portable lines against three terse ones
    // is a bad trade for the one job standing between a dissolved cabal's tag
    // and whoever wants it next. Nothing else in this repository needs a
    // Postgres newer than 12, and this is not the place to start.
    //
    // If that reasoning stops holding, the swap is one statement: delete the
    // CTE and write `UPDATE cabal SET tag = NULL WHERE … RETURNING OLD.tag`.
    `WITH due AS (
       SELECT id, tag FROM cabal
        WHERE tag IS NOT NULL
          AND dissolved_at IS NOT NULL
          AND dissolved_at < now() - INTERVAL '30 days'
        FOR UPDATE
     )
     UPDATE cabal SET tag = NULL
       FROM due WHERE cabal.id = due.id
     RETURNING due.tag`,
  );
  return released.map((row) => row.tag);
}

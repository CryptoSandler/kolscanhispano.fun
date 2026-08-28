/**
 * Cron entry point for `pruneRateLimit` (see `../src/lib/rate-limit.ts`).
 *
 * Loads `.env.local` for a developer running this by hand; in CI the
 * workflow (`.github/workflows/recompute-dirty.yml`, second step) supplies
 * `DATABASE_URL`, `WALLET_ENC_KEY` and `WALLET_HMAC_KEY` directly as job
 * `env`, and `.env.local` does not exist there.
 *
 * It rides the recompute workflow rather than the parse one on purpose.
 * Parsing is the ingestion critical path -- a webhook payload becomes a
 * trade there and nothing revisits a parsed `raw_tx` row -- and a failure to
 * delete week-old rate-limit rows has no business standing between the two.
 * Within the recompute workflow it is the *second* step for the mirror of
 * the same reason: a prune that fails cannot then prevent a recompute.
 *
 * Takes the `withLock` advisory lock, under its own name, so a scheduled run
 * and a manual `workflow_dispatch` that overlap cannot both delete the same
 * rows -- see `lock.ts`. (Concurrent deletes of the same rows would be
 * harmless here, unlike the other two crons; the lock is kept anyway so that
 * a run that is somehow still going does not stack another connection on top
 * of itself, and so every cron in this repo has one shape.) The function
 * passed to `withLock` is nothing but a pool query, which is exactly the
 * shape `lock.ts`'s docstring requires: `withLock` holds its lock on its own
 * dedicated connection precisely so this call is free to use the shared pool
 * without deadlocking against it.
 *
 * "Did nothing" (another run already holds the lock) and "failed" are kept
 * distinguishable in both the exit code and the printed line: the former
 * prints its own message and returns 0, the latter prints the error and
 * returns 1. Neither path ever prints a secret -- nothing here touches
 * `DATABASE_URL`, `WALLET_ENC_KEY` or `WALLET_HMAC_KEY` directly, and every
 * error message this codebase throws is written to omit connection strings,
 * keys and payload values (see db.ts, lock.ts, rate-limit.ts).
 */
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { announceDatabaseTarget } from "../src/lib/db";
import { withLock } from "../src/lib/lock";
import { pruneRateLimit } from "../src/lib/rate-limit";

/**
 * Runs one prune cycle and resolves to the process exit code it implies.
 * Exported (rather than folded into the bottom-of-file shell) so the test
 * suite can call it in-process -- against the real dedicated lock connection
 * and the real shared pool, exactly as production runs it -- instead of
 * paying a subprocess's tsx-transform-and-reconnect cost for every property
 * under test. `process.exit` is deliberately never called in here: a test
 * importing this module runs inside the same worker as every other test in
 * the file, and calling it would kill that worker.
 */
export async function main(): Promise<number> {
  try {
    const deleted = await withLock("prune-rate-limit", () => pruneRateLimit());

    // `withLock<T>` returns `T | null`, using `null` as the sentinel for "the
    // lock was busy, `fn` never ran". That is unambiguous here only because
    // `pruneRateLimit` always resolves to a `number`, never to `null` itself
    // -- a property of *this* call site, not one `withLock`'s type enforces.
    // If a future `fn` passed to `withLock` could itself legitimately resolve
    // to `null`, this check would silently misreport a real (empty) result as
    // "did nothing", and `withLock` would need a result wrapper instead of a
    // bare nullable return.
    if (deleted === null) {
      console.log("prune-rate-limit: another run holds the lock; did nothing");
      return 0;
    }

    console.log(`prune-rate-limit: deleted ${deleted} rate_limit row(s)`);
    return 0;
  } catch (error) {
    console.error(`prune-rate-limit: failed -- ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Only when this file is the process entry point, not when a test imports
// it -- same guard scripts/seed-dev.ts already uses for the same reason.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Which database, before any work: see announceDatabaseTarget. Inside the
  // entry-point guard rather than at import, so a test that imports `main()`
  // stays quiet while a person or a cron running this file is told.
  announceDatabaseTarget();
  process.exit(await main());
}

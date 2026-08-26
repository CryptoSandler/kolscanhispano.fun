/**
 * Cron entry point for `parsePending` (see `../src/lib/parse-swap.ts`).
 *
 * Loads `.env.local` for a developer running this by hand; in CI the
 * workflow (`.github/workflows/parse-pending.yml`) supplies `DATABASE_URL`,
 * `WALLET_ENC_KEY` and `WALLET_HMAC_KEY` directly as job `env`, and
 * `.env.local` does not exist there.
 *
 * Takes the `withLock` advisory lock before calling `parsePending` so a
 * scheduled run and a manual `workflow_dispatch` that overlap in time cannot
 * both work the same `raw_tx` rows -- see `lock.ts`. The function passed to
 * `withLock` here is nothing but pool queries (via `parsePending`), which is
 * exactly the shape `lock.ts`'s docstring requires: `withLock` holds its
 * lock on its own dedicated connection precisely so this call is free to use
 * the shared pool without deadlocking against it.
 *
 * "Did nothing" (another run already holds the lock) and "failed" are kept
 * distinguishable in both the exit code and the printed line: the former
 * prints its own message and returns 0, the latter prints the error and
 * returns 1. Neither path ever prints a secret -- nothing here touches
 * `DATABASE_URL`, `WALLET_ENC_KEY` or `WALLET_HMAC_KEY` directly, and every
 * error message this codebase throws is written to omit connection strings,
 * keys and payload values (see db.ts, lock.ts, parse-swap.ts).
 */
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { withLock } from "../src/lib/lock";
import { parsePending } from "../src/lib/parse-swap";

/**
 * Runs one parse-pending cycle and resolves to the process exit code it
 * implies. Exported (rather than folded into the bottom-of-file shell) so
 * the test suite can call it in-process -- against the real dedicated lock
 * connection and the real shared pool, exactly as production runs it --
 * instead of paying a subprocess's tsx-transform-and-reconnect cost for
 * every property under test. `process.exit` is deliberately never called in
 * here: a test importing this module runs inside the same worker as every
 * other test in the file, and calling it would kill that worker.
 */
export async function main(): Promise<number> {
  try {
    const examined = await withLock("parse-pending", () => parsePending());

    // `withLock<T>` returns `T | null`, using `null` as the sentinel for "the
    // lock was busy, `fn` never ran". That is unambiguous here only because
    // `parsePending` always resolves to a `number`, never to `null` itself --
    // a property of *this* call site, not one `withLock`'s type enforces. If
    // a future `fn` passed to `withLock` could itself legitimately resolve to
    // `null`, this check would silently misreport a real (empty) result as
    // "did nothing", and `withLock` would need a result wrapper instead of a
    // bare nullable return.
    if (examined === null) {
      console.log("parse-pending: another run holds the lock; did nothing");
      return 0;
    }

    console.log(`parse-pending: examined ${examined} raw_tx row(s)`);
    return 0;
  } catch (error) {
    console.error(`parse-pending: failed -- ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Only when this file is the process entry point, not when a test imports
// it -- same guard scripts/seed-dev.ts already uses for the same reason.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}

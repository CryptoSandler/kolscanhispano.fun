/**
 * Cron entry point for `requeueNoRate` (see `../src/lib/parse-swap.ts`).
 *
 * Loads `.env.local` for a developer running this by hand; in CI the
 * workflow (`.github/workflows/parse-pending.yml`, second step) supplies
 * `DATABASE_URL` directly as step `env`, and `.env.local` does not exist
 * there.
 *
 * It runs **between** the `sol_price` fill and the parse, which is the only
 * position that does any good: it clears `parse_error` on the
 * `unsupported_quote_no_rate` rows whose block minute the fill has just given
 * a usable rate, and the parse behind it is what turns them into trades.
 * Behind the parse it would open rows nothing reads until the next cycle; in
 * front of the fill it would find the same minutes still empty.
 *
 * **Why this file exists at all, given the work is one statement.** The
 * design round that shaped the requeue said "no new script", and it meant no
 * lock and no cron of its own -- not "no way to test it". The step was
 * briefly an inline `npx tsx --eval` in the workflow, which no test in this
 * repo can execute: it would have been covered by a string match on the YAML
 * and nothing else, which is the exact shape of defect this project has
 * shipped twice (a column written and never read, a module built and never
 * called), both times found by a reader rather than by a test. A file with a
 * `main()` can be run in-process by a test and as a real subprocess by one
 * more; the statement itself is untouched and still lives in `parse-swap.ts`
 * beside `parsePending`.
 *
 * Takes the `withLock` advisory lock, under its own name, so a scheduled run
 * and a manual `workflow_dispatch` that overlap cannot both work the same
 * rows -- see `lock.ts`. (Concurrent runs would be harmless here, as they are
 * for `prune-rate-limit`: `requeueNoRate` is a single idempotent statement
 * whose predicate stops matching once it has run, and it touches only rows
 * the parse's own pending query excludes. The lock is kept anyway, for the
 * same two reasons that one keeps it -- a run that is somehow still going
 * does not stack another connection on top of itself, and every cron in this
 * repo has one shape. Do not remove it on the grounds that the statement is
 * safe without it; that was already considered.) Its own name, not
 * `parse-pending`'s: sharing that lock would make this step able to be
 * skipped by a parse that is still running, when the two do not contend at
 * all.
 *
 * "Did nothing" (another run already holds the lock) and "failed" are kept
 * distinguishable in both the exit code and the printed line: the former
 * prints its own message and returns 0, the latter prints the error and
 * returns 1. Neither path ever prints a secret -- nothing here touches
 * `DATABASE_URL` or either `WALLET_*` key directly (it reads neither: the
 * gate reads `raw_tx.block_time`, a plaintext column, and decrypts nothing),
 * and every error message this codebase throws is written to omit connection
 * strings, keys and payload values (see db.ts, lock.ts, parse-swap.ts).
 */
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { withLock } from "../src/lib/lock";
import { requeueNoRate } from "../src/lib/parse-swap";

/**
 * Env override for `requeueNoRate`'s own default, so a one-off larger drain
 * after a historical `sol_price` import -- or a `0` that stops the step dead
 * -- needs no edit and no deploy. Same knob, same spelling and same failure
 * behaviour as `TOKEN_METADATA_LIMIT` on the metadata cron.
 */
const LIMIT_ENV = "REQUEUE_LIMIT";

/** Unset, empty or unreadable means "use the library default"; see {@link LIMIT_ENV}. */
function resolveLimit(): number | undefined {
  const configured = process.env[LIMIT_ENV]?.trim();
  if (configured === undefined || configured === "") return undefined;

  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 0) {
    // A warning and the default, not a failure: an unreadable tuning knob
    // must not be able to stop a cron that would otherwise work. The value is
    // never echoed -- this variable is not a secret, but no env var's
    // contents are printed from this repo's scripts as a matter of habit.
    console.warn(`requeue-no-rate: ${LIMIT_ENV} is not a non-negative integer; using the default`);
    return undefined;
  }
  return parsed;
}

/**
 * Runs one requeue cycle and resolves to the process exit code it implies.
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
    const limit = resolveLimit();
    const result = await withLock("requeue-no-rate", () =>
      limit === undefined ? requeueNoRate() : requeueNoRate(limit),
    );

    // `withLock<T>` returns `T | null` and uses `null` for "the lock was
    // busy, `fn` never ran". Unambiguous here because `requeueNoRate`
    // resolves to an object literal, which can never itself be `null` -- the
    // wrapping `lock.ts`'s docstring recommends, arrived at for free, as on
    // the metadata cron.
    if (result === null) {
      console.log("requeue-no-rate: another run holds the lock; did nothing");
      return 0;
    }

    // Released against remaining, in one line: `remaining` is how many rows
    // the gate would have released and the limit did not, so a non-zero one
    // says "run me again" rather than "nothing to do". It is 0 for every
    // cycle the cron itself will ever see; the caller that makes it non-zero
    // is a by-hand historical import.
    console.log(
      `requeue-no-rate: released ${result.released} raw_tx row(s); ${result.remaining} still eligible`,
    );
    return 0;
  } catch (error) {
    console.error(`requeue-no-rate: failed -- ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Only when this file is the process entry point, not when a test imports
// it -- same guard scripts/seed-dev.ts already uses for the same reason.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}

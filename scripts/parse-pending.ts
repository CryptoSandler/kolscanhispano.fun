/**
 * Cron entry point for `parsePending` (see `../src/lib/parse-swap.ts`).
 *
 * Loads `.env.local` for a developer running this by hand; in CI the
 * workflow (`.github/workflows/parse-pending.yml`) supplies `DATABASE_URL`,
 * `WALLET_ENC_KEY` and `WALLET_HMAC_KEY` directly as job `env`, and
 * `.env.local` does not exist there.
 *
 * **The run is a loop of small locked batches, not one long locked run, and
 * that is the whole point of this file's shape.** `withLock` holds its
 * advisory lock on a *dedicated* `Client` (see `lock.ts` for why it may not
 * borrow the shared pool), and that client sits idle for as long as the
 * function inside the lock runs. Neon drops an idle connection at around
 * five minutes, so a single `withLock("parse-pending", () => parsePending())`
 * over a real backlog kills its own lock partway through. Measured against
 * production on 2026-08-31:
 *
 *     local run 1: 189 rows, then "Client has encountered a connection error
 *                  and is not queryable"
 *     local run 2: 191 rows in 707 s, same failure
 *     CI  run 33435133074: 100 rows in 178 s -> success
 *
 * That is ~1.8 s/row in CI and ~3.7 s/row locally: a hundred rows fits inside
 * the idle window, a few hundred does not. So each iteration takes the lock,
 * parses {@link DEFAULT_BATCH_SIZE} rows, and *releases* it -- the dedicated
 * client lives for one batch, not for the whole drain. A keepalive on the
 * lock connection would be the other way to do it, and is deliberately not
 * here: batching needs no timer, no extra query on a hot path, and no
 * reasoning about what happens when the keepalive itself races the work.
 *
 * The loop ends at whichever comes first of: a batch that examined 0 rows
 * (the queue is drained), the wall-clock budget, the batch count, or another
 * run taking the lock in between batches. The cron wants a bounded run and a
 * by-hand drain wants to keep going; both come out of this one script through
 * {@link BATCH_SIZE_ENV}, {@link BUDGET_ENV} and {@link MAX_BATCHES_ENV}.
 *
 * A batch that fails does not lose the batches that succeeded: the count is
 * accumulated outside the loop, printed, and *then* the failure is reported
 * and the run exits non-zero.
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

import { announceDatabaseTarget, query } from "../src/lib/db";
import { withLock } from "../src/lib/lock";
import { parsePending } from "../src/lib/parse-swap";

/**
 * Rows per lock acquisition.
 *
 * 25 because of the measured per-row cost in this file's header: ~45 s in CI
 * and ~90 s locally, against a Neon idle window of about five minutes. That
 * is a margin of 3x on the slower of the two surfaces, which is what makes it
 * survivable when a single row is unusually slow -- a batch of 100 would sit
 * at ~370 s locally and is exactly the size that has already failed twice.
 * Smaller would be safer still and is the wrong trade: each acquisition costs
 * a fresh `Client` connect against a pooled endpoint, so the batch is sized
 * to be as large as the idle window comfortably allows, not as small as
 * possible.
 */
const DEFAULT_BATCH_SIZE = 25;

/**
 * Wall-clock budget for one run, in milliseconds.
 *
 * Four minutes, against the workflow's `timeout-minutes: 10` and the four
 * other steps sharing that job (checkout and `npm ci`, the `sol_price` fill,
 * the requeue in front; the pricing and metadata steps behind). At the CI
 * rate that is roughly 130 rows a run -- more than the 100 the single-shot
 * version managed -- while leaving over half the job's budget to the steps
 * this one must not starve. A job that hits `timeout-minutes` does not just
 * lose the parse; it loses the pricing and metadata steps behind it.
 *
 * It is checked *between* batches, never during one: `parsePending` is not
 * cancellable, so the real ceiling is this plus one batch.
 */
const DEFAULT_BUDGET_MS = 240_000;

/** Env override for {@link DEFAULT_BATCH_SIZE}. Same spelling and same failure behaviour as `REQUEUE_LIMIT`. */
const BATCH_SIZE_ENV = "PARSE_BATCH_SIZE";
/** Env override for {@link DEFAULT_BUDGET_MS}. A by-hand drain sets it high; `0` stops the step without an edit. */
const BUDGET_ENV = "PARSE_BUDGET_MS";
/** Optional cap on batches per run. Unset means "no cap", and {@link BUDGET_ENV} is then the only bound. */
const MAX_BATCHES_ENV = "PARSE_MAX_BATCHES";

/**
 * The `setting` row this script's queue guard keeps, holding the pending
 * count and the instant it was taken.
 *
 * The `setting` table (migrations/001_core.sql) rather than a workflow
 * artifact, because the database is the only thing a cron run and a by-hand
 * drain both see: an artifact is scoped to the workflow that wrote it, so a
 * manual run would compare against nothing and a manual run is exactly what
 * happens during an incident.
 */
const QUEUE_DEPTH_KEY = "parse_pending_queue_depth";

/** What {@link QUEUE_DEPTH_KEY} stores: the depth, and when it was measured. */
type QueueDepth = { pending: number; at: Date };

/**
 * Unset, empty or unreadable means "use the default"; a warning rather than a
 * failure, because an unreadable tuning knob must not be able to stop a cron
 * that would otherwise work. The value is never echoed -- these are not
 * secrets, but no env var's contents are printed from this repo's scripts as
 * a matter of habit.
 */
function resolveCount(name: string, fallback: number): number {
  const configured = process.env[name]?.trim();
  if (configured === undefined || configured === "") return fallback;

  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(`parse-pending: ${name} is not a non-negative integer; using the default`);
    return fallback;
  }
  return parsed;
}

/**
 * Seconds under a minute and a half, minutes above it. The guard's message
 * has to say *over what interval* the queue grew, and "0 minutes" -- which is
 * what a plain minute rounding prints for the two runs of a busy drain -- is
 * the one thing it must not say.
 */
function formatInterval(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1_000))} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/**
 * Reads a stored {@link QueueDepth} back, or `null` if there isn't a usable
 * one. `null` means "no previous run", which must never fail a build: the
 * first-ever run has nothing to compare against, and so does the run after a
 * hand-edited or truncated `setting` row. Validated field by field rather
 * than cast, because a `jsonb` column is a value this process did not produce
 * in this run and a `NaN` here would silently turn every later comparison
 * false -- the guard would still be there and would never fire again.
 */
function readQueueDepth(value: unknown): QueueDepth | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const pending = record.pending;
  if (typeof pending !== "number" || !Number.isInteger(pending) || pending < 0) return null;

  const at = typeof record.at === "string" ? new Date(record.at) : null;
  if (at === null || Number.isNaN(at.getTime())) return null;

  return { pending, at };
}

/**
 * Records the current pending depth and compares it against the previous
 * run's. Returns the exit code it implies: 1 (with a GitHub `::error::`
 * annotation) when the queue **grew**, 0 otherwise.
 *
 * **Growth is the signal, not depth.** A large backlog that is shrinking is
 * the system working, and a threshold on depth would have to be re-chosen
 * every time the backlog changed shape. Ingest genuinely outpacing the parse
 * is the thing worth waking up for, and it is the only thing this fires on.
 *
 * The red workflow *is* the alert: `::error::` annotates the run in the
 * Actions UI and the non-zero exit makes it fail, which is a notification
 * GitHub already sends. No new service, no threshold to tune.
 *
 * **One statement, so the read and the write cannot disagree.** The CTE reads
 * the previous value and writes the new one in a single snapshot -- a
 * data-modifying `WITH` cannot see its own effect on the target table, which
 * is exactly what makes `previous` the pre-write value. Verified against the
 * test database 2026-08-31 (Postgres 18.6): first call returns no row and
 * stores, second call returns the first call's value and stores its own.
 *
 * `::error::` goes to **stdout**, not stderr: the Actions runner parses
 * workflow commands out of a step's standard output, and this repo's other
 * annotations are `echo` lines in the workflow for the same reason.
 */
async function checkQueueDepth(): Promise<number> {
  // The same predicate parsePending's own pending query uses -- anything else
  // would be a second definition of "pending", free to drift from the first.
  const [depth] = await query<{ pending: string }>(
    "SELECT count(*)::text AS pending FROM raw_tx WHERE parsed_at IS NULL AND parse_error IS NULL",
  );
  const current = Number(depth.pending);
  const now = new Date();

  const [row] = await query<{ value: unknown }>(
    `WITH previous AS (SELECT value FROM setting WHERE key = $1),
          recorded AS (
            INSERT INTO setting (key, value) VALUES ($1, $2::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
          )
     SELECT value FROM previous`,
    [QUEUE_DEPTH_KEY, JSON.stringify({ pending: current, at: now.toISOString() })],
  );

  const previous = readQueueDepth(row?.value);
  if (previous === null) {
    console.log(`parse-pending: queue depth ${current}; no previous depth to compare against, recorded this one`);
    return 0;
  }

  const interval = formatInterval(Math.max(0, now.getTime() - previous.at.getTime()));
  // `<=`, not `<`: an unchanged depth is not growth. A drained queue sits at
  // an unchanged 0 for every idle cycle, and a `<` here would paint every one
  // of them red.
  if (current <= previous.pending) {
    console.log(`parse-pending: queue depth ${current}, was ${previous.pending} ${interval} ago; not growing`);
    return 0;
  }

  // What grew, by how much, over what interval. An `::error::` with no
  // numbers is a red square nobody can act on.
  console.log(
    `::error::parse-pending: the pending queue grew by ${current - previous.pending} row(s), ` +
      `from ${previous.pending} to ${current}, over the last ${interval}. ` +
      `Ingestion is outpacing the parse.`,
  );
  return 1;
}

/** One wording for a failure, wherever in the run it happened. Never the error object: only its message. */
function reportFailure(error: unknown): number {
  console.error(`parse-pending: failed -- ${error instanceof Error ? error.message : String(error)}`);
  return 1;
}

/**
 * Runs one parse-pending cycle -- a loop of locked batches, then the queue
 * guard -- and resolves to the process exit code it implies. Exported (rather
 * than folded into the bottom-of-file shell) so the test suite can call it
 * in-process -- against the real dedicated lock connection and the real
 * shared pool, exactly as production runs it -- instead of paying a
 * subprocess's tsx-transform-and-reconnect cost for every property under
 * test. `process.exit` is deliberately never called in here: a test importing
 * this module runs inside the same worker as every other test in the file,
 * and calling it would kill that worker.
 */
export async function main(): Promise<number> {
  const batchSize = resolveCount(BATCH_SIZE_ENV, DEFAULT_BATCH_SIZE);
  const budgetMs = resolveCount(BUDGET_ENV, DEFAULT_BUDGET_MS);
  const maxBatches = resolveCount(MAX_BATCHES_ENV, Number.POSITIVE_INFINITY);

  const startedAt = Date.now();
  let examined = 0;
  let batches = 0;
  let lockBusy = false;

  try {
    while (batches < maxBatches && Date.now() - startedAt < budgetMs) {
      // `withLock<T>` returns `T | null`, using `null` as the sentinel for
      // "the lock was busy, `fn` never ran". That is unambiguous here only
      // because `parsePending` always resolves to a `number`, never to `null`
      // itself -- a property of *this* call site, not one `withLock`'s type
      // enforces. If a future `fn` passed to `withLock` could itself
      // legitimately resolve to `null`, this check would silently misreport a
      // real (empty) result as "did nothing", and `withLock` would need a
      // result wrapper instead of a bare nullable return.
      const count = await withLock("parse-pending", () => parsePending(batchSize));
      if (count === null) {
        lockBusy = true;
        break;
      }

      batches += 1;
      examined += count;
      // One line per batch, so a drain is watchable while it runs rather than
      // only after it ends.
      console.log(`parse-pending: batch ${batches} examined ${count} raw_tx row(s)`);

      // Nothing left to take: the queue is drained, and another acquisition
      // would only pay a connect to be told the same thing.
      //
      // This is the loop's termination argument, and it rests on a property
      // of `parsePending`: every row it examines is settled before it
      // returns -- `parsed_at` set, or `parse_error` set, or the whole call
      // throws (which lands in the catch below). So each batch strictly
      // shrinks the pending set, and a run cannot spin on the same rows. The
      // budget above is the backstop if that ever stops being true, not the
      // reason this terminates.
      if (count === 0) break;
    }
  } catch (error) {
    // The batches that succeeded are not lost to the one that failed: their
    // count is printed before the failure is. Only when there were any --
    // "examined 0 row(s)" alongside a failure reads as a claim about the
    // queue, and it is a claim about nothing.
    if (batches > 0) reportBatches(examined, batches);
    return reportFailure(error);
  }

  if (batches === 0 && lockBusy) {
    // The only path that prints these words, and it prints no count: "did
    // nothing" and "ran the work" must never look alike.
    console.log("parse-pending: another run holds the lock; did nothing");
    // No queue check either: the run that holds the lock is doing the work
    // and will run the guard itself, over an interval that includes its own
    // progress. Recording a depth from here would shorten that interval for
    // no observation of our own.
    return 0;
  }

  if (lockBusy) {
    console.log(`parse-pending: another run took the lock after ${batches} batch(es); stopping here`);
  }
  reportBatches(examined, batches);

  try {
    return await checkQueueDepth();
  } catch (error) {
    return reportFailure(error);
  }
}

function reportBatches(examined: number, batches: number): void {
  console.log(`parse-pending: examined ${examined} raw_tx row(s) across ${batches} batch(es)`);
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

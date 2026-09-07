/**
 * Cron entry point that keeps `token` populated for the mints that actually
 * appear in trades, by calling `tokenMetadata` (see `../src/lib/prices.ts`).
 *
 * **Why this file exists at all.** `tokenMetadata` was written, tested and
 * correct, and nothing in the running system called it: `upsertToken` is the
 * only writer of `token` rows outside `scripts/inject-swap.ts` (a dev seeding
 * script), and it is reachable only from `tokenMetadata`. So the `token`
 * table had no production writer, `feed.ts`'s `LEFT JOIN token` matched
 * nothing, and every feed row shipped with a NULL symbol -- while the suite
 * stayed green, because every test called the function directly. Batch 2's
 * Task 3 states "no feed row may ship without a symbol"; this step is what
 * makes that true of the composition rather than of the unit.
 *
 * **What it selects.** Mints appearing in `trade` that have no `token` row at
 * all, or one whose `symbol` is still NULL. A row that already carries a
 * symbol is not re-asked: this is not a price refresher, and re-asking would
 * spend a request to learn what is already known.
 *
 * **Why it is bounded, twice.** The Helius DAS fallback inside `tokenMetadata`
 * -- the thing that catches a mint DexScreener has never heard of -- costs 10
 * credits per mint against a 1,000,000/month free tier, with no batching.
 * Two different unbounded quantities have to be held down:
 *
 * 1. *Per run*, by `limit`. The default is {@link DEFAULT_LIMIT} = 30, which
 *    is exactly `DEXSCREENER_BATCH_LIMIT`: one run makes at most one
 *    DexScreener request, and at most 30 DAS calls behind it. On the 5-minute
 *    cadence of `.github/workflows/parse-pending.yml` that still drains 8,640
 *    mints a day, which is far more than this project mints in one, so the
 *    bound costs nothing in practice and caps a first run over a full trade
 *    history -- which is otherwise a rate-limit and credit question, not a
 *    nightly-cron one.
 *
 * 2. *Per mint*, by {@link DEFAULT_RETRY_AFTER}. A mint that **neither**
 *    DexScreener nor Helius knows keeps `symbol = NULL` for good, so it stays
 *    in the selection for ever. With the per-run bound alone it would be
 *    re-asked on every single cycle -- 288 DexScreener slots and 2,880 DAS
 *    credits a day, for an answer that already came back empty, and one
 *    such mint per 347 of the monthly free tier. The cooldown makes that
 *    10 credits a day instead of 2,880. It gates *when* a symbol-less mint is
 *    retried and never whether it is still missing: `remaining` below counts
 *    the true outstanding need, cooldown or no cooldown.
 *
 *    ponytail: a plain `updated_at` interval, no new column and no migration.
 *    If a mint ever needs its own retry schedule (exponential backoff, a
 *    permanent "nobody knows this" tombstone), that wants a column on `token`
 *    and this line stops being enough.
 *
 * **Ordering is what keeps the queue from starving**, and it is the same
 * rotation `scripts/backfill-prices.ts` uses: `updated_at ASC NULLS FIRST`
 * puts a mint nothing has ever examined ahead of every mint something has,
 * and `upsertToken` stamps `updated_at = now()`, so an examined mint moves to
 * the back of its own queue. Every mint needing metadata is therefore reached
 * within `ceil(N / limit)` runs. A chunk whose DexScreener call failed
 * outright is written by nothing, so its `updated_at` does not move and it is
 * retried on the very next run -- a transient outage is not a cooldown.
 *
 * **A mint neither source knows keeps `symbol = NULL`, deliberately.** No
 * placeholder is invented here: what the feed shows in that cell is a product
 * decision, and the database's job is to say "unknown" rather than to make
 * something up. `feed.ts` already types the column `string | null`.
 *
 * Takes the `withLock` advisory lock before doing anything, so a scheduled run
 * and a manual `workflow_dispatch` that overlap cannot both spend requests on
 * the same mints -- see `lock.ts`. The function passed to `withLock` is
 * nothing but pool queries and outbound HTTP, which is exactly the shape
 * `lock.ts`'s docstring requires: `withLock` holds its lock on its own
 * dedicated connection precisely so this call is free to use the shared pool
 * (which is `max: 1`) without deadlocking against it.
 *
 * "Did nothing" (another run already holds the lock) and "failed" are kept
 * distinguishable in both the exit code and the printed line: the former
 * prints its own message and returns 0, the latter prints the error and
 * returns 1. Neither path ever prints a secret -- nothing here touches
 * `DATABASE_URL` or `HELIUS_API_KEY` directly beyond testing the latter for
 * emptiness, and every error message this codebase throws is written to omit
 * connection strings, keys and payload values (see db.ts, lock.ts, prices.ts).
 */
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { query } from "../src/lib/db";
import { announceDatabaseTarget } from "../src/lib/db";
import { withLock } from "../src/lib/lock";
import { DEXSCREENER_BATCH_LIMIT, heliusCredentialRejections, tokenMetadata } from "../src/lib/prices";

/**
 * How many mints one run resolves. One DexScreener request's worth, and
 * therefore at most 30 Helius DAS calls behind it -- see the file header for
 * why the ceiling is set by credits and not by throughput.
 */
const DEFAULT_LIMIT = DEXSCREENER_BATCH_LIMIT;

/** How long a mint that came back without a symbol is left alone before being re-asked. */
const DEFAULT_RETRY_AFTER = "24 hours";

/** Env override for {@link DEFAULT_LIMIT}, so a one-off larger drain -- or a `0` that stops the step dead -- needs no edit and no deploy. */
const LIMIT_ENV = "TOKEN_METADATA_LIMIT";

export type RefreshResult = {
  /** Mints this run asked about. */
  selected: number;
  /** Of those, the ones a `token` row was actually written for. Lower when a DexScreener call failed. */
  written: number;
  /** Mints in `trade` that still have no symbol *after* this run, cooldown ignored. */
  remaining: number;
};

/**
 * The mints in `trade` that still need a symbol. `min(block_time)` is the
 * mint's oldest need, used only to break ties among mints nothing has ever
 * examined -- they all share a NULL `updated_at`.
 *
 * The `WHERE` is parenthesised because callers append `AND ...` to it, and
 * `A OR B AND C` is not `(A OR B) AND C`.
 */
const NEEDS_SYMBOL = `
    FROM (SELECT mint, min(block_time) AS first_seen FROM trade GROUP BY mint) t
    LEFT JOIN token tk ON tk.mint = t.mint
   WHERE (tk.mint IS NULL OR tk.symbol IS NULL)`;

export async function refreshTokenMetadata(
  options: { fetchImpl?: typeof fetch; limit?: number; retryAfter?: string } = {},
): Promise<RefreshResult> {
  const { fetchImpl = fetch, limit = DEFAULT_LIMIT, retryAfter = DEFAULT_RETRY_AFTER } = options;

  // Validated rather than clamped: a limit this function cannot read is a
  // caller's mistake, and running unbounded (or a negative `LIMIT`, which
  // Postgres rejects mid-run) is the wrong way to find out about it.
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`refresh-token-metadata: limit must be a non-negative integer, got ${limit}`);
  }

  const rows = await query<{ mint: string }>(
    `SELECT t.mint ${NEEDS_SYMBOL}
       AND (tk.updated_at IS NULL OR tk.updated_at < now() - $2::interval)
     ORDER BY tk.updated_at ASC NULLS FIRST, t.first_seen ASC
     LIMIT $1`,
    [limit, retryAfter],
  );

  if (rows.length > 0 && !process.env.HELIUS_API_KEY?.trim()) {
    // Said once per run, not once per mint, and it names what is degraded
    // rather than what is missing: DexScreener still supplies a symbol for
    // every mint it knows, and only the mints it does not are affected.
    console.warn(
      "refresh-token-metadata: HELIUS_API_KEY is not configured; a mint DexScreener does not know will keep symbol = NULL",
    );
  }

  // Chunking lives inside `tokenMetadata` (30 per DexScreener call). Doing it
  // again out here would only make the two disagree.
  const written = await tokenMetadata(
    rows.map((row) => row.mint),
    fetchImpl,
  );

  // Recounted rather than derived from `written`: a mint DexScreener answered
  // for without a symbol is written *and* still outstanding, and the two
  // numbers are only equal by accident. One extra count query per run.
  const [{ count }] = await query<{ count: string }>(`SELECT count(*)::text AS count ${NEEDS_SYMBOL}`);

  return { selected: rows.length, written, remaining: Number(count) };
}

/** The per-run bound, from the environment when it is readable there and the default when it is not. */
function resolveLimit(): number {
  const configured = process.env[LIMIT_ENV]?.trim();
  if (configured === undefined || configured === "") return DEFAULT_LIMIT;

  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 0) {
    // A warning and the default, not a failure: an unreadable tuning knob
    // must not be able to stop a cron that would otherwise work. The value
    // is never echoed -- this variable is not a secret, but no env var's
    // contents are printed from this repo's scripts as a matter of habit.
    console.warn(`refresh-token-metadata: ${LIMIT_ENV} is not a non-negative integer; using the default of ${DEFAULT_LIMIT}`);
    return DEFAULT_LIMIT;
  }
  return parsed;
}

/**
 * Runs one refresh cycle and resolves to the process exit code it implies.
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
    const result = await withLock("refresh-token-metadata", () => refreshTokenMetadata({ limit: resolveLimit() }));

    // `withLock<T>` returns `T | null` and uses `null` for "the lock was busy,
    // `fn` never ran". Unlike the other three crons, which resolve to a bare
    // `number` and are unambiguous only by accident of that, this one resolves
    // to an object literal -- which can never itself be `null`. That is the
    // wrapping `lock.ts`'s docstring recommends, arrived at for free.
    if (result === null) {
      console.log("refresh-token-metadata: another run holds the lock; did nothing");
      return 0;
    }

    console.log(
      `refresh-token-metadata: refreshed ${result.written} of ${result.selected} selected mint(s); ` +
        `${result.remaining} still lack a symbol`,
    );

    /*
      **Una credencial rechazada rompe el paso, aunque haya escrito filas.**

      El 2026-09-07 este paso informó `refreshed 29 of 29` mientras las 29
      llamadas a Helius devolvían 401: la clave de CI llevaba días vencida
      detrás de un tilde verde. `written` cuenta filas escritas —DexScreener
      responde igual— así que nunca lo iba a ver.

      Un 401 no es un token que Helius no conoce: es Helius no conociéndonos a
      nosotros, y eso no se arregla solo. Falla ruidoso, que es lo que un cron
      tiene que hacer cuando su credencial dejó de servir.
    */
    const rejected = heliusCredentialRejections();
    if (rejected > 0) {
      console.error(
        `refresh-token-metadata: Helius rechazó la credencial ${rejected} vez/veces (401/403). ` +
          "La clave de este entorno no sirve; rotala antes de confiar en el símbolo de un token.",
      );
      return 1;
    }

    return 0;
  } catch (error) {
    console.error(`refresh-token-metadata: failed -- ${error instanceof Error ? error.message : String(error)}`);
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

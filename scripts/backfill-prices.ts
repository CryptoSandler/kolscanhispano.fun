/**
 * Fills `usd_amount`, `sol_usd` and `price_usd` on trades that were written
 * without them, and marks the positions they belong to dirty so the recompute
 * rewrites `realized_usd` from the corrected rows.
 *
 * **Why any trade is missing them.** `insertTrade` resolves the SOL/USD rate
 * for a trade's minute out of `sol_price` (`solUsdAt`). Nothing scheduled
 * writes to `sol_price` yet, so a trade parsed at a moment when the table had
 * no row at or before its `block_time` was recorded honestly — SOL side
 * complete, USD side NULL — and stays that way for good, because the parse
 * cycle never looks at a `raw_tx` row twice. This script is the only thing
 * that revisits them.
 *
 * **What the opening refresh does and does not reach.** `refreshSolPrice`
 * writes one row, at the *current* minute, and `solUsdAt` bounds its search
 * at `minute <= block_time`. So this run's own refresh covers a trade only if
 * that trade's `block_time` falls in the same minute or later — in practice,
 * a trade from the minute this run started. Every older trade is filled from
 * a row an *earlier* run wrote, which is what the 5-minute cadence in
 * `.github/workflows/parse-pending.yml` is for: after the first cycle,
 * `sol_price` carries a row every five minutes and each new trade lands after
 * one of them. Trades older than the very first row are never reachable at
 * all — see below.
 *
 * **What it will not do.** It never re-prices a trade at today's rate. Spec
 * §4.1 is explicit: USD rankings sum the value *at trade time* and never
 * re-price, so a trade older than the earliest `sol_price` row has no rate
 * this project is allowed to invent, and DexScreener — the source spec §5.7
 * designates — serves a spot price, not history. Those rows keep a NULL
 * `usd_amount` and get `priced_at` stamped, which is what makes them
 * *countable* ("we looked, there was no rate") rather than merely absent
 * ("nothing has ever tried"). The count is printed on every run.
 *
 * Re-runnable by construction. The work queue is `usd_amount IS NULL`, so a
 * second run over the same rows fills nothing and marks nothing dirty; a row
 * whose minute is only covered by a `sol_price` row written later is picked
 * up on the next run, which is exactly why the queue is not *narrowed* by
 * `priced_at`.
 *
 * It is **ordered** by it, though, and that is what keeps the queue from
 * starving. Trades older than the earliest `sol_price` row can never be
 * filled and are also the oldest rows there are, so ordering by `block_time`
 * alone would park a permanently unfillable prefix at the front: past one
 * `LIMIT`'s worth of them, every run would re-examine the same rows and never
 * reach a newer trade a rate does cover. `priced_at NULLS FIRST` puts every
 * never-attempted trade ahead of every attempted one, so a new arrival always
 * jumps a stamped backlog, and the backlog is retried least-recent-first with
 * whatever budget is left. See migration 006.
 */
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { withTransaction, query } from "../src/lib/db";
import { withLock } from "../src/lib/lock";
import { parseDecimal } from "../src/lib/decimal";
import { refreshSolPrice, solUsdAt, valueTrade } from "../src/lib/prices";

/** How many unpriced trades one run examines. Bounded so a run has a predictable cost. */
const DEFAULT_LIMIT = 5_000;

export type BackfillResult = {
  /** Trades with a NULL `usd_amount` this run looked at. */
  examined: number;
  /** Of those, the ones a real rate covered. */
  filled: number;
  /** Of those, the ones with genuinely no rate for their minute. Still NULL, now stamped. */
  stillUnpriced: number;
  /** Distinct `(kol_id, mint)` positions marked dirty — one per position, not per trade. */
  positionsMarked: number;
  /** Whether the opening `refreshSolPrice` actually wrote a row. */
  rateRefreshed: boolean;
};

type Candidate = {
  id: string;
  kol_id: string;
  mint: string;
  sol_amount: string;
  price_sol: string | null;
  block_time: Date;
};

/** The minute a `block_time` falls in, matching `solUsdAt`'s own `date_trunc('minute', ...)`. */
function minuteOf(blockTime: Date): Date {
  return new Date(Math.floor(blockTime.getTime() / 60_000) * 60_000);
}

export async function backfillPrices(
  options: { fetchImpl?: typeof fetch; limit?: number; refresh?: boolean; now?: Date } = {},
): Promise<BackfillResult> {
  const { fetchImpl = fetch, limit = DEFAULT_LIMIT, refresh = true, now = new Date() } = options;

  // Ask DexScreener for the current rate first, so `sol_price` carries a row
  // for this minute and the *next* run's trades resolve against something at
  // most one cycle old. `refreshSolPrice` writes nothing at all when the
  // request fails, so a DexScreener outage costs this run the newest minute
  // and leaves every earlier rate resolvable.
  //
  // `now` is injectable only so a test can pin which minute gets written;
  // production never passes it.
  const rateRefreshed = refresh ? await refreshSolPrice(fetchImpl, now) : false;

  // `priced_at NULLS FIRST` before `block_time`: see the file header and
  // migration 006. ASC defaults to NULLS LAST in Postgres, so it is spelled
  // out, and `trade_unpriced_queue_idx` is declared the same way so it can
  // serve this sort.
  const candidates = await query<Candidate>(
    `SELECT id, kol_id, mint, sol_amount, price_sol, block_time
       FROM trade
      WHERE usd_amount IS NULL
      ORDER BY priced_at ASC NULLS FIRST, block_time
      LIMIT $1`,
    [limit],
  );

  // One lookup per distinct minute rather than per trade: a burst of trades
  // usually shares a block, and `solUsdAt` is a round trip to Neon.
  const rates = new Map<number, bigint | null>();
  const dirtied = new Set<string>();
  let filled = 0;
  let stillUnpriced = 0;

  for (const row of candidates) {
    const minute = minuteOf(row.block_time);
    if (!rates.has(minute.getTime())) rates.set(minute.getTime(), await solUsdAt(minute));
    const rate = rates.get(minute.getTime()) ?? null;

    if (rate === null) {
      // Looked, no rate. NULL stays NULL — never 0. See migration 005.
      await query("UPDATE trade SET priced_at = now() WHERE id = $1", [row.id]);
      stillUnpriced++;
      continue;
    }

    const valued = valueTrade(
      parseDecimal(row.sol_amount),
      row.price_sol === null ? null : parseDecimal(row.price_sol),
      rate,
    );

    // Both writes or neither, for the same reason `insertTrade` pairs them:
    // the dirty flag is the only thing that will ever cause the corrected
    // `usd_amount` to be read, so a crash between them leaves a position
    // whose `realized_usd` silently disagrees with its own trade log and
    // nothing anywhere is told to look.
    const marked = await withTransaction(async (tx) => {
      // `AND usd_amount IS NULL` makes the update itself the concurrency
      // barrier: a row another run filled between the SELECT and here returns
      // no rows, and its position is not re-dirtied for a change that did not
      // happen.
      const updated = await tx<{ id: string }>(
        `UPDATE trade
            SET sol_usd = $2, usd_amount = $3, price_usd = $4, priced_at = now()
          WHERE id = $1 AND usd_amount IS NULL
          RETURNING id`,
        [row.id, valued.solUsd, valued.usdAmount, valued.priceUsd],
      );
      if (updated.length === 0) return false;

      await tx(
        `INSERT INTO position (kol_id, mint, dirty) VALUES ($1, $2, TRUE)
         ON CONFLICT (kol_id, mint) DO UPDATE SET dirty = TRUE`,
        [row.kol_id, row.mint],
      );
      return true;
    });

    if (marked) {
      filled++;
      dirtied.add(`${row.kol_id}:${row.mint}`);
    }
  }

  return {
    examined: candidates.length,
    filled,
    stillUnpriced,
    positionsMarked: dirtied.size,
    rateRefreshed,
  };
}

/**
 * Runs one backfill cycle and resolves to the process exit code it implies.
 * Exported, and `process.exit` deliberately never called in here, for the
 * same reason `scripts/parse-pending.ts` does it: a test importing this module
 * runs inside the same worker as every other test in its file.
 *
 * Takes the same advisory lock shape as the two crons so a manual run and a
 * scheduled one cannot work the same rows. Nothing here prints a secret: the
 * only values that reach the console are counts.
 */
export async function main(): Promise<number> {
  try {
    const result = await withLock("backfill-prices", () => backfillPrices());
    if (result === null) {
      console.log("backfill-prices: another run holds the lock; did nothing");
      return 0;
    }

    console.log(
      `backfill-prices: examined ${result.examined} unpriced trade(s), filled ${result.filled}, ` +
        `${result.stillUnpriced} still have no rate for their minute, ` +
        `marked ${result.positionsMarked} position(s) dirty ` +
        `(SOL/USD refresh ${result.rateRefreshed ? "wrote a row" : "wrote nothing"})`,
    );
    return 0;
  } catch (error) {
    console.error(
      `backfill-prices: failed -- ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

// Only when this file is the process entry point, not when a test imports it.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}

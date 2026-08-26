/**
 * Derives `position` and `pnl_daily` from the trade log. Spec §4.2 (cost
 * basis), §4.5 (unknown basis), §4.7 (realized only), §4.8 (win rate) and
 * §4.10 (recomputation) are the binding authority for the arithmetic here.
 *
 * `trade` is the only source of truth (spec §3). Nothing in this file updates
 * a position incrementally: a replay recomputes one `(kol_id, mint)` from its
 * first trade every time, which is what makes a 30-day backfill landing after
 * today's webhook traffic safe, and what makes the result independent of the
 * order the rows arrived in.
 *
 * **Three things this file must not get wrong.**
 *
 * 1. **Replay order is `block_time, slot, instruction_index`** (spec §4.10),
 *    not `block_time, id`. `block_time` has one-second granularity and a
 *    trader fires several swaps of one mint inside a second; `id` is a random
 *    UUID. Ordering those by `id` produces an arbitrary sequence, and a
 *    weighted-average basis is order-sensitive — so the number would be
 *    plausible, stable across reruns, and wrong. `slot` then
 *    `instruction_index` is the chain's own order.
 *
 * 2. **No money passes through a JavaScript float.** `pg` returns `numeric`
 *    as a string; every amount here is parsed straight into scaled `bigint`
 *    (see `./decimal`) and formatted straight back. There is no `Number()`,
 *    no `parseFloat`, and no arithmetic on a `number` anywhere below.
 *
 * 3. **The sell rule divides once.** `realized += out − (cost × q) / qty`,
 *    and `cost` is reduced by that same quantity — not by `avg × q` computed
 *    from a separately rounded average. `avg_cost_sol` is derived once at the
 *    end, for display; it is never an input to the arithmetic.
 */

import { ONE, formatDecimal, mulDiv, parseDecimal } from "./decimal";
import { query, withTransaction, type TxQuery } from "./db";

/** Spec §13: `CLOSED_POSITION_THRESHOLD`, the share of the acquired quantity that closes a position. */
const DEFAULT_CLOSED_POSITION_THRESHOLD = "0.95";

/** Positions replayed per `recomputeDirty` call when the caller does not say. */
const DEFAULT_DIRTY_LIMIT = 100;

type TradeRow = {
  side: "buy" | "sell";
  token_amount: string;
  /** The swap leg alone: `parse-swap` adds the fee back out of it (spec §4.4). */
  sol_amount: string;
  usd_amount: string | null;
  /** The transaction fee, charged separately here. Zero unless this wallet paid it. */
  fee_sol: string;
  /** The SOL/USD rate at this block, the only way to value `fee_sol` in USD. */
  sol_usd: string | null;
  basis: "known" | "unknown";
  block_time: Date;
};

/** One UTC day's realized PnL for one position, before it is aggregated into `pnl_daily`. */
type DayTotals = { realizedSol: bigint; realizedUsd: bigint; wins: number; losses: number };

/**
 * Ordered by the chain's own sequence. The final `id` is a last-resort
 * tiebreak, reached only when two trades of the same KOL and mint share a
 * block time, a slot *and* an instruction index — two of the KOL's wallets on
 * the same instruction. It is arbitrary, but it is deterministic for a fixed
 * set of rows, which is what idempotency needs; without it Postgres may
 * return such a pair in either order and two replays of untouched data can
 * disagree.
 *
 * `slot` is nullable only for rows written before migration 002 added it;
 * those sort last within their second, then by instruction index.
 */
const TRADES_SQL = `
  SELECT side, token_amount, sol_amount, usd_amount, fee_sol, sol_usd, basis, block_time
    FROM trade
   WHERE kol_id = $1 AND mint = $2
   ORDER BY block_time, slot, instruction_index, id`;

/**
 * Reads `CLOSED_POSITION_THRESHOLD` once per replay, as a scaled decimal.
 *
 * Refuses a value outside `(0, 1]` rather than accepting one: a threshold of
 * `0` would close every position on its first sell and a threshold above `1`
 * would close none of them ever, and both look like a working system with a
 * surprising win rate rather than like a misconfiguration.
 */
function closedPositionThreshold(): bigint {
  const configured = process.env.CLOSED_POSITION_THRESHOLD?.trim();
  const threshold = parseDecimal(
    configured === undefined || configured === "" ? DEFAULT_CLOSED_POSITION_THRESHOLD : configured,
  );
  if (threshold <= 0n || threshold > ONE) {
    throw new Error("CLOSED_POSITION_THRESHOLD must be greater than 0 and at most 1");
  }
  return threshold;
}

/** The UTC calendar day a trade belongs to (spec §4.9), as `YYYY-MM-DD`. */
function utcDay(blockTime: Date): string {
  return blockTime.toISOString().slice(0, 10);
}

/**
 * The state a replay carries from one trade to the next. Held in one object
 * so {@link applyTrade} can be read against spec §4.2 line by line.
 */
type ReplayState = {
  qty: bigint;
  costSol: bigint;
  costUsd: bigint;
  realizedSol: bigint;
  realizedUsd: bigint;
  /** Cumulative, over the position's whole life: what §4.8's closure test compares. */
  boughtQty: bigint;
  soldQty: bigint;
  closed: boolean;
  /**
   * `realizedSol` as it stood when the current episode opened, so a closure
   * can be judged on what *this* round trip did. Without it `realizedSol` is
   * cumulative and a position that has ever been in profit counts every later
   * closure as a win, however badly that episode went — a day whose own
   * realized PnL is negative carrying a win, which is precisely the
   * self-contradiction spec §4.7 cites against kolscan.io, on the figure the
   * leaderboard ranks.
   */
  episodeStartSol: bigint;
  unknownBasis: boolean;
  firstBuyAt: Date | null;
  lastTradeAt: Date | null;
  daily: Map<string, DayTotals>;
};

function emptyState(): ReplayState {
  return {
    qty: 0n,
    costSol: 0n,
    costUsd: 0n,
    realizedSol: 0n,
    realizedUsd: 0n,
    boughtQty: 0n,
    soldQty: 0n,
    closed: false,
    episodeStartSol: 0n,
    unknownBasis: false,
    firstBuyAt: null,
    lastTradeAt: null,
    daily: new Map(),
  };
}

function dayTotals(state: ReplayState, day: string): DayTotals {
  const existing = state.daily.get(day);
  if (existing) return existing;
  const fresh: DayTotals = { realizedSol: 0n, realizedUsd: 0n, wins: 0, losses: 0 };
  state.daily.set(day, fresh);
  return fresh;
}

/** Spec §4.8: `sold ≥ threshold × bought`, in scaled integers so nothing rounds. */
function hasClosed(state: ReplayState, threshold: bigint): boolean {
  if (state.boughtQty <= 0n) return false;
  return state.soldQty * ONE >= threshold * state.boughtQty;
}

/**
 * Applies one trade to the running state. Spec §4.2:
 *
 * ```
 * buy:   qty += q;  cost += sol
 * sell:  realized += sol − (cost × q) / qty;  cost −= (cost × q) / qty;  qty −= q
 * ```
 *
 * where `sol` is the SOL the wallet actually parted with or kept — spec §4.4.
 * `sol_amount` is the swap leg alone, because `parse-swap` adds the fee back
 * out of the wallet's net balance delta so the two can be charged separately;
 * this is the half that charges it. **A buy costs `sol_amount + fee_sol` and a
 * sell nets `sol_amount − fee_sol`**, and a fee is only ever non-zero for the
 * wallet that actually paid it.
 *
 * Leaving it out was worth 0.1 SOL on a 2-leg round trip at the fee levels
 * §4.4 calls material, and it flips the sign of a marginal episode: a round
 * trip that grossed +0.02 and paid 0.10 in fees is a loss, and was being
 * counted as a win — the §4.7 contradiction, reached through a seam between
 * two modules that were each right about their own half.
 *
 * USD is carried in parallel, on the same quantity ratio, because §4.1 fixes
 * the USD value at trade time and never re-prices. The fee is valued at that
 * same trade's `sol_usd`, the rate its `usd_amount` was derived from. A trade
 * with no `sol_price` row covering its block has both NULL and contributes
 * nothing to either side of the USD figure.
 */
function applyTrade(state: ReplayState, trade: TradeRow, threshold: bigint): void {
  let quantity = parseDecimal(trade.token_amount);
  let sol = parseDecimal(trade.sol_amount);
  let usd = trade.usd_amount === null ? 0n : parseDecimal(trade.usd_amount);
  let fee = parseDecimal(trade.fee_sol);

  // A trade the parser could not price against a known basis (spec §4.5), or
  // a negative amount, which nothing that writes this table produces. Either
  // way the position's realized figure stops being trustworthy, and §4.5's
  // answer to that is to label it, not to publish it. A negative fee is in
  // that set too: it would credit SOL to the wallet that paid it.
  if (trade.basis === "unknown" || quantity < 0n || sol < 0n || usd < 0n || fee < 0n) {
    state.unknownBasis = true;
    if (quantity < 0n) quantity = 0n;
    if (sol < 0n) sol = 0n;
    if (usd < 0n) usd = 0n;
    if (fee < 0n) fee = 0n;
  }

  // Spec §4.4. The fee is a SOL amount; valuing it in USD needs this trade's
  // own rate, and an unpriced block leaves both sides of USD at zero.
  const solUsd = trade.sol_usd === null ? 0n : parseDecimal(trade.sol_usd);
  const feeUsd = mulDiv(fee, solUsd, ONE);

  // What the wallet actually parted with, or actually kept. A sell whose fee
  // exceeds its proceeds nets negative, and that is a real loss, not corrupt
  // data — so it is deliberately not clamped above.
  const netSol = trade.side === "buy" ? sol + fee : sol - fee;
  const netUsd = trade.side === "buy" ? usd + feeUsd : usd - feeUsd;

  state.lastTradeAt = trade.block_time;

  if (trade.side === "buy") {
    state.qty += quantity;
    state.costSol += netSol;
    state.costUsd += netUsd;
    state.boughtQty += quantity;
    if (state.firstBuyAt === null) state.firstBuyAt = trade.block_time;
    // Buying back into a position that had closed reopens it, so it can close
    // a second time and count a second win or loss (spec §4.8). The new
    // episode starts from the realized figure as it stands now: everything
    // realized before this buy — including the tail sells that came after the
    // previous closure — belongs to the round trip that already counted.
    if (state.closed && !hasClosed(state, threshold)) {
      state.closed = false;
      state.episodeStartSol = state.realizedSol;
    }
    return;
  }

  let removedSol: bigint;
  let removedUsd: bigint;
  if (quantity === 0n) {
    // Removes no quantity, so it gives up no basis — and proceeds against no
    // basis are not profit, they are SOL this position cannot account for.
    // Same manufactured-profit shape as the oversell below (spec §4.5) and
    // handled the same way: label the position rather than rank it.
    //
    // `parse-swap`'s dust floor drops a zero-quantity leg today, so nothing
    // reaches this branch. It is guarded anyway because the number downstream
    // is the one the leaderboard ranks, and it should not depend on an
    // upstream filter staying exactly as it is. A genuinely empty sell — no
    // quantity and no proceeds — moves nothing and is left alone, and so
    // does one that only paid a fee, which takes SOL away rather than
    // inventing it.
    if (netSol > 0n || netUsd > 0n) state.unknownBasis = true;
    removedSol = 0n;
    removedUsd = 0n;
  } else if (quantity >= state.qty) {
    // The sale takes the whole position. Assigning the remaining cost outright
    // — rather than through the ratio — is what makes a full exit land on
    // exactly zero cost with no residue left behind.
    //
    // Selling *more* than the position holds is not a bug in this file: spec
    // §4.5's case, tokens that arrived by transfer or before the wallet was
    // indexed. The excess has no cost, so counting its proceeds as profit is
    // exactly the manufactured-profit hole §4.5 exists to close. The position
    // is marked `unknown` instead, which keeps it off the leaderboard.
    if (quantity > state.qty) state.unknownBasis = true;
    removedSol = state.costSol;
    removedUsd = state.costUsd;
    state.qty = 0n;
    state.costSol = 0n;
    state.costUsd = 0n;
  } else {
    removedSol = mulDiv(state.costSol, quantity, state.qty);
    removedUsd = mulDiv(state.costUsd, quantity, state.qty);
    state.costSol -= removedSol;
    state.costUsd -= removedUsd;
    state.qty -= quantity;
  }

  state.realizedSol += netSol - removedSol;
  state.realizedUsd += netUsd - removedUsd;
  state.soldQty += quantity;

  // Spec §4.7: realized PnL is bucketed by the timestamp of the sell.
  const totals = dayTotals(state, utcDay(trade.block_time));
  totals.realizedSol += netSol - removedSol;
  totals.realizedUsd += netUsd - removedUsd;

  // Spec §4.8: per closed position, not per sell. Counted once, on the sell
  // that crosses the threshold, on that sell's day — and won or lost on what
  // this episode realized, not on the position's running total. See
  // `episodeStartSol`.
  if (!state.closed && hasClosed(state, threshold)) {
    state.closed = true;
    if (state.realizedSol - state.episodeStartSol > 0n) totals.wins += 1;
    else totals.losses += 1;
  }
}

/**
 * Replays every trade of one `(kol_id, mint)` and rewrites the rows derived
 * from it: the `position`, its `pnl_position_daily` contributions, and the
 * `pnl_daily` totals for every day those contributions touch — before and
 * after, since a replay can also take a day away.
 *
 * All of it inside one transaction. A `position` that disagrees with its own
 * daily rows is not a visibly broken state; both halves stay well-formed and
 * only the leaderboard is wrong.
 */
export async function replayPosition(kolId: string, mint: string): Promise<void> {
  const threshold = closedPositionThreshold();

  await withTransaction(async (tx) => {
    // Lock the position row first, and read the trades inside the same
    // transaction, so a trade inserted concurrently cannot have its dirty
    // mark cleared by this replay without being seen by it. `parse-swap`
    // inserts the trade before marking the position dirty, so either that
    // dirty mark lands before this lock — and its trade is then already
    // visible to the SELECT below — or it blocks behind this lock and
    // re-dirties the position after this replay commits.
    await tx(
      `INSERT INTO position (kol_id, mint, dirty) VALUES ($1, $2, TRUE)
       ON CONFLICT (kol_id, mint) DO UPDATE SET dirty = position.dirty`,
      [kolId, mint],
    );

    const trades = await tx<TradeRow>(TRADES_SQL, [kolId, mint]);

    const state = emptyState();
    for (const trade of trades) applyTrade(state, trade, threshold);

    const previousDays = await tx<{ day: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM pnl_position_daily
        WHERE kol_id = $1 AND mint = $2`,
      [kolId, mint],
    );
    await tx(`DELETE FROM pnl_position_daily WHERE kol_id = $1 AND mint = $2`, [kolId, mint]);

    const days = [...new Set([...previousDays.map((row) => row.day), ...state.daily.keys()])].sort();

    if (trades.length === 0) {
      // Nothing to derive from. Leaving a zeroed row behind would put a
      // position on the KOL page for a mint the KOL never traded.
      await tx(`DELETE FROM position WHERE kol_id = $1 AND mint = $2`, [kolId, mint]);
    } else {
      await writePosition(tx, kolId, mint, state);
      await writePositionDays(tx, kolId, mint, state);
    }

    await refreshDaily(tx, kolId, days);
  });
}

async function writePosition(
  tx: TxQuery,
  kolId: string,
  mint: string,
  state: ReplayState,
): Promise<void> {
  // Derived for display only, once, at the end (spec §3's `avg_cost_sol`).
  // Nothing above reads it back: see the header, point 3.
  const averageCost = state.qty > 0n ? mulDiv(state.costSol, ONE, state.qty) : 0n;

  await tx(
    `INSERT INTO position (kol_id, mint, qty, cost_sol, avg_cost_sol, realized_sol, realized_usd,
                           first_buy_at, last_trade_at, basis, dirty)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE)
     ON CONFLICT (kol_id, mint) DO UPDATE SET
       qty = EXCLUDED.qty, cost_sol = EXCLUDED.cost_sol, avg_cost_sol = EXCLUDED.avg_cost_sol,
       realized_sol = EXCLUDED.realized_sol, realized_usd = EXCLUDED.realized_usd,
       first_buy_at = EXCLUDED.first_buy_at, last_trade_at = EXCLUDED.last_trade_at,
       basis = EXCLUDED.basis, dirty = FALSE`,
    [
      kolId,
      mint,
      formatDecimal(state.qty),
      formatDecimal(state.costSol),
      formatDecimal(averageCost),
      formatDecimal(state.realizedSol),
      formatDecimal(state.realizedUsd),
      state.firstBuyAt,
      state.lastTradeAt,
      state.unknownBasis ? "unknown" : "known",
    ],
  );
}

/**
 * Writes this position's per-day contribution, unless its basis is unknown.
 *
 * Spec §4.5: an unknown-basis position's sells are **excluded from the
 * leaderboard**, and the leaderboard is the sum of `pnl_daily`. So the
 * contribution is withheld here rather than filtered downstream — the KOL
 * page still has the figure on the `position` row, to show labelled *sin base
 * de costo*, and no consumer of `pnl_daily` has to remember the rule.
 */
async function writePositionDays(
  tx: TxQuery,
  kolId: string,
  mint: string,
  state: ReplayState,
): Promise<void> {
  if (state.unknownBasis || state.daily.size === 0) return;

  const entries = [...state.daily.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
  const days = entries.map(([day]) => day);
  const totals = entries.map(([, total]) => total);

  await tx(
    `INSERT INTO pnl_position_daily (kol_id, mint, day, realized_sol, realized_usd, wins, losses)
     SELECT $1, $2, entry.day::date, entry.realized_sol::numeric, entry.realized_usd::numeric,
            entry.wins::int, entry.losses::int
       FROM unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::int[])
            AS entry(day, realized_sol, realized_usd, wins, losses)`,
    [
      kolId,
      mint,
      days,
      totals.map((total) => formatDecimal(total.realizedSol)),
      totals.map((total) => formatDecimal(total.realizedUsd)),
      totals.map((total) => total.wins),
      totals.map((total) => total.losses),
    ],
  );
}

/**
 * Recomputes `pnl_daily` for the given days of one KOL by summing every
 * position's contribution to them. Both statements are no-ops when they have
 * nothing to do, so this is idempotent and safe to run over days the position
 * no longer touches — that is exactly how a day that lost its last sell gets
 * its `pnl_daily` row removed.
 */
async function refreshDaily(tx: TxQuery, kolId: string, days: string[]): Promise<void> {
  if (days.length === 0) return;

  await tx(
    `DELETE FROM pnl_daily
      WHERE kol_id = $1 AND day = ANY ($2::date[])
        AND NOT EXISTS (SELECT 1 FROM pnl_position_daily contribution
                         WHERE contribution.kol_id = pnl_daily.kol_id
                           AND contribution.day = pnl_daily.day)`,
    [kolId, days],
  );

  await tx(
    `INSERT INTO pnl_daily (kol_id, day, realized_sol, realized_usd, wins, losses)
     SELECT kol_id, day, SUM(realized_sol), SUM(realized_usd), SUM(wins), SUM(losses)
       FROM pnl_position_daily
      WHERE kol_id = $1 AND day = ANY ($2::date[])
      GROUP BY kol_id, day
     ON CONFLICT (kol_id, day) DO UPDATE SET
       realized_sol = EXCLUDED.realized_sol, realized_usd = EXCLUDED.realized_usd,
       wins = EXCLUDED.wins, losses = EXCLUDED.losses`,
    [kolId, days],
  );
}

/**
 * Replays the dirty positions, oldest-marked first by nothing in particular —
 * there is no ordering column, and none is needed while every replay clears
 * its own flag.
 *
 * One position that cannot be replayed must not stop the others: the failure
 * is logged and the position stays dirty, so it is retried rather than
 * written wrong. Returns how many were replayed successfully.
 */
export async function recomputeDirty(limit: number = DEFAULT_DIRTY_LIMIT): Promise<number> {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("limit must be a non-negative integer");

  const dirty = await query<{ kol_id: string; mint: string }>(
    `SELECT kol_id, mint FROM position WHERE dirty ORDER BY kol_id, mint LIMIT $1`,
    [limit],
  );

  let replayed = 0;
  for (const position of dirty) {
    try {
      await replayPosition(position.kol_id, position.mint);
      replayed += 1;
    } catch (error) {
      // The mint is public data (spec §3); the KOL id is not an address, and
      // no address, key or connection string is ever formatted here.
      console.error(
        `Failed to replay position for mint ${position.mint}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return replayed;
}

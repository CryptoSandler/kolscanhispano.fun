-- The per-sell realized figure, so a window can be any interval.
--
-- `docs/round-ventanas-moviles.md` is the round `CLAUDE.md` requires before a
-- change to what a number means, and §4 is the owner's approval of exactly this
-- mechanism. The short version of why the column has to exist:
--
--   `pnl.ts` computes `netSol - removedSol` for **each sell** and then adds it
--   into a **UTC day** bucket. `pnl_daily` is `PRIMARY KEY (kol_id, day)`, so
--   the finest grain that survives a replay is a day -- and a rolling `1D`
--   cannot be computed from what is stored. Not approximately: the information
--   is produced and discarded in the same statement.
--
-- Persisting it makes every window, calendar-aligned or rolling, the same
-- `SUM(...) WHERE block_time >= $1`, and costs the two kinds of window the same.
--
-- **`NULL` for a buy, and `NULL` for a sell whose basis is unknown.** The second
-- is the one that matters: spec §4.5 withholds an unpriced sell from
-- `pnl_daily`, and if this column recorded a zero where that happens the two
-- sides would disagree by exactly the withheld amount. The round's drift check
-- -- `sum(trade.realized_sol)` against `sum(pnl_daily.realized_sol)` per KOL --
-- is only meaningful if both withhold the same rows, so `NULL` here means the
-- same thing `pnl_daily` means by having no row.
--
-- `numeric`, matching every other money column in this schema: these are the
-- same SOL figures the leaderboard prints, and the whole point of the check
-- above is that both sides come from one arithmetic and agree **exactly**.
--
-- No backfill in this file. The values come from a replay -- every position
-- marked dirty, drained by `recomputeDirty`, which is machinery this product
-- already runs on demand -- and a replay is not a thing to do inside a DDL
-- transaction against production.

ALTER TABLE trade
  ADD COLUMN IF NOT EXISTS realized_sol numeric,
  ADD COLUMN IF NOT EXISTS realized_usd numeric;

-- The index a rolling window reads: one KOL's sells over an instant range.
--
-- Partial on `realized_sol IS NOT NULL`, which is the same set every rolling
-- sum touches -- buys are the large majority of `trade` and none of them can
-- contribute. `block_time` second so the range scan runs inside one KOL.
CREATE INDEX IF NOT EXISTS trade_realized_window
  ON trade (kol_id, block_time)
  WHERE realized_sol IS NOT NULL;

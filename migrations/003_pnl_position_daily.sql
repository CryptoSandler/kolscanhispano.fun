-- Spec §4.10 replays one (kol_id, mint) at a time and calls that cheap. But
-- pnl_daily is keyed (kol_id, day) and sums every mint the KOL traded that
-- day, so a position-scoped replay cannot write pnl_daily directly: it would
-- overwrite the other mints' contribution to the same day with its own.
--
-- Recomputing the day from the trade log instead is not cheap. A mint's
-- realized PnL on one day depends on its whole prior history through the
-- weighted-average cost basis, so refreshing one day for one KOL would mean
-- replaying every mint that KOL has ever sold — on every trade insert.
--
-- This table holds the per-position contribution that pnl_daily aggregates.
-- A replay rewrites only its own (kol_id, mint) rows, then refreshes the
-- affected days of pnl_daily with a GROUP BY over this table. pnl_daily keeps
-- exactly the shape spec §3 gives it and stays the leaderboard's table.
CREATE TABLE IF NOT EXISTS pnl_position_daily (
  kol_id       UUID NOT NULL REFERENCES kol (id),
  mint         TEXT NOT NULL,
  day          DATE NOT NULL,
  realized_sol NUMERIC NOT NULL DEFAULT 0,
  realized_usd NUMERIC NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  losses       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kol_id, mint, day)
);

-- The aggregation the pnl_daily refresh runs: one KOL, a handful of days.
CREATE INDEX IF NOT EXISTS pnl_position_daily_day_idx ON pnl_position_daily (kol_id, day);

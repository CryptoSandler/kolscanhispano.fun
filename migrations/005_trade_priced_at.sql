-- `trade.usd_amount IS NULL` has meant two different things and there was no
-- way to tell them apart from the row: "we resolved the SOL/USD rate for this
-- trade's minute and there genuinely was none" and "nothing has ever tried to
-- price this row". Spec §4.1 makes the distinction load-bearing rather than
-- cosmetic -- an unpriced buy understates costUsd while a priced sell still
-- removes a share of it, so realized_usd is *overstated* for any KOL who
-- traded through a gap. That inaccuracy is acceptable while it is labelled
-- and countable; it stops being acceptable the moment it is invisible.
--
-- priced_at is stamped whenever a valuation was attempted, whatever the
-- outcome. So, on any trade row:
--
--   usd_amount IS NOT NULL                     -> priced
--   usd_amount IS NULL AND priced_at IS NOT NULL -> looked, no rate existed
--   usd_amount IS NULL AND priced_at IS NULL     -> never looked at
--
-- Existing rows are deliberately left with priced_at NULL rather than
-- backdated: they were written before anything stamped this, and claiming
-- they were examined would be inventing the very fact this column exists to
-- record. scripts/backfill-prices.ts is what moves them out of the third
-- state, and it reports how many are left in the second.
ALTER TABLE trade ADD COLUMN IF NOT EXISTS priced_at TIMESTAMPTZ;

-- The backfill's work queue is exactly this predicate, and it is a tiny
-- fraction of the table once the cron is keeping sol_price fresh. A partial
-- index keeps a re-run from sequentially scanning every trade ever recorded
-- to find nothing.
CREATE INDEX IF NOT EXISTS trade_unpriced_idx
  ON trade (block_time) WHERE usd_amount IS NULL;

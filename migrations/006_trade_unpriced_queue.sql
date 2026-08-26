-- Replaces migration 005's index to match the order
-- scripts/backfill-prices.ts actually walks its queue in.
--
-- 005 indexed (block_time) WHERE usd_amount IS NULL, and the script ordered
-- by block_time, which starves. Trades older than the earliest sol_price row
-- can never be filled -- there is no historical rate and spec 4.1 forbids
-- inventing one -- so they stay in the queue for good AND sort to the front,
-- because they are the oldest rows there are. Past one LIMIT's worth of them,
-- every five-minute run would re-examine the same permanently unfillable
-- prefix and never reach a newer trade that a rate does cover.
--
-- The fix is to sort on priced_at first, NULLS FIRST: a trade nothing has
-- ever looked at outranks every trade that has been looked at, whatever their
-- block times, and among trades that have been looked at the least recently
-- attempted goes first. A new trade therefore always jumps a stamped backlog,
-- and the backlog is still retried round-robin with whatever budget is left.
--
-- Retried, and not dropped: the queue is deliberately still every row with
-- usd_amount IS NULL, not just the never-attempted ones. A sol_price row
-- covering an earlier minute can arrive after the fact (a historical import,
-- a seed), and narrowing the queue by priced_at would make those rows
-- unreachable forever -- trading a starvation bound for a permanent blind
-- spot.
--
-- ASC in Postgres defaults to NULLS LAST, so NULLS FIRST is spelled out on
-- both the index and the query; they must keep agreeing for this index to
-- serve the sort.
DROP INDEX IF EXISTS trade_unpriced_idx;

CREATE INDEX IF NOT EXISTS trade_unpriced_queue_idx
  ON trade (priced_at NULLS FIRST, block_time) WHERE usd_amount IS NULL;

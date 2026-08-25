-- trade lacked a slot column, so replay ordering (spec §4.10:
-- block_time, slot, instruction_index) had nothing to sort by beyond
-- block_time (second-granularity) and a random UUID id. Add it, and
-- rebuild trade_position_idx to serve that exact ordering.
ALTER TABLE trade ADD COLUMN IF NOT EXISTS slot BIGINT;

DROP INDEX IF EXISTS trade_position_idx;
CREATE INDEX IF NOT EXISTS trade_position_idx
  ON trade (kol_id, mint, block_time, slot, instruction_index);

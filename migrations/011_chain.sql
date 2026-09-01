-- `chain` enters every key that identifies a row, before the first non-Solana
-- row lands.
--
-- `docs/multichain.md` §1 and §6. Three of these are **unrecoverable if they
-- land late**, and they share a shape: each silently merges or drops a row
-- once real data exists, and the evidence of the loss is the row that was not
-- written. Nothing raises, nothing is logged, and the webhook answers 200.
--
--   1.1 `raw_tx.signature_hmac` is the primary key on its own, and the same
--       signed transaction broadcast on two EVM chains has an *identical
--       hash*. The second chain's copy hits `ON CONFLICT DO NOTHING` and
--       disappears. Same for `trade_unique_idx`.
--   1.3 `token.mint` is the primary key, and CREATE2 puts the *same address*
--       on several EVM chains routinely. Two different tokens would share one
--       price row and merge into one position.
--   §2  `pnl_daily`'s key is `(kol_id, day)`, and a chain cannot be
--       back-derived from an aggregate. The ranking stays consolidated in USD
--       (that is the product decision, `DECISIONES.md`); the *filter* is cheap
--       to add later, but only if the key can still tell the chains apart.
--
-- Every existing row is Solana, so the backfill is the column default.
--
-- **The default is kept, deliberately, and it is a decision with a ceiling.**
-- Dropping it would be stricter: a forgotten `chain` in a future EVM insert
-- would fail loudly instead of filing a silent Solana row. It would also mean
-- rewriting every `INSERT` in the repository -- roughly thirty of them across
-- the parser, the scripts, the seeds and the tests -- in the same change that
-- re-keys seven tables, so a mistake in either half would be discovered
-- against the other. This migration's whole purpose is that these keys land
-- *early and correctly*, which argues for the version with the smaller blast
-- radius.
--
-- What the default cannot cause today: there is no EVM ingestor. Nothing in
-- this repository can produce a non-Solana row, so there is no insert for the
-- default to answer wrongly. The registration path is the one exception and it
-- states its chain explicitly (`wallets.ts`), because that is the path where a
-- person's EVM wallet actually arrives.
--
-- ponytail: `DEFAULT 'solana'` kept to hold this migration to the keys. It is
-- dropped by the migration that lands the first EVM ingestor, which touches
-- every insert site anyway -- and at that point `ALTER COLUMN chain DROP
-- DEFAULT` on all seven tables is the whole of it.

-- The `CHECK` is spelled out per table rather than shared through a DOMAIN or
-- an ENUM: adding a chain is then a visible migration on each table that holds
-- one, and `src/lib/chain.ts` holds the same list on the application side with
-- a test that the two agree.

ALTER TABLE kol_wallet ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'solana'
  CONSTRAINT kol_wallet_chain_check CHECK (chain IN ('solana','robinhood','bnb','ethereum'));

-- `address_hmac` was `UNIQUE` on its own. The same EVM address is a
-- legitimate, *distinct* wallet on BNB and on Ethereum -- one account, two
-- chains, two sets of trades -- so a global uniqueness constraint would let a
-- KOL register their address on whichever chain they reached first and refuse
-- the rest with a duplicate-key error they could do nothing about.
ALTER TABLE kol_wallet DROP CONSTRAINT IF EXISTS kol_wallet_address_hmac_key;
CREATE UNIQUE INDEX IF NOT EXISTS kol_wallet_chain_address_idx
  ON kol_wallet (chain, address_hmac);

-- The target of the composite foreign key below. `id` is already the primary
-- key, so this adds no real restriction on `kol_wallet`; it exists so that
-- `trade` can reference the *pair* and have Postgres enforce it.
ALTER TABLE kol_wallet ADD CONSTRAINT kol_wallet_id_chain_key UNIQUE (id, chain);

ALTER TABLE trade ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'solana'
  CONSTRAINT trade_chain_check CHECK (chain IN ('solana','robinhood','bnb','ethereum'));

-- The composite FK, which is the point of the `UNIQUE (id, chain)` above.
--
-- `trade.wallet_id` already referenced `kol_wallet (id)`, so a trade always
-- belonged to a real wallet -- but nothing tied the trade's chain to the
-- wallet's. A parser bug, or an EVM ingestor pointed at the wrong config,
-- could file a BNB trade against a Solana wallet and every downstream query
-- would accept it: the PnL replay would fold it into that wallet's position,
-- and the leaderboard would rank a KOL on a chain they never traded. This is
-- a constraint the database can check on every insert and the application
-- cannot check reliably at all, which is the rung `CLAUDE.md` says to stop on.
ALTER TABLE trade DROP CONSTRAINT IF EXISTS trade_wallet_id_fkey;
ALTER TABLE trade ADD CONSTRAINT trade_wallet_chain_fkey
  FOREIGN KEY (wallet_id, chain) REFERENCES kol_wallet (id, chain);

DROP INDEX IF EXISTS trade_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS trade_unique_idx
  ON trade (chain, signature_hmac, instruction_index, wallet_id);

ALTER TABLE raw_tx ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'solana'
  CONSTRAINT raw_tx_chain_check CHECK (chain IN ('solana','robinhood','bnb','ethereum'));
ALTER TABLE raw_tx DROP CONSTRAINT IF EXISTS raw_tx_pkey;
ALTER TABLE raw_tx ADD PRIMARY KEY (chain, signature_hmac);

ALTER TABLE token ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'solana'
  CONSTRAINT token_chain_check CHECK (chain IN ('solana','robinhood','bnb','ethereum'));
ALTER TABLE token DROP CONSTRAINT IF EXISTS token_pkey;
ALTER TABLE token ADD PRIMARY KEY (chain, mint);

ALTER TABLE position ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'solana'
  CONSTRAINT position_chain_check CHECK (chain IN ('solana','robinhood','bnb','ethereum'));
ALTER TABLE position DROP CONSTRAINT IF EXISTS position_pkey;
ALTER TABLE position ADD PRIMARY KEY (kol_id, chain, mint);

ALTER TABLE pnl_position_daily ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'solana'
  CONSTRAINT pnl_position_daily_chain_check CHECK (chain IN ('solana','robinhood','bnb','ethereum'));
ALTER TABLE pnl_position_daily DROP CONSTRAINT IF EXISTS pnl_position_daily_pkey;
ALTER TABLE pnl_position_daily ADD PRIMARY KEY (kol_id, chain, mint, day);

ALTER TABLE pnl_daily ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'solana'
  CONSTRAINT pnl_daily_chain_check CHECK (chain IN ('solana','robinhood','bnb','ethereum'));
ALTER TABLE pnl_daily DROP CONSTRAINT IF EXISTS pnl_daily_pkey;
ALTER TABLE pnl_daily ADD PRIMARY KEY (kol_id, chain, day);

-- The leaderboard sums `pnl_daily` across chains for one KOL over a day range
-- (`leaderboard.ts`), and that is now a scan across the new key's second
-- column. The filter §2 leaves open -- one chain instead of all -- reads the
-- same index with an extra equality.
CREATE INDEX IF NOT EXISTS pnl_daily_chain_day_idx ON pnl_daily (chain, day);

-- `position_dirty_idx` and `pnl_position_daily_day_idx` are recreated to carry
-- `chain`: a replay is scoped to one position, and after this migration a
-- position is `(kol_id, chain, mint)`.
DROP INDEX IF EXISTS position_dirty_idx;
CREATE INDEX IF NOT EXISTS position_dirty_idx ON position (kol_id, chain, mint) WHERE dirty;

DROP INDEX IF EXISTS pnl_position_daily_day_idx;
CREATE INDEX IF NOT EXISTS pnl_position_daily_day_idx
  ON pnl_position_daily (kol_id, chain, day);

-- `trade_position_idx` (migration 002) is the index the replay reads, and the
-- replay's `WHERE` gained `chain` above. Without `chain` in the index Postgres
-- can still use it and filter afterwards, which is correct but reads more rows
-- than it needs the moment a KOL trades the same mint address on two chains --
-- exactly the CREATE2 case that put `chain` in `token`'s key.
DROP INDEX IF EXISTS trade_position_idx;
CREATE INDEX IF NOT EXISTS trade_position_idx
  ON trade (kol_id, chain, mint, block_time, slot, instruction_index);

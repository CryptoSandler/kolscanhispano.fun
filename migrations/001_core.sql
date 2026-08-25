CREATE TABLE IF NOT EXISTS cabal (
  id         UUID PRIMARY KEY,
  tag        TEXT NOT NULL UNIQUE CHECK (tag ~ '^[A-Z]{3,4}$'),
  name       TEXT NOT NULL,
  logo_url   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kol (
  id                  UUID PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  x_handle            CITEXT NOT NULL UNIQUE,
  avatar_override_url TEXT,
  cabal_id            UUID REFERENCES cabal (id),
  hide_wallets        BOOLEAN NOT NULL DEFAULT TRUE,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','suspended')),
  approved_at         TIMESTAMPTZ,
  suspended_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- address_enc: AES-256-GCM. address_hmac: HMAC-SHA-256 under a separate key, and the
-- only way anything looks a wallet up. See docs/spec-v1.md section 8.
CREATE TABLE IF NOT EXISTS kol_wallet (
  id                  UUID PRIMARY KEY,
  kol_id              UUID NOT NULL REFERENCES kol (id),
  address_enc         BYTEA NOT NULL,
  address_hmac        BYTEA NOT NULL UNIQUE,
  key_version         SMALLINT NOT NULL DEFAULT 1,
  proof_signature_enc BYTEA,
  proof_message_enc   BYTEA,
  proof_verified_at   TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  added_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at        TIMESTAMPTZ,
  backfill_status     TEXT NOT NULL DEFAULT 'queued'
                        CHECK (backfill_status IN ('queued','running','done','capped','failed')),
  backfill_cursor     TEXT
);
CREATE INDEX IF NOT EXISTS kol_wallet_kol_idx ON kol_wallet (kol_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS raw_tx (
  signature_hmac BYTEA PRIMARY KEY,
  signature_enc  BYTEA NOT NULL,
  payload_enc    BYTEA NOT NULL,
  key_version    SMALLINT NOT NULL DEFAULT 1,
  slot           BIGINT,
  block_time     TIMESTAMPTZ NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  parsed_at      TIMESTAMPTZ,
  parse_error    TEXT,
  source         TEXT NOT NULL CHECK (source IN ('webhook','backfill','reconcile'))
);
CREATE INDEX IF NOT EXISTS raw_tx_unparsed_idx ON raw_tx (received_at) WHERE parsed_at IS NULL;

CREATE TABLE IF NOT EXISTS token (
  mint           TEXT PRIMARY KEY,
  symbol         TEXT,
  name           TEXT,
  decimals       SMALLINT NOT NULL DEFAULT 9,
  image_url      TEXT,
  price_usd      NUMERIC,
  price_sol      NUMERIC,
  liquidity_usd  NUMERIC,
  price_state    TEXT NOT NULL DEFAULT 'unpriced'
                   CHECK (price_state IN ('priced','stale','unpriced')),
  pair_url       TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade (
  id                UUID PRIMARY KEY,
  signature_hmac    BYTEA NOT NULL,
  signature_enc     BYTEA NOT NULL,
  instruction_index SMALLINT NOT NULL,
  kol_id            UUID NOT NULL REFERENCES kol (id),
  wallet_id         UUID NOT NULL REFERENCES kol_wallet (id),
  mint              TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('buy','sell')),
  token_amount      NUMERIC NOT NULL,
  sol_amount        NUMERIC NOT NULL,
  usd_amount        NUMERIC,
  sol_usd           NUMERIC,
  price_sol         NUMERIC,
  price_usd         NUMERIC,
  fee_sol           NUMERIC NOT NULL DEFAULT 0,
  basis             TEXT NOT NULL DEFAULT 'known' CHECK (basis IN ('known','unknown')),
  block_time        TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS trade_unique_idx
  ON trade (signature_hmac, instruction_index, wallet_id);
CREATE INDEX IF NOT EXISTS trade_feed_idx ON trade (block_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS trade_position_idx ON trade (kol_id, mint, block_time);
CREATE INDEX IF NOT EXISTS trade_token_idx ON trade (mint, block_time DESC);

CREATE TABLE IF NOT EXISTS position (
  kol_id        UUID NOT NULL REFERENCES kol (id),
  mint          TEXT NOT NULL,
  qty           NUMERIC NOT NULL DEFAULT 0,
  cost_sol      NUMERIC NOT NULL DEFAULT 0,
  avg_cost_sol  NUMERIC NOT NULL DEFAULT 0,
  realized_sol  NUMERIC NOT NULL DEFAULT 0,
  realized_usd  NUMERIC NOT NULL DEFAULT 0,
  first_buy_at  TIMESTAMPTZ,
  last_trade_at TIMESTAMPTZ,
  basis         TEXT NOT NULL DEFAULT 'known' CHECK (basis IN ('known','unknown')),
  dirty         BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (kol_id, mint)
);
CREATE INDEX IF NOT EXISTS position_dirty_idx ON position (kol_id, mint) WHERE dirty;

CREATE TABLE IF NOT EXISTS pnl_daily (
  kol_id       UUID NOT NULL REFERENCES kol (id),
  day          DATE NOT NULL,
  realized_sol NUMERIC NOT NULL DEFAULT 0,
  realized_usd NUMERIC NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  losses       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kol_id, day)
);

CREATE TABLE IF NOT EXISTS sol_price (
  minute TIMESTAMPTZ PRIMARY KEY,
  usd    NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit (
  ip_hash     BYTEA NOT NULL,
  bucket      TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ip_hash, bucket, window_start)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  before      JSONB,
  after       JSONB,
  ip_hash     BYTEA,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);

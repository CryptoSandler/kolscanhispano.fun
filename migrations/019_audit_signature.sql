-- The signature that authorised an audit entry, kept beside it.
--
-- ## Why this exists when the chain already does
--
-- `migrations/018` gives `audit_log` an append-only trigger and a hash chain,
-- and both are **tripwires**: the owner can drop the trigger, and whoever can
-- write rows can recompute the chain from the point they changed. They catch
-- the accident, not the operator.
--
-- A signature is different in kind. It was produced by a KOL's wallet over a
-- nonce this server issued, so **nobody with database access can forge one**,
-- and nobody can move it to a different action — the action and the subject are
-- inside the signed text, and the nonce is single-use. That is non-repudiation,
-- and it is the only part of this account that does not rest on trusting the
-- operator.
--
-- It covers exactly the entries a KOL signed. The admin's own actions are
-- authorised by a token we hold, so they have no signature and never will; the
-- account says so by the row's absence rather than by a claim.
--
-- ## Why a separate table
--
-- `audit_log` is read by ordinary paths — the admin screen, a future public
-- record of a cabal's history. This table is read by nothing in a request path:
-- it is opened when somebody is checking whether an entry is genuine, which is
-- an audit and not a page load. Keeping it apart means the signature and the
-- address material are not carried along by every query that happens to read
-- the log, which is the same reasoning `kol_wallet` follows for addresses.
--
-- The name is English like every other table here (`wallet_proof_nonce`,
-- `kol_wallet`); `CLAUDE.md` puts code and schema in English and UI copy in
-- Spanish.
--
-- ## What it stores, and what it deliberately does not
--
-- The address is **not** stored in clear. Verification needs it — a Solana
-- signature is checked against a public key, which is the address — so it is
-- kept the way `kol_wallet` keeps one: encrypted with AAD, plus a blind index
-- for lookup. An EVM signature does not even need that much, since the address
-- is recovered from the signature itself, and the blind index is then what
-- proves the recovered address is the KOL's.
--
-- `expires_at` is stored because the message included it: the verifier rebuilds
-- the exact text that was signed, and a field it has to guess is a field that
-- makes verification fail for the wrong reason.

CREATE TABLE IF NOT EXISTS audit_signature (
  audit_id     UUID PRIMARY KEY REFERENCES audit_log (id),
  -- The nonce is what ties this to the entry and to the proof that was burnt.
  -- Unique because a nonce authorises exactly one action, and `audit_log`
  -- already carries the same constraint on its own copy.
  nonce        TEXT NOT NULL UNIQUE,
  chain        TEXT NOT NULL,
  address_hmac BYTEA NOT NULL,
  address_enc  BYTEA NOT NULL,
  -- Base58 for Solana, `0x`-hex for EVM: whatever the wallet returned, verbatim.
  signature    TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Which entries did this wallet sign for?" — the question an audit actually
-- asks, and the only lookup this table has.
CREATE INDEX IF NOT EXISTS audit_signature_by_wallet ON audit_signature (address_hmac, at DESC);

-- Append-only for the same reason `audit_log` is, and with the same honesty:
-- it raises for the application and the owner can drop it.
DROP TRIGGER IF EXISTS audit_signature_no_update ON audit_signature;
CREATE TRIGGER audit_signature_no_update
  BEFORE UPDATE OR DELETE ON audit_signature
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

DROP TRIGGER IF EXISTS audit_signature_no_truncate ON audit_signature;
CREATE TRIGGER audit_signature_no_truncate
  BEFORE TRUNCATE ON audit_signature
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

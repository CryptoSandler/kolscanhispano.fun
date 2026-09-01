-- Server-issued, single-use nonces for wallet proofs.
--
-- `docs/wallet-proof.md` §1: the implementation this is modelled on
-- (`nftraffle`'s `verifyPayerBinding`) documents its own ceiling out loud --
-- its nonce is chosen by the *client*, so a captured message-and-signature
-- pair can be replayed inside the validity window. Spec §6.1 issues the nonce
-- here instead, and this table is the difference. It is the one place this
-- design must be stricter than the thing it copies.
--
-- **`address_hmac`, never the address.** `SECURITY.md`: an address reaches no
-- table in plaintext. The nonce is bound to the wallet through the same blind
-- index `kol_wallet` uses, so "is this the nonce we issued to this wallet" is
-- answerable without decrypting anything -- and a stolen nonce is useless
-- against a different wallet.
--
-- **`used_at`, not a delete.** Burning by deletion cannot tell "never issued"
-- from "already spent", and those refuse for different reasons that a person
-- debugging a failed registration needs told apart. It also leaves the row for
-- the prune below to remove on a schedule rather than in the request.

CREATE TABLE IF NOT EXISTS wallet_proof_nonce (
  nonce        TEXT PRIMARY KEY,
  address_hmac BYTEA NOT NULL,
  chain        TEXT NOT NULL
                 CONSTRAINT wallet_proof_nonce_chain_check
                 CHECK (chain IN ('solana','robinhood','bnb','ethereum')),
  action       TEXT NOT NULL
                 CONSTRAINT wallet_proof_nonce_action_check
                 CHECK (action IN ('alta de perfil','agregar wallet')),
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

-- The prune's index. `rate_limit` is the precedent: any table an unauthenticated
-- caller can add rows to needs something that removes them, or it is the one
-- unbounded table nobody remembers. A spent or expired nonce has no further
-- use -- the proof it authorised is already recorded on `kol_wallet`.
CREATE INDEX IF NOT EXISTS wallet_proof_nonce_expiry_idx ON wallet_proof_nonce (expires_at);

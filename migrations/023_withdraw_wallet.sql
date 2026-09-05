-- `retirar wallet`: the fourteenth signed action, and the one that takes a
-- power away from the operator rather than giving one to a KOL.
--
-- ## What it closes
--
-- `docs/round-reasignacion.md` §0 found the hole and §3 admitted it could not be
-- closed from inside the database: **nothing in the product ever set
-- `kol_wallet.status = 'withdrawn'`** — verified 2026-09-05, every occurrence
-- outside tests was a comment — so the value was one the operator set by hand in
-- SQL and nobody else.
--
-- That made `líder sin wallet activa`, the orphan reason the whole reassignment
-- path exists for, **a state the operator could manufacture**. Withdraw the
-- leader's wallet, wait for the cabal to appear on the orphan list, nominate.
-- Every row of the resulting audit trail would be genuine and the sequence would
-- be indistinguishable from a repair.
--
-- Now withdrawing is an action, it is signed, and **the signature has to come
-- from the wallet being withdrawn**. There is no admin route that writes this
-- column and there is a test that fails if one appears. The operator can still
-- reach the database directly — nothing here pretends otherwise, the same way
-- `migrations/018` is honest about its triggers — but they can no longer do it
-- through the product, and doing it any other way is a separate act with no
-- audit entry, which is itself the signal.
--
-- ## Why the subject is absent
--
-- Every cabal action names what it is about, because the verb alone does not
-- say. This one does: the wallet being withdrawn is the wallet that signed, so
-- the subject is already on the `Wallet:` line of the message. It is the same
-- shape as `/registro`'s two actions, and it means the proof cannot be pointed
-- at somebody else's wallet even in principle -- there is no field to point.

ALTER TABLE wallet_proof_nonce DROP CONSTRAINT IF EXISTS wallet_proof_nonce_action_check;
ALTER TABLE wallet_proof_nonce
  ADD CONSTRAINT wallet_proof_nonce_action_check
  CHECK (action IN (
    'alta de perfil',
    'agregar wallet',
    'crear cabal',
    'pedir entrar al cabal',
    'aceptar solicitud',
    'rechazar solicitud',
    'expulsar del cabal',
    'transferir el cabal',
    'nombrar co-líder',
    'revocar co-líder',
    'ver solicitudes',
    'ver mi solicitud',
    'reclamar cabal',
    'retirar wallet'
  ));

-- When it was withdrawn, so a KOL page can say "this wallet stopped being
-- indexed on D" rather than having the row simply stop mattering. Nullable, and
-- null for every wallet still active.
ALTER TABLE kol_wallet
  ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;

-- The admin nominates; the nominee claims with their own signature.
--
-- `docs/round-reasignacion.md` §3 proposed this and left it at the door; the
-- owner opened it on 2026-09-05. **The direct handover is gone.** What replaces
-- it is two acts by two people, and the second one is signed.
--
-- ## Why this is not the same feature with a step added
--
-- The direct version was the only write in the cabal system that no party
-- signed: the outgoing leader could not — that is the premise — and the incoming
-- one was never asked. The story it made available was "the operator quietly
-- moved a group to an ally", and no audit trail could distinguish it from a
-- repair, because every row in that trail would be genuine.
--
-- The outgoing leader still cannot sign. **The incoming one can**, and that is
-- the whole of the fix: a nomination decides nothing on its own, and the cabal
-- changes hands only when the beneficiary proves a wallet against a nonce this
-- server issued. The ally has to sign for it, in public.
--
-- Until the claim, the cabal **stays orphaned**: the nomination writes no leader
-- and nothing about the ranking, the members or the tag changes. That is the
-- safe direction — an unclaimed nomination leaves the world exactly as it was.
--
-- ## Seven days
--
-- A nomination is a human-coordination window: somebody has to be told out of
-- band, open a wallet and sign. A day is not enough for a person who is
-- travelling; a month is a live claim on a group sitting in the database long
-- after everyone has forgotten the conversation. Seven days covers a week away
-- and expires while the reason is still fresh enough to write again.
--
-- **Expiry is checked, never indexed.** `WHERE expires_at > now()` in an index
-- predicate is refused by Postgres — `functions in index predicate must be
-- marked IMMUTABLE` — and `migrations/016` has the longer version of why that
-- refusal is correct. So `status` carries the fact, the partial unique index
-- covers `pending`, and the nominate path cancels an expired row before it
-- writes a new one. An expired nomination that nobody swept is still refused at
-- claim time, because the handler compares the clock.

CREATE TABLE IF NOT EXISTS cabal_nomination (
  id           UUID PRIMARY KEY,
  cabal_id     UUID NOT NULL REFERENCES cabal (id),
  kol_id       UUID NOT NULL REFERENCES kol (id),
  -- Mandatory, and **never published**. `docs/round-reasignacion.md` §3: a
  -- reason describes somebody's circumstances -- a lost wallet, a suspension --
  -- and putting it on a public page would turn a repair into a punishment. It
  -- is here and in `audit_log`, both of which only the operator reads.
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','claimed','cancelled')),
  nominated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  claimed_at   TIMESTAMPTZ
);

-- One live nomination per cabal. Two pending ones would be two people each
-- holding a claim on the same group, and whichever signed first would win a race
-- neither of them knew they were in.
CREATE UNIQUE INDEX IF NOT EXISTS cabal_nomination_one_pending
  ON cabal_nomination (cabal_id)
  WHERE status = 'pending';

-- The admin screen reads its own queue; the claim path looks one up by cabal.
CREATE INDEX IF NOT EXISTS cabal_nomination_by_kol
  ON cabal_nomination (kol_id, status);

-- Who claimed it, so the public notice can name them even after a later
-- transfer moves the cabal on again. `reassigned_at` (migration 021) is now set
-- at the moment of the CLAIM, not of the nomination: nothing was reassigned
-- until somebody signed for it.
ALTER TABLE cabal
  ADD COLUMN IF NOT EXISTS reassigned_to_kol_id UUID REFERENCES kol (id);

-- The eleventh signed action. `DECISIONES.md`: adding one is TWO changes, this
-- CHECK and `PROOF_ACTIONS`; `wallet-proof-store.test.ts` compares the two lists
-- in both directions so neither half can drift.
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
    'reclamar cabal'
  ));

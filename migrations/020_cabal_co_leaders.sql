-- Two co-leaders per cabal, appointed by the leader, and the queue reads that
-- only they may make.
--
-- `docs/round-cabals.md` §5, decided by the owner on 2026-09-05. Two answers,
-- and the first one changes a shape rather than adding to it.
--
-- ## Why the column had to become a table
--
-- `migrations/016` gave `cabal` a single `co_leader_kol_id`, because §4's
-- decision only needed somebody to transfer to. **The cap is two**, and two does
-- not fit in one column. The options were a second column or a table, and a
-- second column is the one that looks cheaper and is not: every query learns to
-- say `co_leader_kol_id = $1 OR co_leader_2_kol_id = $1`, and the day the cap
-- becomes three, every one of them is wrong in a way that still runs.
--
-- **`slot` is what makes the cap a constraint instead of a count.** With
-- `CHECK (slot IN (1,2))` and `UNIQUE (cabal_id, slot)`, a third appointment has
-- nowhere to go and the database says so. The alternative — counting rows in the
-- handler and refusing at three — is a read-then-write, and two appointments
-- arriving together both read two and both write. That is the same reasoning
-- `cabal_tag_held` and `wallet_proof_nonce` already use: the race is decided by
-- an index or it is not decided.
--
-- ## The co-leader is not the leader, and that needs a trigger
--
-- `cabal_co_leader_distinct` was a CHECK while both sides lived on one row. They
-- do not any more: the leader is on `cabal`, the deputy is here, and a CHECK
-- cannot read another table. So it is a trigger — a small one, and honest about
-- what it is: this guards **data integrity**, not an adversary. The owner can
-- drop it, exactly as `migrations/018` says of its own, and that matters less
-- here because nothing security-relevant rests on it — the handlers check the
-- same thing, and this is the backstop for the paths nobody wrote yet.

CREATE TABLE IF NOT EXISTS cabal_co_leader (
  cabal_id  UUID NOT NULL REFERENCES cabal (id),
  kol_id    UUID NOT NULL REFERENCES kol (id),
  -- 1 or 2. The cap, as a constraint rather than as arithmetic.
  slot      SMALLINT NOT NULL CHECK (slot IN (1, 2)),
  -- Who appointed them, and when. A co-leader is authority delegated by a
  -- person, and the trail should not have to infer which person.
  named_by_kol_id UUID REFERENCES kol (id),
  named_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cabal_id, kol_id)
);

-- The cap. Two rows may exist per cabal because there are two slots.
CREATE UNIQUE INDEX IF NOT EXISTS cabal_co_leader_slot
  ON cabal_co_leader (cabal_id, slot);

-- One cabal per KOL is `kol.cabal_id`'s shape, so being a deputy of two cabals
-- at once is not a state this product has.
CREATE UNIQUE INDEX IF NOT EXISTS cabal_co_leader_one_cabal
  ON cabal_co_leader (kol_id);

CREATE OR REPLACE FUNCTION cabal_co_leader_is_not_leader() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cabal WHERE id = NEW.cabal_id AND leader_kol_id = NEW.kol_id
  ) THEN
    RAISE EXCEPTION 'a cabal leader cannot also be its co-leader'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cabal_co_leader_distinct_trg ON cabal_co_leader;
CREATE TRIGGER cabal_co_leader_distinct_trg
  BEFORE INSERT OR UPDATE ON cabal_co_leader
  FOR EACH ROW EXECUTE FUNCTION cabal_co_leader_is_not_leader();

-- Whatever the single column held becomes slot 1. `named_by_kol_id` is NULL for
-- these: they were placed by the operator before there was an action that could
-- place one, and inventing a leader who appointed them would be a fact the trail
-- does not have.
INSERT INTO cabal_co_leader (cabal_id, kol_id, slot, named_by_kol_id)
SELECT id, co_leader_kol_id, 1, NULL
  FROM cabal
 WHERE co_leader_kol_id IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE cabal DROP CONSTRAINT IF EXISTS cabal_co_leader_distinct;
ALTER TABLE cabal DROP COLUMN IF EXISTS co_leader_kol_id;

-- The four actions §5 adds, two that write and two that read.
--
-- **The reads are signed too, and that is the decision showing its price.** With
-- no KOL session there is nothing to remember that a leader is a leader, so
-- "show me my queue" has to prove it the same way "accept this person" does: a
-- nonce, a signature, one use. It costs a wallet prompt per panel load, which is
-- what `docs/round-cabals.md` §4's *no session* buys everywhere else.
--
-- `DECISIONES.md`: adding a signable action is TWO changes, this CHECK and
-- `PROOF_ACTIONS` in `src/lib/wallet-proof.ts`. `wallet-proof-store.test.ts`
-- compares the two lists in both directions, so neither half can drift.
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
    'ver mi solicitud'
  ));

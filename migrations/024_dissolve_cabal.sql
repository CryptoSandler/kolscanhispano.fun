-- `disolver cabal`: the fifteenth signed action, and the one that finally makes
-- `dissolved_at` reachable.
--
-- ## The column was written by nothing
--
-- `migrations/016` added `dissolved_at` and three places read it — the orphan
-- list, the tag release, the join and claim paths — but **no code path ever set
-- it**. Verified 2026-09-05: every write outside tests was absent. So a cabal
-- could not be dissolved at all, `scripts/release-cabal-tags.ts` had nothing to
-- release, and the thirty-day rule the owner decided in `docs/round-cabals.md`
-- §4 was a rule about a state the product could not reach.
--
-- This is the writer. There is exactly one, it is signed, and it is the leader's.
--
-- ## Only the leader, and no automatic path
--
-- Not a co-leader: a deputy who could dissolve the group could destroy what they
-- were lent, and the two things a deputy may not do — hand the cabal on, and end
-- it — are the same rule seen twice. Not the admin either, and not a timer.
-- `docs/round-reasignacion.md` argued the general case: the operator does not get
-- verbs that decide who owns what, and ending a group is that verb at its
-- sharpest.
--
-- ## What dissolving does, and what it deliberately does not
--
-- It stamps `dissolved_at` and nothing else. The members stay members, the name
-- stays, the history stays, and the cabal stops appearing where a live one
-- appears. **The tag is not released here** — `release-cabal-tags.ts` does that
-- thirty days later, on the cron that already exists, because the owner's
-- decision was that a tag is held while it is in use and for a month after. A
-- tag released the moment somebody dissolves a group is somebody's identity
-- handed to a stranger the same afternoon.

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
    'retirar wallet',
    'disolver cabal'
  ));

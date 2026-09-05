-- When a cabal was handed to a new leader by the operator.
--
-- `docs/round-reasignacion.md` is the round `CLAUDE.md` requires before a rule
-- like this one, and §3 is what it concluded. This column is the public half:
-- **that** it happened and **when**, on the cabal itself.
--
-- The **reason is mandatory and does not live here.** It goes to `audit_log`,
-- because a reason describes a person's circumstances — a lost wallet, a
-- suspension — and publishing it would turn a repair into a punishment. What the
-- public surface owes a reader is that the group changed hands by an act of the
-- operator rather than of its leader, and on what date.
--
-- Nullable, and null is the ordinary state: almost every cabal is one nobody
-- ever had to repair.
ALTER TABLE cabal
  ADD COLUMN IF NOT EXISTS reassigned_at TIMESTAMPTZ;

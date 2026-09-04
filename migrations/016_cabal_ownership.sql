-- Cabals owned by a KOL rather than by the operator.
--
-- `docs/round-cabals.md` is the round `CLAUDE.md` requires before a change to
-- what a rule decides, and §4 is the owner's decision on the three questions it
-- left open. Every column here exists because one of those answers needs it.
--
-- **What this migration is not.** It adds no session table and no token: the
-- decision was *signature per action*, so authority is proved per request over a
-- server-issued nonce, exactly as `/registro` already does. There is nothing
-- here to steal, replay or forget to expire.

-- The owner, the co-leader, and the two fields a leader chooses.
--
-- `leader_kol_id` is nullable and that is a state, not a gap: **an orphaned
-- cabal** — a leader gone with no co-leader to transfer to. The round: it keeps
-- existing, keeps its members and keeps ranking, and only the admin may
-- reassign it, with a reason in `audit_log`. A NOT NULL here would force the
-- operator to invent a leader, which is the thing the decision refuses.
--
-- `co_leader_kol_id` moved out of "batch B" for the same reason: it is what
-- makes a transfer possible at all, so the rule that depends on it cannot ship
-- without it.
ALTER TABLE cabal
  ADD COLUMN IF NOT EXISTS leader_kol_id    UUID REFERENCES kol (id),
  ADD COLUMN IF NOT EXISTS co_leader_kol_id UUID REFERENCES kol (id),
  ADD COLUMN IF NOT EXISTS x_handle         CITEXT,
  -- One of the four measured tints, by name. `DESIGN.md`'s contrast table is a
  -- claim about a fixed set of colours, and a free-form value would put an
  -- unmeasured colour on a public surface -- so the CHECK is the palette.
  ADD COLUMN IF NOT EXISTS color            TEXT CHECK (color IN ('a','b','c','d')),
  -- Which principal created it, because the carve-out needs to know: `/admin`
  -- refuses to edit a leader-created cabal except for a takedown or an orphan
  -- reassignment. **Not published anywhere**: the mechanism exists, the promise
  -- does not (`CLAUDE.md`, Decisions with a door).
  ADD COLUMN IF NOT EXISTS created_by       TEXT NOT NULL DEFAULT 'admin'
                                            CHECK (created_by IN ('admin','leader')),
  -- When the group dissolved. The tag's 30 days are counted from here, so this
  -- is the column that makes "released 30 days after, never reclaimed while in
  -- use" a fact the database can answer rather than a convention.
  ADD COLUMN IF NOT EXISTS dissolved_at     TIMESTAMPTZ;

-- A co-leader who is also the leader is not a second person, and a transfer to
-- oneself is a no-op that reads as a change in the audit trail.
ALTER TABLE cabal
  DROP CONSTRAINT IF EXISTS cabal_co_leader_distinct;
ALTER TABLE cabal
  ADD CONSTRAINT cabal_co_leader_distinct
  CHECK (co_leader_kol_id IS NULL OR co_leader_kol_id IS DISTINCT FROM leader_kol_id);

-- **The tag rule, and why the thirty days are an event rather than a predicate.**
--
-- `tag` was `UNIQUE` outright, which cannot express "free 30 days after the
-- group dissolved". The obvious replacement is a partial unique index —
-- `WHERE dissolved_at IS NULL OR dissolved_at > now() - INTERVAL '30 days'` —
-- and **Postgres refuses it**: `functions in index predicate must be marked
-- IMMUTABLE`. It is right to. An index whose membership changed with the clock
-- would be silently wrong the moment a row aged past the window without being
-- rewritten, and nothing would rebuild it.
--
-- So holding a tag becomes a **fact in a column** instead of a computation:
-- `tag` goes nullable, uniqueness applies to whoever still holds one, and
-- releasing is a write. `scripts/release-cabal-tags.ts` nulls the tag of any
-- cabal dissolved more than thirty days ago; until it runs, the tag is held,
-- which is the safe direction — a tag released late is an inconvenience, one
-- released early is somebody's identity handed to a stranger.
--
-- Why the index and not a check in the request handler: two requests claiming
-- the same freed tag in the same millisecond both read "free" and both write. A
-- database constraint is the only thing that decides that race — the same
-- reasoning `wallet_proof_nonce` uses for burning a nonce inside the
-- transaction that accepts it.
--
-- The dissolved cabal keeps its `name` and its history; only the three or four
-- letters go back into the namespace.
ALTER TABLE cabal DROP CONSTRAINT IF EXISTS cabal_tag_key;
ALTER TABLE cabal ALTER COLUMN tag DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cabal_tag_held
  ON cabal (tag)
  WHERE tag IS NOT NULL;

-- A KOL asking to join a cabal, and the leader's answer.
--
-- `kol.cabal_id` already makes "one cabal per KOL" structural, so this table is
-- only about the *asking*: it never holds membership, and accepting a request
-- writes `kol.cabal_id` and closes the row.
--
-- `status` rather than deleting the row: a rejection is information the leader
-- and the applicant both acted on, and a table that forgets it invites the same
-- request every day. `decided_by_kol_id` is who answered — a leader or a
-- co-leader, and the audit trail should not have to guess which.
CREATE TABLE IF NOT EXISTS cabal_request (
  id                UUID PRIMARY KEY,
  cabal_id          UUID NOT NULL REFERENCES cabal (id),
  kol_id            UUID NOT NULL REFERENCES kol (id),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','accepted','rejected','withdrawn')),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at        TIMESTAMPTZ,
  decided_by_kol_id UUID REFERENCES kol (id)
);

-- One live request per KOL per cabal. A KOL may ask again after a rejection —
-- the partial index only constrains `pending` — but cannot flood one cabal's
-- queue with the same ask.
CREATE UNIQUE INDEX IF NOT EXISTS cabal_request_one_pending
  ON cabal_request (cabal_id, kol_id)
  WHERE status = 'pending';

-- The leader's panel reads its own queue, oldest first.
CREATE INDEX IF NOT EXISTS cabal_request_queue
  ON cabal_request (cabal_id, requested_at)
  WHERE status = 'pending';

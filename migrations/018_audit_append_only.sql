-- `audit_log` becomes append-only, and every row commits to the one before it.
--
-- `docs/round-cabals.md` §4: a cabal's mutations are authorised by a signature
-- and recorded here. That makes this table the only account of who did what to
-- a group they own — so the two ways of quietly rewriting history have to be
-- closed, and they are different problems with different answers.
--
-- ## 1. Append-only, by trigger and not by GRANT
--
-- The obvious move is `REVOKE UPDATE, DELETE ON audit_log`. It does nothing
-- here: the application connects as `neondb_owner`, the table's owner, and an
-- owner is not subject to its own grants. A revoke would read like a control in
-- the schema and stop nothing at all — the worst kind, because it would be
-- believed.
--
-- A trigger binds regardless of role for the *statements*: `BEFORE UPDATE OR
-- DELETE` raising is what the application actually meets, which is what makes
-- it testable from the application's own connection rather than from a role
-- nobody uses.
--
-- **And it is a tripwire, exactly like the hash chain below — not a guarantee.**
-- The same owner the trigger stops from running `DELETE` can run
-- `DROP TRIGGER audit_log_no_update` and then run it. What this closes is the
-- accident and the casual edit: a console session, a migration that "fixes" a
-- row, a handler that meant to update. It does not close an operator who
-- decides to rewrite the account, and no in-database control can. Saying
-- otherwise would be the kind of security claim `SECURITY.md` refuses to make —
-- and the claim would be worse than nothing, because it would be believed.
--
-- Truncation is a third verb and needs its own trigger: `TRUNCATE` fires
-- neither `UPDATE` nor `DELETE`, and a table emptied wholesale is exactly the
-- deletion this rule is about.
--
-- ## 2. The chain, and what it is honestly worth
--
-- Each row stores `prev_hash` — the `row_hash` of the row before it — and its
-- own `row_hash` over its content plus that link. Removing or altering a row in
-- the middle breaks every link after it, so tampering stops being invisible and
-- becomes a mismatch anybody can recompute.
--
-- **It is a tripwire, not a proof.** Whoever can write rows can also rebuild the
-- chain from the point they changed. What it defends against is the realistic
-- case — an edit through a console, a migration that "fixes" a row, a bug that
-- rewrites history — and not an attacker with write access and patience. Saying
-- otherwise would be the kind of security claim `SECURITY.md` refuses to make.
--
-- ## 3. The signature that authorised it
--
-- `nonce` records which proof paid for the row. The nonce is single-use and
-- already burnt in the same transaction that accepted the signature, so this is
-- the join between "a leader signed something" and "this happened": an entry
-- with no nonce was not signed for, and two entries with one nonce are a replay.
-- The signature itself is deliberately **not** stored — it is not needed to
-- verify the account, and a stored signature is a credential-shaped value in a
-- table that gets read.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS subject   TEXT,
  ADD COLUMN IF NOT EXISTS nonce     TEXT,
  ADD COLUMN IF NOT EXISTS prev_hash TEXT,
  ADD COLUMN IF NOT EXISTS row_hash  TEXT;

-- One entry per nonce. The nonce is already single-use, so this is the second
-- half of the same statement: a replay cannot show up twice in the account even
-- if some future path forgets to burn it first.
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_nonce_once
  ON audit_log (nonce)
  WHERE nonce IS NOT NULL;

CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

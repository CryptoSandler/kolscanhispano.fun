-- What a signature is *about*, not just what it is *for*.
--
-- `docs/round-cabals.md` §4: cabal actions are proved per request, with no
-- session. That works for `/registro`, where "alta de perfil" has exactly one
-- possible target — the wallet doing the signing. It does **not** work for a
-- leader's panel.
--
-- **The hole it closes.** `wallet_proof_nonce` binds a nonce to
-- `(address, chain, action)`. A leader signing `aceptar solicitud` therefore
-- proves they authorised *an* acceptance, not *which one*: the same signature
-- satisfies the verifier for every pending request in that cabal. One bug in a
-- handler, one race between two open tabs, and the proof a leader produced for
-- Ana admits Beto instead — and the audit trail would record it as the leader's
-- own decision, because cryptographically it is.
--
-- So the nonce carries the subject, set when it is issued and compared when it
-- is consumed. A signature cannot be pointed at anything else afterwards,
-- because the server never asks the client what the subject was.
--
-- **And the subject is named in the signed text too** (`wallet-proof.ts`
-- renders a `Sobre:` line). Those are two different jobs and both are needed:
-- the column stops a signature being redirected, and the line is what lets the
-- person reading their wallet prompt see whether they are admitting the KOL
-- they meant to admit. A prompt that says only `Acción: aceptar solicitud` asks
-- somebody to approve a decision they cannot see — which is the shape
-- `docs/wallet-warnings.md` exists to refuse.
--
-- `NULL` for the two `/registro` actions, whose subject is the signer.

ALTER TABLE wallet_proof_nonce
  ADD COLUMN IF NOT EXISTS subject TEXT;

-- **And the action list, which Postgres was already enforcing.**
--
-- `wallet_proof_nonce.action` carries a CHECK naming the two registration
-- actions. Widening the TypeScript union without widening this one produced
-- exactly the right failure — `violates check constraint
-- wallet_proof_nonce_action_check` — the first time a cabal nonce was issued.
--
-- The constraint is kept rather than dropped, and that is the point: the union
-- in `wallet-proof.ts` and the values this column accepts are two statements of
-- the same rule, and the day they disagree the database refuses the write
-- instead of storing an action nothing can verify. A `TEXT` with no CHECK would
-- have taken `'aceptr solicitud'` and failed silently at comparison time.

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
    'transferir el cabal'
  ));

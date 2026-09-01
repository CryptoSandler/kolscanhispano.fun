-- The one-time code a KOL tweets, and what came back when we checked it.
--
-- Spec §6 verifies a handle with *"a tweet with a one-time code"*. The code has
-- to live somewhere between issuing it and reading it back, and it belongs on
-- the KOL rather than in a session: the person may tweet an hour later, from
-- another device, after the browser that registered them is long closed.
--
-- **`tweet_verified_at` is not approval.** `DECISIONES.md`, 2026-08-31: a KOL
-- is invisible on every public surface until an admin approves them, and the
-- tweet is what the admin looks at rather than what replaces them. Two columns
-- for two facts, because collapsing them would make a successful oEmbed read
-- into a publication decision.
--
-- `tweet_url` is stored so the admin can open the thing they are approving.
-- It is a public post by a public account, which is why it is the one
-- identifier in this schema that is neither encrypted nor hashed.

ALTER TABLE kol ADD COLUMN IF NOT EXISTS verification_code TEXT;
ALTER TABLE kol ADD COLUMN IF NOT EXISTS tweet_url TEXT;
ALTER TABLE kol ADD COLUMN IF NOT EXISTS tweet_verified_at TIMESTAMPTZ;

-- The code identifies one registration, so two KOLs must never share one --
-- otherwise a tweet carrying it would verify whichever row was looked up first.
-- Partial, because every KOL created by the admin has no code at all and NULLs
-- would otherwise collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS kol_verification_code_idx
  ON kol (verification_code) WHERE verification_code IS NOT NULL;

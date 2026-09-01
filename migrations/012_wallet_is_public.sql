-- Per-wallet publication, replacing the per-KOL flag.
--
-- `DECISIONES.md`, 2026-08-31: the visibility decision belongs to the wallet,
-- not to the KOL. Someone who separates their operation publishes one wallet
-- and keeps another, and a single `kol.hide_wallets` cannot express that -- it
-- forces them to publish everything or nothing.
--
-- **The default is `false`, and unlike migration 011's `chain` default this one
-- is permanent.** There the default was a scaffold with a ceiling written into
-- it; here it is the answer. A wallet that arrives without an explicit choice
-- is private, because the two mistakes are not symmetric: a private wallet
-- shown as private is a wallet nobody sees, while a private wallet published
-- by accident cannot be un-published. It stays in caches, in screenshots, and
-- in the memory of whoever saw it. So the direction of the default is the
-- direction of the recoverable error.
--
-- `kol.hide_wallets` is deliberately **not** dropped here. It still has a
-- writer (the admin edit path, spec §9) and dropping a column while something
-- writes it turns an opt-in into a runtime error. It loses its readers in the
-- same batch that adds them here, and it is annotated in `docs/spec-v1.md` as
-- superseded so it does not repeat `key_version`'s history: a column nobody
-- reads, kept because nobody wrote down that it was finished.

ALTER TABLE kol_wallet
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;

-- No index. The two queries that will read this both already have one: the
-- KOL detail page reads a single KOL's wallets through `kol_wallet_kol_idx`
-- and filters a handful of rows, and the public invariant test hashes by blind
-- index. ponytail: add a partial index on `(kol_id) WHERE is_public` only if a
-- KOL ever carries enough wallets for the filter to matter -- which, for a
-- curated roster, is not a shape this table is expected to take.

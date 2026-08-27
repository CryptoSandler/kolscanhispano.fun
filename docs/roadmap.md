# Roadmap

What comes next and why, in order. Written down rather than remembered, so a
priority that moved has a reason attached to it and does not move back by
accident.

Nothing here is built. Each entry is a batch, not a task.

---

## 1. Requeue — the recovery path that does not exist

**Blocking. Everything downstream of ingestion is wrong without it.**

Nothing anywhere clears `raw_tx.parse_error`, and the pending query filters
`parse_error IS NULL`. Every refusal is therefore permanent, including the ones
whose whole purpose was to be temporary.

Measured against 2,397 real mainnet swaps in batch 2: **123 of them, 5.1%**,
reach `unsupported_quote_no_rate` — a stablecoin-quoted swap that found no
`sol_price` row for its block's minute. `solUsdForMinute` needs that exact
minute; `refreshSolPrice` writes one row per five-minute run and runs *after*
`parsePending` in the same workflow, so the rate is essentially never there at
parse time and never looked for again. `malformed_payload` sits in the same
trap.

What the batch has to decide, and why it is a batch and not a task:

- which `parse_error` values are requeueable and which are settled — the parser
  already distinguishes them in prose, but nothing acts on the distinction
- whether `sol_price` backfills by minute, and from what source
- backoff, so a permanently unvaluable row is not retried for ever
- what a row that has exhausted its retries becomes

## 2. Raw `getTransaction` + per-venue decoders

**Raised in priority. Was "someday"; is now the batch after the requeue.**

Two independent reasons, both established by measurement rather than by
preference:

**The base is legacy.** Helius's own docs now mark the Enhanced Transactions
API *"a legacy product in maintenance mode… not receiving new parser types or
feature work"* (read 2026-08-26). Its successor, Parsed Events, is open beta
**on paid plans**. The entire ingestion path — webhook shape, parser, fixtures
— rests on a payload format that has stopped moving while Solana's venues have
not. A venue that ships after the freeze is a venue this project cannot read.

**It is the honest fix for two things already deferred.** `instructionIndex` is
synthetic because Helius nets balance changes at transaction level, so two
swaps of the same mint in one transaction are indistinguishable from one. And
the residue bound in `parse-swap.ts` exists only because the payload states
rent inconsistently; raw instruction data states it exactly. Both were closed
in batch 2 with the best available approximation and a comment naming the
ceiling. This is the upgrade path those comments point at.

Cost is real and should not be discovered mid-batch: `getTransaction` is 1
credit against Enhanced Transactions' 100, so the raw path is *cheaper* per
transaction — but a decoder per venue is ongoing work that the enhanced API was
buying, and there were 9 distinct venues in a 2,397-transaction sample.

**Order matters:** after the requeue, not before. A batch that changes what the
parser reads while there is still no way to re-parse anything would have to get
it right on the first pass for every historical row.

---

## Deferred, with the reason each is not urgent

- **`token_amount` and `fee_sol` reach `numeric` through a JS double.** 4 of
  1,312 real trades differ from the on-chain quantity by one raw unit, 1e-16
  relative. Cannot flip a decision or change a rendered figure. Fold into
  whichever batch next touches `insertTrade`.
- **Rent leaks for non-token accounts.** Any wallet-owned account a swap can
  close — open-orders, stake, nonce, a router PDA — is refunded outside the
  residue bound's sight. A floor that covered it (0.023 SOL/account) would
  refuse most genuine small trades. Item 2 above closes this properly.
- **Multichain, alerts, KOL-page ornaments, token tracker.** Product scope,
  deliberately out of v1.

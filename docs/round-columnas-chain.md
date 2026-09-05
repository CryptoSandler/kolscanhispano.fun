# Round: per-chain columns and one consolidated number — 2026-09-05

`CLAUDE.md` requires a round without code before a change to what a number means.
This is one: today a KOL's realized PnL is a quantity of SOL, and the proposal
makes it a **set of per-chain quantities with a USD total**. Every figure on the
home page changes meaning even when the digits do not move.

## 0. Verified before arguing

- **There is no Alchemy credential on this machine.** Not in this repo's
  `.env.local`, not in any other repo's, not in the ambient environment. Checked
  2026-09-05.
- **`docs/multichain.md` §7 already says what that blocks**: *"Alchemy account +
  one API key … Blocks all of tanda 2."* This round does not re-litigate that; it
  takes it as the constraint it is.
- **The Robinhood contracts are already established** (§ "Las direcciones", batch
  2): two contracts, allowlisted, plus three event *topics* that are not
  addresses. Nothing here needs re-probing.
- `trade` carries `realized_sol` and `realized_usd` per sell since
  `migrations/015`, and `kol_wallet` carries `chain`. **So per-chain realized PnL
  is answerable from today's schema** without any new ingestion.

## 1. The strongest case against

**A consolidated USD total is a claim about prices we do not make anywhere else.**
Every figure on this site today is a SOL amount with a USD *equivalent* beside
it, and `USD_CAVEAT` exists because that equivalent is already the soft half. Sum
three chains into one USD number and the ranking's primary key becomes an
arithmetic result over three price feeds of different quality — one of which
(§4's V4 pools with no native leg) has no feed at all. The number that decides
who is first stops being something anybody can check against a block explorer.

**"Sin cotizar" is honest per row and dishonest in a total.** Showing a position
as unpriced is exactly right. But if the ranking sums what *is* priced and
silently omits what is not, then a KOL whose best trade cannot be priced ranks
below one whose worse trade can, and the board says the opposite of the truth
while every individual cell is correct. The caveat cannot rescue a sort order.

**Columns for chains with no ingestion are columns that will be absent for
months.** With Alchemy blocked, ETH and BNB ship switched off, and Robinhood
ships switched off too. So the visible result of this batch is: the row gains a
layout that renders exactly one column, the modal gains a section with one line,
and the code gains three flags and a per-chain aggregation nothing produces rows
for. That is a lot of surface for a picture of a feature.

**kolscanbrasil is not evidence that this is right.** It is the mould for
*layout*, and this project has copied its geometry deliberately. It is not a
source for what a number should mean. The brief's first line — "hacer visibles
las chains EVM como en kolscanbrasil" — is a design instruction being asked to
carry a modelling decision.

## 2. The collision with the real code

**`pnl_daily` is keyed by `(kol_id, day)`.** §2 of `docs/multichain.md` already
flagged this: a per-chain breakdown changes that key, and it is "cheap now and
expensive after rows exist". Production has rows. So either the breakdown is
computed from `trade` on every read — which is what `leaderboard.ts` and
`cabals.ts` already do since the rolling windows — or `pnl_daily` gets a chain
column and a backfill.

The rolling-window rewrite is the reason this is cheap: **nothing on the ranking
path reads `pnl_daily` any more.** Both queries sum `trade.realized_sol` over
`timestamptz` bounds. Adding `kol_wallet.chain` to that `GROUP BY` is a join this
query already makes.

**`realized_sol` is a column name that will start lying.** It holds "the native
amount realized on the chain this wallet is on". For a Solana wallet that is SOL;
for an Ethereum wallet it is ETH. The name is not wrong today because there is
one chain. It becomes wrong the moment a second one produces a row, and renaming
it is a migration plus every query that mentions it.

**`DESIGN.md` measures the row against the mould at 1440.** A row that gains two
more amounts has to fit, and the podium cards have less width than the list rows.
The overlay gate that this project runs on every visual change is what decides
whether three columns fit, and it cannot run against data that does not exist.

**The no-doxx guard is nearly blind to EVM** (§1 of `docs/multichain.md`, 7.6%).
More EVM surface is more places an address can reach a page, and `hygiene.ts`'s
EVM branch is the newer, less exercised half.

## 3. Recommendation

**Build the display half. Do not build the consolidated USD sort. Ship every
chain flag off.**

Three parts, and the split is the recommendation:

1. **Per-chain realized PnL, computed from `trade` joined to `kol_wallet.chain`.**
   No migration, no `pnl_daily` change, and it answers today for Solana. This is
   the part that is genuinely unblocked and genuinely useful.
2. **The row and the modal render one column per chain that has produced a row**,
   and a chain with no active ingestion is **absent**, never `0.00`. That is the
   brief's own rule and it is right: a zero is a measurement, and we would be
   showing one where we made none.
3. **The ranking keeps sorting by one chain's native amount**, not by a
   consolidated USD total, until there is a second chain producing rows *and* a
   decision about what an unpriced position does to a sort. Sorting by a total
   that silently drops unpriced positions is the one thing here that cannot be
   fixed later without moving people up and down the board.

**On "sin cotizar":** it is a display state on a *position*, and it must also be
a **row-level refusal to contribute to any total**. A position that cannot be
priced is excluded from the USD equivalent *and* the fact of the exclusion is
shown — otherwise the total is a number with an invisible hole. That is buildable
now and testable now, and it is what stops part 3 from being needed urgently.

**On the CU budget:** it cannot be projected. A projection needs the app's
observed request volume and Alchemy's per-method CU table for the plan the
account is on, and neither is reachable from here — there is no key, no app, and
no `arrival` repo on this machine. `docs/multichain.md` §5 has the arithmetic
skeleton from batch 2's research; filling it in is the first thing to do once the
credential exists, and inventing a number now would be exactly the unverified
environment fact `CLAUDE.md` names.

**What I would ask for, in unblocking order** — the same list §7 already has,
unchanged and still accurate: the Alchemy key, the per-chain webhook secrets, and
a decision on the ranking (§2) which this round now recommends deferring.

# The round before Robinhood Chain

`CLAUDE.md`: *"Any change to the model — what a number means, what a rule decides — and any
large product decision gets one round **without code** first."* A second chain is both. This is
that round, written before any code, and it asks for the three things that rule names: the
strongest case against, the collision with the real repository, and an honest recommendation
with standing permission to say don't build this.

Everything below that is a fact about this machine was run, and the command is beside it.

---

## 0. What the brief asserts, and what is actually there

Four of the brief's premises were checked before anything was designed on top of them. Two hold,
two do not.

| Premise | Verified |
|---|---|
| PONS adapter in `~/proyectos/smartmoney` | **Yes.** `src/robinhood/{rpc,budget,cu-log,probe,range}.ts`, 426 lines total |
| `ROBINHOOD_RPC_URL` in its `.env.local` | **Yes** — and **not** in this repository's |
| "los dos contratos allowlisteados" | **Yes, and they are already here** — but they are not the ones smartmoney uses |
| "los 15 KOLs no tienen wallet EVM declarada" | **No: production has 3 approved KOLs and 3 wallets, all Solana** |

    grep -c ROBINHOOD_RPC_URL ~/proyectos/smartmoney/.env.local     # 1
    grep -c ROBINHOOD_RPC_URL ./.env.local                          # 0
    SELECT status, count(*) FROM kol GROUP BY status;               # approved: 3
    SELECT chain, status, count(*) FROM kol_wallet GROUP BY 1,2;    # solana/active: 3

The roster number is the one that matters: **15 is the preview seed, not production.** The
conclusion the brief draws from it is right anyway — the ETH ranking starts empty — but it starts
empty over three KOLs, not fifteen, and the empty state has to read correctly at three.

**The CU figure could not be confirmed.** `~/proyectos/evidencia/arrival/cu-2026-09.jsonl` holds
**two entries totalling 12,182 CU**, which is not "6% + 20% of the free tier" in any reading of
that file. The percentages presumably come from Alchemy's dashboard. That is fine as a source,
but it is not the ledger, and a ceiling enforced against a number nobody can recompute from the
repository is a ceiling that will drift. Either the ledger becomes the source of truth or the
dashboard reading gets written down with its date.

## 1. The strongest case against

**The roster makes this a feature with no users, and the order of work says so.** Zero EVM
wallets are declared. Nothing at all appears on an ETH column until a KOL goes through
`/registro`, signs EIP-191 and is approved — so the entire ingestion path, the pricing path and
the CU budget would run for months over an empty set. The brief even names this and calls for a
first-class empty state, which is the tell: **the deliverable of this batch is an empty state.**
The lazier alternative is one screen — `/registro` offering Robinhood — and nothing else built
until the first wallet is actually registered.

**Reusing smartmoney's code is not free, and "read-only, don't couple" is the expensive version.**
Copying 426 lines across a repository boundary means this project now owns a fork of code that
has a maintainer elsewhere. Every fix in `smartmoney/src/robinhood` after today either gets
re-copied by hand or silently diverges, and the divergence is invisible from both sides. That is
a real cost and it is paid forever, not once.

**A second chain reverses a decision made eight hours ago.** The clone brief of 2026-09-03 says
*"con una sola cadena va una sola cifra; la columna vacía no se muestra"*, and the row was built
to it — one figure, coloured by sign, fiat total in parentheses. The mould shows three chain
columns because it indexes three chains; ours showed one because we index one. Adding `+x ETH`
brings back the column that was deliberately removed, and it will be **empty for every row** for
as long as the roster has no EVM wallet. An empty column is exactly what that decision struck.

**Per-asset quoting is where the measurement gets soft.** The brief says 51% of PONS does not
quote in ETH — USDG and tokenised equities. This project's whole PnL discipline is that a figure
is either measured or withheld: spec §4.5 drops a sell whose basis is unknown rather than
guessing it, and `migrations/015` was just built so that `pnl_daily` and `trade.realized_sol`
withhold **exactly the same rows**. A cross-asset quote is a second price source with its own
staleness, and "realized PnL in ETH" for a position denominated in a tokenised stock is a
derived number several inferences deep. If more than half the venue needs it, more than half the
figures on that column are estimates wearing the same typography as the measured ones.

## 2. The collision with the real code

Read, not remembered — and most of it is good news the brief does not know about.

- **`decimal.ts` is already sized for EVM.** `DECIMALS = 27`, and its own comment says why:
  *"`18 - 9 = 9` on Solana; `18 - 18 = 0` on EVM ... 27 restores the stated margin exactly."*
  Verified against `information_schema.columns` on 2026-09-01. **Nothing in the arithmetic has to
  change.**
- **`migrations/011` already put `chain` into every identifying key**, before the first non-Solana
  row, and it did so precisely because three of those changes are *"unrecoverable if they land
  late"*: `raw_tx.signature_hmac` (the same signed transaction has an identical hash on two EVM
  chains), `trade_unique_idx`, and `token.mint` (CREATE2 puts the same address on several chains).
  This is the single hardest part of a second chain and it is **already done**.
- **`hygiene.ts` already allowlists two Robinhood Chain contracts** — Uniswap V4 PoolManager
  `0x8366…0951` and UniversalRouter `0x8876…0904`, chain 4663 — and its own comment warns that
  widening the rule to "any 0x-prefixed hex" *"would exempt every EVM wallet address in the
  repository, which is the opposite of the point."*
- **And the code we would copy does not use those two.** `smartmoney/src/robinhood/rpc.ts` and
  `src/ingest/curve-log.ts` carry `0x8113…a090`, `0xec36…3d43` and `0x8d4a…35b4` — **three
  addresses, none of them on the allowlist.** Copying that module fails the suite on import, and
  the fix is not mechanical: someone has to establish what each of the three is and whether a
  public contract address belongs in this repository at all. This is the first concrete task, and
  the brief does not mention it.
- **`pnl_daily` cannot tell chains apart** — its key is `(kol_id, day)`, and migration 011's own
  note says *"a chain cannot be back-derived from an aggregate. The ranking stays consolidated in
  USD (that is the product decision, `DECISIONES.md`); the filter is cheap"*. So a per-chain
  column cannot come from the table the ranking reads.
- **But `migrations/015`, merged today, changes that.** `trade.realized_sol` is per sell and
  `trade` carries `chain`, so a per-chain realized figure is now a `SUM ... GROUP BY chain` over
  a table that already has the column. The `+x ETH` column is newly cheap, and it became cheap by
  accident, four hours ago.
- **The money-path rules stay dormant, and EIP-191 is why.** `docs/wallet-warnings.md` rules 1
  and 2 are dormant here because spec §6 makes `/registro` the only wallet surface and it signs a
  *message*. EIP-191 is a message signature, so that holds — provided the Robinhood option signs
  and never builds a transaction. `src/lib/no-money-path.test.ts` is what enforces it and it does
  not need changing.

## 3. Recommendation

**Build it in three batches, in this order, and do not start batch two until a real wallet
exists.**

1. **`/registro` first, alone.** The Robinhood option, EIP-191 per `docs/wallet-proof.md`, Rabby
   appearing in the chooser because it declares 63 EVM chains (`e2e/capturas.spec.ts` already
   documents why it is absent today), the wallet stored with `chain = 'robinhood'`, and the
   admin approving it. **No ingestion, no pricing, no column.** This is the only part with a
   user, and it is what turns the empty set into a non-empty one.
2. **The address question, before any copying.** Establish what `0x8113…`, `0xec36…` and
   `0x8d4a…` are, whether they are public contracts, and allowlist them explicitly in
   `hygiene.ts` with a comment naming each — or decide the adapter is rewritten against the two
   already allowlisted. **This blocks the copy and is a decision, not a task.**
3. **Ingestion and the ETH column last**, once at least one wallet is registered, with the CU
   ledger as the ceiling's source of truth and the `+x ETH` column built on `trade` rather than
   on `pnl_daily`.

**Three things I would change in the brief.**

- **The column shows only when it has a figure.** Not "empty column hidden" as a special case —
  the row already computes its chains from the data, and a chain with no rows produces no column.
  That keeps the decision of eight hours ago intact instead of reversing it.
- **A cross-asset quote is labelled, or it is not printed.** If a position's realized PnL in ETH
  is derived through a USDG or an equity price, it is not the same kind of number as a SOL
  figure, and this product's rule is that absence is rendered as absence. Either the column
  carries only natively-ETH-quoted positions, or the derived ones are marked the way `sin precio`
  marks an unpriced figure. Half a column of unmarked estimates is the failure mode
  `docs/round-ventanas-moviles.md` §1 called *"a different number wearing the label"*.
- **`evidencia/kolscan/cu-<mes>.jsonl` needs the dashboard reading written into it**, dated, or
  the 80% alert fires against a denominator nobody can reproduce.

**And the honest reservation.** If the goal is that this site tracks more than Solana, this is
the right first chain and the repository is unusually ready for it — 011 and `DECIMALS = 27` are
the expensive parts and both are done. If the goal is that the site *look* multichain, the ETH
column over an empty roster does the opposite: it publishes a column of blanks, which reads as a
tracker that is failing rather than as one that is waiting. **Batch 1 alone, shipped, and batch 3
when the first wallet is registered.** That is the recommendation, and the mechanism is the same
either way.

## 4. Open, and the owner's

- Is the roster expected to declare EVM wallets, and roughly when? The answer decides whether
  batch 3 is next week or next quarter.
- Do the three smartmoney addresses belong in this repository at all, or is the adapter rewritten
  against the two already allowlisted?
- The 51% figure: measured where, and does it include the tokenised equities' own price source?

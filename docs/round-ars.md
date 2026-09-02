# The round before `USD · ARS`

`CLAUDE.md`: *"Any change to the model — what a number means, what a rule decides — and any
large product decision gets one round **without code** first."* A second currency is that:
it adds a number to every row whose value is not measured anywhere in this system.

The owner has decided **that** it happens (2026-09-02, with the clone decision). This round
is about **what the number means**, and it is written before the code.

---

## 1. The strongest case against

**A PnL in pesos is a claim nobody can check.** Every other figure on this product is
derived from a chain: `realized_sol` is measured, `realized_usd` is that figure at the
block's own `sol_price` (spec §4.1). An ARS figure is those two multiplied by a third
number that came from outside, was true for one instant, and is not what the reader's own
bank, wallet or exchange would give them. The site's whole premise is that its figures are
honest; the peso column is the first one that is honest only in a footnote.

**And "the" rate does not exist.** Argentina has published several simultaneously for
years: oficial, blue, MEP/bolsa, CCL, mayorista. Verified 2026-09-02 from
`https://dolarapi.com/v1/dolares`:

    oficial   venta 1535   fechaActualizacion 2026-09-01T18:55Z
    blue      venta 1545   fechaActualizacion 2026-09-02T11:55Z
    bolsa     venta 1533.9
    CCL       venta 1592.1

Today the spread between oficial and blue is **0.7 %**, which is the weakest this argument
has been in years — and that is exactly why picking a rate now is dangerous: the choice
looks free today and was a factor of two as recently as 2023. Whatever is chosen has to
survive the gap reopening, printed on a public page, under a name the owner cannot quietly
withdraw.

**The audience argument, restated rather than dismissed.** `docs/parity-kolscanbrasil.md`
§1 refused `ARS` on the grounds that this product serves Spain *and* Latin America, so a
national currency is *"as arbitrary in Madrid as `BRL` is"*. That objection has not been
answered by the clone decision — it has been **overruled**, which is the owner's to do. It
is recorded here rather than deleted, because it is the argument that returns the first
time a reader in Bogotá asks why the second currency is the one it is.

## 2. The collision with the real code

- **`pnl_daily` stores two columns, `realized_sol` and `realized_usd`.** There is no third,
  and `ORDERED` in `src/lib/leaderboard.ts` maps each unit to an `ORDER BY` over a stored
  column. A currency with no column has no ordering.
- **But it needs none.** A single positive rate is a monotone multiple, so the ARS ranking
  is *identical* to the USD ranking, row for row. ARS is therefore a **display** conversion
  over a figure that is already computed and already ordered — no migration to `pnl_daily`,
  no third branch in `ORDERED`, no second sort key.
- **That equivalence dies the moment the rate is per-day.** Converting each UTC day's USD
  at that day's own rate — the arithmetic that matches spec §4.1's "priced at the moment it
  happened" — makes the ARS total a different function of the same rows, and the ordering
  can differ from USD's. That version *does* need a column or a join, and it is a different
  change from this one.
- **`sol_price` is the shape to copy.** A dated table of an outside price, filled by a cron,
  with an explicit state for "no price": `state-unpriced`, `sin precio` in `semantic-stale`,
  already in DESIGN.md and already rendered.
- **The cron has a rule in front of it.** `CLAUDE.md`: `.github/workflows/parse-pending.yml`
  is at five steps and *"the next addition to it justifies **in writing** either why it
  belongs in that file or how the file should be split"*. An FX fetch has no ordering
  dependency on the parse, the requeue or the `sol_price` fill — it is the only step in that
  file that would be independent of every other — which is the argument for **its own
  workflow**, not for a sixth step.
- **`USD derivado del precio de SOL…` already exists** and is printed unconditionally, on
  the page and never behind a hover. The peso caveat is the same shape and goes beside it.
- **Nothing here touches the money path.** `no-money-path.test.ts` is unaffected: this is
  arithmetic on a page.

## 3. Recommendation

**Build it, as a display conversion, and do not decide the rate.**

1. One dated, cited, reproducible rate in storage. **Written as `fx_rate`, built on
   `setting`** — the recommendation named a new table and the code found a rung higher: `setting
   (key TEXT PRIMARY KEY, value JSONB)` has existed since `001_core.sql`, `settings.ts` already
   reads it, and nothing reads the rate historically. A table would have been a migration, a
   Neon branch and a three-database close for one row of state. The date and the source live in
   the value, which is the whole of what this item asked for. The upgrade, if a past figure ever
   has to be reproduced, is that table and one migration; every reader goes through
   `readArsRate`, so nothing above it changes.
2. The conversion is applied to the **USD total already on the row**, at the **latest
   stored rate**, and the ordering stays USD's. The per-day-rate version is a separate
   change with its own round; this one must not be mistaken for it, so the caveat says
   which arithmetic was used.
3. **The source and its date are printed**, in the qualifier line, in words:
   `1 US$ = 1.545 ARS · blue · 2 sep`. A rate without a date is a number pretending to be a
   fact.
4. **Which rate is the owner's open decision**, and the mechanism fits either: `source` is
   a column, the fetch stores every `casa` the endpoint publishes, and switching is one
   configured value — no schema change, no re-fetch, no code. Recorded here as open.
5. **Stale is a state, not a stale number.** No rate for today, or a rate older than the
   window being shown: the peso figure renders `sin precio` in `semantic-stale`, the way an
   unpriced SOL figure does. It never falls back to an older rate silently.

**What is deliberately not built:** a second sort key, a per-day historical conversion, and
any rate this repository computes for itself. All three are the same mistake — inventing a
measurement — and the first two are also the change the fifth item of §8 of
`docs/clone-map.md` (rolling windows) will collide with.

## 4. What was actually built, 2026-09-02

`src/lib/fx.ts` (the rate, its staleness rule and the conversion), `scripts/fetch-fx.ts` and
`.github/workflows/fetch-fx.yml` (its own workflow, per §2), the `USD · ARS` segments, and the
qualifier line that names the rate, the casa and the moment it was quoted. `ARS_FX_SOURCE`
selects the casa and defaults to `blue`.

**Still open, and the owner's:** which dollar. Nothing else about the mechanism depends on it.

**One thing this change cost that is worth stating plainly:** the toggle used to choose the
*ranked* figure, so a reader could rank by USD. That ordering is gone — the ranking is by SOL
whatever the toggle says, which is what the mould does. `leaderboard.ts` and the API's contract
test both record it.

**The honest reservation, in one line:** if the owner's answer to *"which rate"* is "the one
that flatters the number", the correct answer is not to ship the column at all — a currency
chosen for the size of its figures is the same defect as `+0.00 Sol` on fifty rows, in the
other direction.

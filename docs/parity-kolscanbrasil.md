# Parity audit against kolscanbrasil.io

Read side by side 2026-09-02, before launch. Their side is two live screenshots at 1280×900
and 390×844; ours is the same two viewports with the twelve-KOL seed behind them. Captures in
`~/proyectos/evidencia/kolscanhispano/2026-09-02-parity/` — `ellos/` and `nosotros/`, read in
pairs rather than one at a time.

Same provenance rule as `references.md`: neither site declares a licence, **nothing is
copied** — no asset, no logo, no face, no string. What is recorded is structure and hierarchy.

Three verdicts, and every row carries one:

- **se copia** — built in this batch, or already built.
- **no se copia porque \<invariante\>** — a written rule of this product refuses it.
- **no aplica sin datos** — needs the three real KOLs in production, which is blocked on the
  deployment quota until 03:47Z on 3 September.

---

## 1. Header and controls

| | kolscanbrasil.io | nosotros | Verdicto |
|---|---|---|---|
| Wordmark | 🇧🇷 flag + `KOLScan **Brasil**` (Brasil in blue) + subtitle | `kolscanhispano**.fun**` (`.fun` in cyan) + `Clasificación de traders hispanos` | **ya lo teníamos** — same shape, our own accent |
| Nav | `● Trade` (green live dot), `Cabals` | `En vivo`, `Clasificación` | **ya lo teníamos** |
| Wallet action | `🔗 Conectar Wallet` button, bordered pill | `Entrar al padrón` link | **ya lo teníamos.** Spec §6 makes `/registro` the only page that connects, so ours is a link to that page and not a connect button in the chrome |
| Window toggle | `Daily · Weekly · Monthly` | `DIARIO · SEMANAL · MENSUAL` | **ya lo teníamos** |
| Currency toggle | `USD · BRL` | `SOL · USD` | **no se copia porque** `references.md` §6: they serve one country, we serve Spain and Latin America, so `BRL` has no equivalent here — `ARS` would be as arbitrary in Madrid as `BRL` is. SOL is the unit every reader can price against. Adding a national currency stays the owner's decision |
| Title | `KOL Leaderboard` beside the toggles | `Clasificación` as an `h1`, with `PnL realizado · Diario · SOL` under it | **ya lo teníamos**, and ours says which window and unit are on screen |

## 2. The ranking row

| | kolscanbrasil.io | nosotros | Verdicto |
|---|---|---|---|
| Row shape | Cards with gaps and rounded corners | Cards with gaps and rounded corners | **se copia — construido 2026-09-02.** This row said *"no se copia"* on the grounds that cards cannot align a column of figures; a CSS grid with fixed tracks does, so the objection was to the wrong mechanism. `docs/clone-map.md` §2 is the owner's decision that settled it, and §3 below is what made it urgent |
| Podium marking | 🏆 🥈 🥉 emoji, a solid coloured left bar, and a gradient that fades across the row | zero-padded `001` + a tinted ★, and a **flat** wash | **se copia — construido en esta tanda.** The left accent bar and the gradient are in; the emoji are not |
| Podium glyph | full-colour emoji medals | 🏆 🥈 🥉 | **se copia, 2026-09-02.** This row said *"no se copia"* and named the condition — *"it needs DESIGN.md changed first, not worked around"*. DESIGN.md was changed first: the tints now paint the bar and the wash, and the glyph is the mould's |
| Identity | bold name, cabal chip, `𝕏` glyph, then a truncated address **or** `Wallets Ocultas` | bold name over `@handle`, cabal chip, `Wallets ocultas` in grey italic | **ya lo teníamos.** Ours prints the handle, which theirs does not — `references.md` §6: the handle is public identity, the address is the secret |
| Address chip | `0x3719` `EVM`, and `CDus2r +2 ⌄` for several | never | **no se copia porque** SECURITY.md and spec §8: no address on a public surface, truncated included. `address-invariant.test.ts` and `serialize.ts` enforce it |
| Avatar | hotlinked from `pbs.twimg.com` | `/api/avatar/<kol_id>`, proxied and cached | **no se copia porque** spec §6: a hotlink puts X in every visitor's request path and a broken upstream is a broken row |
| PnL colour | negative red; positive in the **chain's** colour — ETH blue, BNB amber, SOL green | positive `semantic-gain`, negative `semantic-loss` | **no se copia porque** we index one chain, so a per-chain palette would encode a distinction that does not exist. DESIGN.md: green and red are direction of money and nothing else |
| PnL sign | `+6.61` / `-0.45`, always signed | `+18,42 SOL` / `-14,60 SOL`, always signed | **ya lo teníamos** |
| Fiat | `(R$79.620,4)` at row end, muted | `(+US$3.100,50)` at row end, muted | **ya lo teníamos** |
| Record | none | none | **se quitó, 2026-09-02.** This row read *"nuestro, y se queda"*; the owner's clone decision removed the column. The fields stay in the payload and in the empty-state rule |
| Cabal chip | solid coloured background, dark text | solid tint, `canvas` text | **se copia, 2026-09-02.** Same four tints, now as grounds rather than as ink; the contrast table measures the pair that is actually on screen |

## 3. The ranking at 390 — the one real defect this audit found

**Theirs keeps the money on screen; ours puts it behind a horizontal scroll.**

At 390 their row wraps: identity and fiat total on line one, the per-chain figures on line
two, both always visible. Ours keeps six fixed columns in a container that scrolls sideways,
so the reader sees `#`, `KOL` and a sliver of `Cerradas` — **the PnL, which is what the
ranking is sorted by and the reason the page exists, is off the right edge**, behind a scroll
nothing announces.

**Verdict: se copia. Built on 2026-09-02, after this audit, and the reverted attempt is
recorded rather than hidden.**
Dropping `Cerradas` and `% ganadas` under a media query was tried and reverted: with
`<colgroup>` and `table-layout: fixed`, `display: none` on the cells does not remove the
columns — the browser still allocates each `<col>`'s width — so the header and body
desynchronised, the KOL column crushed to `C..`, and the PnL cells rendered empty. The
capture is in `nosotros-v2/`. It made the surface worse than it was, so it came out.

What it actually needed was the narrow layout rendered as rows rather than as a table, and
that is what shipped: a `<ul>` of grid cards that wraps below 800px, with the 56px height, the
modal trigger and the no-horizontal-scroll case all still pinned, plus a new case that
measures the PnL **cell** — the assertion whose absence let this ship.

## 4. The KOL modal

Theirs cannot be captured — it is client-rendered and no crawler reaches it. This row compares
against `references.md` §6, which records it from screenshots the owner supplied on
2026-08-27, and is marked there as the one part of that file not verifiable from a URL.

| | kolscanbrasil.io (from the record) | nosotros | Verdicto |
|---|---|---|---|
| Header | photo, name, cabal badge, handle, total PnL, truncated address | same minus the address | **ya lo teníamos** |
| `PNL EVOLUTION` | line chart, point markers, `1D / 7D / 30D` | `PnL acumulado`, `Diario · Semanal · Mensual` | **no se copia porque** spec §4.9 makes every window calendar-aligned UTC and never rolling: `Semanal` is the current ISO week — one day long on a Monday — and is *not* `7D`. DESIGN.md states this. The genre's label loses to the spec's arithmetic |
| `STATS` | PnL Total, Trades, Volume | `PnL total`, `Operaciones`, `Volumen` | **ya lo teníamos** |
| `CHAIN PNL` | one line per chain | one line, SOL | **ya lo teníamos**, at the width one indexed chain justifies |
| `DEFI TRADES` | rows, `PRIVATE` + padlock where hidden | `Operaciones del período`, `PRIVADO` + padlock | **ya lo teníamos** |
| Wallet card | — | `Wallets · públicas N` with a padlock, counts never addresses | **nuestro** (`DECISIONES.md`, 2026-08-31) |

## 5. What genuinely needs the three real KOLs

Short, as expected:

- **The chart with more than one point.** The seed gives each KOL a single closed episode, so
  `PnL acumulado` renders one dot and no line. Whether our line, markers and axis read like
  theirs cannot be judged until a KOL has a week of days behind them.
- **A populated `Operaciones del período` list.** One row today; theirs shows a scrolling log.
- **Cabal badges at real density.** The seed assigns `EJE` and `LAT` to eight of twelve; what
  the row looks like when most KOLs have no cabal is a question only the real roster answers.

Everything else in this document was decided from the captures.

---
version: alpha
name: kolscanhispano
description: "A near-black instrument panel for a Solana trade tracker on #08090a, with hairline-bordered charcoal panels and a single cyan accent (#22d3ee) that never appears on a number. Inter Tight sets display at tight negative tracking; JetBrains Mono with tabular figures sets every figure. Rows run at 36px so a full leaderboard and a live feed fit one screen together, radii stay at 4px, and motion is 120ms and functional — a state changed, not a thing announced. The system reads as a trading instrument: dense, quiet, and legible at a glance."
colors:
  primary: "#22d3ee"
  on-primary: "#04191d"
  primary-hover: "#67e8f9"
  ink: "#f2f4f5"
  ink-muted: "#a8aeb4"
  ink-subtle: "#767d84"
  canvas: "#08090a"
  surface-1: "#101113"
  surface-2: "#16181b"
  surface-3: "#1c1f22"
  hairline: "#212429"
  hairline-strong: "#2f333a"
  semantic-gain: "#2ea043"
  semantic-loss: "#e5484d"
  semantic-neutral: "#767d84"
  semantic-stale: "#967740"
typography:
  display-lg: { fontFamily: "Inter Tight", fontSize: 36px, fontWeight: 600, lineHeight: 1.1, letterSpacing: -1.2px }
  headline:   { fontFamily: "Inter Tight", fontSize: 22px, fontWeight: 600, lineHeight: 1.2, letterSpacing: -0.4px }
  body:       { fontFamily: Inter, fontSize: 13px, fontWeight: 400, lineHeight: 1.45 }
  label:      { fontFamily: Inter, fontSize: 11px, fontWeight: 500, letterSpacing: 0.04em, textTransform: uppercase }
  numeric:    { fontFamily: "JetBrains Mono", fontSize: 13px, fontWeight: 500, fontVariantNumeric: "tabular-nums" }
  numeric-lg: { fontFamily: "JetBrains Mono", fontSize: 17px, fontWeight: 600, fontVariantNumeric: "tabular-nums" }
rounded: { sm: 2px, md: 4px, lg: 6px, pill: 999px }
spacing: { row-height: 36px, gutter: 16px, panel-padding: 14px }
motion:  { data-in: "120ms ease-out", hover: "90ms linear", reduced: "none" }
---

## Overview

Base direction: Linear's design analysis. What was taken is its structure — the deepest dark
canvas in the catalogue, charcoal panels separated by hairlines rather than shadows, one accent
used on the mark and on focus and nowhere decorative, and a technical density that treats the
reader as competent. What was deliberately not taken is its identity: the lavender `#5e6ad2`, the
Linear Display face, and the airy marketing rhythm of the source, which is a promotional page and
not an instrument. Cyan, Inter Tight, and a 36px row are what make this ours.

## Identity

The direction is **Instrumento**. The name is the whole brief: this is a panel someone leaves
open beside their trading, not a page they visit. It is dense, quiet, and answers a glance.

The wordmark is the domain, set in Inter Tight at display weight with the accent on the dot —
no logo, no illustration, no mascot. `kolscanhispano.fun` is the brand, so the name does the
work and nothing has to be drawn.

**The accent is cyan `#22d3ee`, chosen partly because neither reference uses it.** kolscan.io
runs a purple-leaning dark chrome; kolscanbrasil.io declares `theme-color #111315` with no
chromatic accent on the row at all. Reading as the genre must not mean reading as them, and the
accent is the cheapest place to be unmistakably ours. It never touches a figure — see below.

## Colors

`canvas #08090a` under everything. Panels at `surface-1`, hover `surface-2`, selected `surface-3`.
Hairlines separate; shadows do not exist in this system.

**Cyan `#22d3ee` is the only chromatic accent** and it is forbidden on numbers. It marks the
wordmark, the focus ring, the selected timeframe, the live indicator, and one primary action.

**Green and red are reserved for direction of money.** `semantic-gain #2ea043`,
`semantic-loss #e5484d`. No status pill, no validation message, no chart series may use them.
`semantic-stale` marks a price we no longer trust.

### Contrast, measured

WCAG 2.1 relative luminance, computed against `surface-1 #101113` (the panel every row sits on;
`canvas` is darker still, so every ratio there is higher). Measured 2026-08-27, not estimated:

| Token | Ratio | AA normal (4.5) |
|---|---|---|
| `ink #f2f4f5` | 17.12 | PASS |
| `ink-muted #a8aeb4` | 8.44 | PASS |
| `ink-subtle #767d84` | 4.53 | PASS |
| `semantic-gain #2ea043` | 5.60 | PASS |
| `semantic-loss #e5484d` | 4.83 | PASS |
| `semantic-stale #967740` | 4.51 | PASS |
| `primary #22d3ee` | 10.45 | PASS |

Every token clears AA for normal text, which is the bar that matters here because **the figures
are body-sized**. Two were lifted to get there: `ink-subtle` from `#6b7178` (3.83) and
`semantic-stale` from `#8a6d3b` (3.90). Both had passed only the large-text bar, and both are
used at 11–13px on data that means something — a muted label that cannot be read is not muted,
it is missing. `semantic-neutral` follows `ink-subtle` to the same value.

A new colour enters this system only with its measured ratio written into this table.

## Typography

Inter Tight for display and headline with real negative tracking. Inter for body and labels.
**JetBrains Mono with tabular figures for every number** — PnL, percentages, SOL and USD amounts,
token quantities, prices, ages. A column of figures must align on the decimal for its whole
height.

Spanish `es-ES` numerals throughout: `+18,42 SOL`, `1.802,4`, `68,4 %`.

## Layout

12 columns, 1280px maximum, 16px gutters. The 36px row is the point of this direction: the
leaderboard's top ten and the live feed's last eight should share one 900px viewport without
scrolling. Leaderboard is a table with fixed column widths so figures never reflow as data
updates. Feed is a fixed-height column that grows at the top.

## Shapes & Depth

4px radii on panels, 2px on chips, pill only on segmented toggles. Depth is surface steps and
hairlines, never a shadow or a glow.

## Components

**`row-leaderboard`** — 36px, hairline bottom, `surface-2` on hover. Rank in `numeric`
`ink-subtle`; avatar 22px; name `body` 500; cabal tag a 2px chip; `wins / losses` and win rate in
`numeric` `ink-muted`; PnL in `numeric-lg` by sign; secondary unit in `numeric` `ink-subtle`.
Ranks 1–3 carry a 2px cyan bar on the left edge — no medals, no trophies.

**`row-feed`** — 36px, hairline bottom. Avatar, name, verb, amount, token quantity, symbol,
price, relative time right-aligned. Sign colour on the verb and amount only. A new row appears
at the top over `motion.data-in` with no layout shift: the container reserves its height.

**`segmented-window`** — `Diario · Semanal · Mensual` and `SOL · USD` as pill segments, selected
segment `surface-3` with cyan text. Footnote `día UTC` in `label` `ink-subtle`.

**`chip-hidden-wallets`** — `Wallets ocultas` in `label` `ink-subtle` on `surface-2`.

**`state-unpriced`** — `sin precio` in `label` `semantic-stale`, never a dash or a red −100 %.

## Every surface has two states

A surface is not designed until both are. The populated state is the easy half; the empty state
is the one a visitor sees first, and today it is the **only** one they can see — the webhook is
collecting but nothing is parsed, so every surface on this site is empty until the cron secrets
are loaded.

**An empty state says what will be here. It does not apologise.** No "Ups", no "Lo sentimos", no
shrug illustration, no spinner pretending to be progress. It is set in `body` `ink-muted` inside
the same panel and the same hairline the populated state uses, so the page's structure is legible
before its data is — the reader learns the shape of the thing while it is still empty.

It also **never fabricates**: no zeroed rows, no ghost placeholders, no skeleton shimmer standing
in for records that do not exist. kolscan.io's leaderboard was captured twice showing fifty rows
of `+0.00 Sol` from a stalled indexer, which reads as fifty traders who all broke exactly even.
That is the failure this rule exists to prevent: an empty state that lies is worse than an empty
page.

| Surface | Populated | Empty |
|---|---|---|
| `leaderboard` | ranked rows, PnL by sign | `Todavía no hay operaciones cerradas.` / `Aquí va el ranking por PnL realizado del período, en cuanto los KOL del padrón cierren su primera posición.` |
| `feed` | rows arriving at the top | `El feed está esperando la primera operación.` / `Cada compra y cada venta de los KOL del padrón aparece aquí, en cuanto la cadena la confirma.` |
| `leaderboard` row, no closed episodes | win rate figure | `sin cierres` — never `0 %`, which claims a measurement nobody made |
| any figure with no price | the number | `sin precio` in `semantic-stale` — never a dash, never a red −100 % |

The last two are the same rule as the first, applied to one cell instead of one panel: **absence
is rendered as absence, never as a zero.**

## Do's and Don'ts

- **Do** fit the leaderboard and the feed on one screen; that is this direction's whole thesis.
- **Do** fix column widths so a live update never reflows a table.
- **Do** keep cyan off every figure.
- **Don't** use green or red for anything that is not profit or loss.
- **Don't** animate beyond 120ms, and never animate position.
- **Don't** add a medal, a flame, a rocket, or any emoji to a rank.

## Directions considered and rejected

Two other directions were built to the same brief, with mockups of the leaderboard and the feed,
and are kept in `docs/design/` for the record. They were rejected on their merits; do not
reintroduce them piecemeal.

**A — Editorial** (base: Vercel's report-website guidance). Instrument Serif display, amber
accent, 44px rows, 240ms motion. It read well and sat furthest from the crypto genre, which was
its appeal. Rejected because its comfort costs rows: at 44px the leaderboard's top ten and the
live feed cannot share a viewport, and this product is one people leave open. A serif display
also fights the tabular figures it sits above rather than framing them. **Do not** reach back for
the serif, the 44px row, or the 240ms fade.

**C — Terminal** (base: ClickHouse). Pure black, monospace as the default voice, 28px rows, 2px
radii, magenta accent. Its inversion of the source — colouring figures by meaning rather than by
brand — was the right instinct and is preserved here. Rejected because monospace as body text
costs reading speed on everything that is not a number (names, verbs, labels, legal copy), pure
black plus a saturated accent sits close to the contrast floor, and 28px rows are dense past the
point where a glance finds the row it wants. **Do not** reach back for mono body text, the pure
black canvas, or the 28px row.

What survived from both: A's discipline about decoration, and C's rule that a figure is coloured
only by what it means.

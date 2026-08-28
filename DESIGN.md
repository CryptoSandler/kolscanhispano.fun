---
version: beta
name: kolscanhispano
description: "A dark leaderboard-first tracker for Solana KOLs. Near-black #0f1113 ground, panels a step above it, and a podium whose first three rows carry a green, amber and blue tint. Names in bold, hidden wallets in grey italic, cabal tags as coloured chips, circular avatars served from our own origin. One SOL figure per row, signed and coloured, with the USD total in parentheses at the end. Inter sets text, JetBrains Mono sets every figure with tabular numerals. The reference is the kolscan genre; the identity, the accent and every asset are ours."
colors:
  primary: "#22d3ee"
  on-primary: "#04191d"
  primary-hover: "#67e8f9"
  ink: "#eef1f3"
  ink-muted: "#a5adb5"
  ink-subtle: "#7e878f"
  canvas: "#0f1113"
  surface-1: "#16191c"
  surface-2: "#1c2024"
  surface-3: "#23272c"
  hairline: "#2a2f35"
  hairline-strong: "#39404a"
  semantic-gain: "#3ecf7f"
  semantic-loss: "#f2555a"
  semantic-neutral: "#7e878f"
  semantic-stale: "#c9a227"
  podium-1: "#4ade80"
  podium-2: "#fbbf24"
  podium-3: "#7dd3fc"
  podium-1-wash: "#12251a"
  podium-2-wash: "#26200f"
  podium-3-wash: "#101f2b"
  cabal-a: "#a78bfa"
  cabal-b: "#f472b6"
  cabal-c: "#fdba74"
  cabal-d: "#94a3b8"
typography:
  display-lg: { fontFamily: "Inter", fontSize: 30px, fontWeight: 700, lineHeight: 1.15, letterSpacing: -0.8px }
  headline:   { fontFamily: "Inter", fontSize: 20px, fontWeight: 650, lineHeight: 1.2, letterSpacing: -0.3px }
  body:       { fontFamily: Inter, fontSize: 14px, fontWeight: 400, lineHeight: 1.45 }
  name:       { fontFamily: Inter, fontSize: 15px, fontWeight: 700, lineHeight: 1.2 }
  hidden:     { fontFamily: Inter, fontSize: 13px, fontWeight: 400, fontStyle: italic }
  label:      { fontFamily: Inter, fontSize: 11px, fontWeight: 500, letterSpacing: 0.06em, textTransform: uppercase }
  numeric:    { fontFamily: "JetBrains Mono", fontSize: 13px, fontWeight: 500, fontVariantNumeric: "tabular-nums" }
  numeric-lg: { fontFamily: "JetBrains Mono", fontSize: 16px, fontWeight: 600, fontVariantNumeric: "tabular-nums" }
rounded: { sm: 3px, md: 6px, lg: 10px, pill: 999px }
spacing: { row-height: 56px, gutter: 16px, panel-padding: 16px }
motion:  { data-in: "140ms ease-out", hover: "90ms linear", reduced: "none" }
---

## Overview

This direction **supersedes "Instrumento"** (the 36px hairline instrument panel, `#08090a`,
cyan-on-charcoal) by **the owner's decision on 2026-08-27**, after a visual gate on the
preview. The earlier direction is not a rejected alternative to be argued with — it was
built, reviewed and replaced on sight of the reference. What survives from it: the accent,
the tabular-figures rule, the two-states rule, and the prohibition on green and red for
anything that is not money.

What changes: the ground lifts to `#0f1113`, rows grow from 36px to 56px to hold a circular
avatar and two lines of identity, the podium gains medals and tinted rows, and the KOL
detail becomes a modal rather than a page.

The reference is the kolscan genre — **both** kolscan.io (SOL-only, so its row maps
directly) and kolscanbrasil.io (the podium, the badges, the modal). See
`docs/references.md` §6 for what was taken from which and why. Nothing is copied: no asset,
no logo, no face, no string.

## Identity

The wordmark is the domain in Inter 700, with **`.fun` in the accent** — the dot alone is
invisible at 20px, measured rather than assumed. Subtitle:
**"Ranking de traders hispanos"**. No logo, no mascot, no illustration.

**The accent stays cyan `#22d3ee`** and neither reference uses it. It marks the wordmark,
focus rings, the selected tab, and the live indicator. **It never touches a figure.**

## Colors

`canvas #0f1113` under everything — near the ground the genre uses, deliberately not
identical to it. Panels at `surface-1`, hover `surface-2`, selected `surface-3`. Hairlines
separate; there are no shadows except the modal's scrim.

**Green and red are direction of money and nothing else.** `semantic-gain #3ecf7f`,
`semantic-loss #f2555a`. No status pill, no chart series, no validation message may use them.

**The podium is three tints, not three metals.** Rank 1 green, 2 amber, 3 blue — a wash
behind the row (`podium-N-wash`) and the medal glyph in the matching `podium-N`. It is the
reference's gradient, in our palette.

### Contrast, measured

WCAG 2.1, against `surface-1 #16191c`. Measured 2026-08-27:

| Token | Ratio | AA normal (4.5) |
|---|---|---|
| `ink #eef1f3` | 15.56 | PASS |
| `ink-muted #a5adb5` | 7.77 | PASS |
| `ink-subtle #7e878f` | 4.83 | PASS |
| `semantic-gain #3ecf7f` | 8.77 | PASS |
| `semantic-loss #f2555a` | 5.23 | PASS |
| `semantic-stale #c9a227` | 7.30 | PASS |
| `primary #22d3ee` | 9.77 | PASS |
| `primary-hover #67e8f9` | 12.17 | PASS |
| `semantic-neutral #7e878f` | 4.83 | PASS |
| `podium-1 #4ade80` | 10.13 | PASS |
| `podium-2 #fbbf24` | 10.57 | PASS |
| `podium-3 #7dd3fc` | 10.58 | PASS |
| `cabal-a #a78bfa` | 6.02 | PASS |
| `cabal-b #f472b6` | 6.19 | PASS |
| `cabal-c #fdba74` | 9.72 | PASS |
| `cabal-d #94a3b8` | 6.39 | PASS |

The four cabal tints are measured against `surface-2 #1c2024`, the chip's own background;
every other row is against `surface-1`. `ink` on each podium wash: 14.18, 14.28, 14.78 —
all PASS. A new colour enters this system
only with its measured ratio in this table; `design-tokens.test.ts` recomputes every row.

## Typography

**Inter** for all text and **JetBrains Mono** for all figures. Both are SIL Open Font
License — chosen for licence first and proximity second, because a paid face cannot be
identified-and-matched without copying the thing that makes it paid.

**Every figure is tabular**: PnL, percentages, SOL and USD amounts, quantities, prices,
ages, ranks. A column of figures aligns on the decimal for its whole height.

- KOL names are **bold** (`name`, 700). That weight is the row's anchor.
- **`Wallets ocultas` is grey italic** (`hidden`, `ink-subtle`) — the reference sets it
  apart from a real identifier by style, and so do we.

Spanish `es-ES` numerals throughout: `+18,42 SOL`, `1.802,4`, `68,4 %`.

**One documented exception: the avatar monogram is set in `system-ui`.** The fallback avatar
is an SVG served from `/api/avatar/<kol_id>` and consumed inside an `<img>`, which is an
isolated document that cannot reach `next/font`'s `@font-face`. A platform boundary, not an
oversight; it applies only to that glyph, and never to a figure.

## Layout

1280px maximum, 16px gutters. **Rows are 56px** — except `list-defi-trades` inside the
modal, which is 36px: the 56px height exists to carry a circular avatar above a two-line
identity, and a one-line trade row inside a modal has neither.

**Rows are 56px** — enough for a 36px circular avatar, the
bold name, and the handle or `Wallets ocultas` beneath it. Fixed column widths so a live
update never reflows a table.

Header: wordmark and subtitle left, nav centre, unit and window controls plus the wallet
action right.

## Components

**`row-leaderboard`** — 56px, hairline bottom, `surface-2` on hover, whole row clickable and
focusable (it opens the modal). Left to right: rank as zero-padded `numeric` with the medal
glyph on ranks 1–3; 36px circular avatar from `/api/avatar/<kol_id>`; a two-line identity
block — `name` on top, and beneath it the **`@handle`, always**, linked to X, with
`Wallets ocultas` in `hidden` **beside it** where that KOL's wallets are hidden; the cabal
chip; then right-aligned, the SOL figure in `numeric-lg` coloured by sign, and the USD
total in `numeric` `ink-muted` in parentheses.

The handle and the hidden marker are **not alternatives**, and an earlier draft of this
document wrongly wrote them as one. On both references a row carries a handle *and* an
identity chip that is either a truncated address or `Wallets Ocultas`: the handle is public
identity, the wallet is the secret. `hide_wallets` defaults to `TRUE` here, so treating it
as a handle switch would erase the person from almost every row. `Wallets ocultas` occupies
the **address** slot and nothing else.

Ranks 1–3 additionally carry their `podium-N-wash` background.

**`chip-cabal`** — the group's 3–4 letter tag, `label`, `radius-sm`, on `surface-2`, its
text in one of four tints assigned per cabal: `cabal-a` violet, `cabal-b` pink, `cabal-c`
peach, `cabal-d` slate. Four fixed tokens rather than a generated hue, because a generated
one can land on green or red — reserved here for money — or on a podium tint. A fifth cabal
reuses the first: repetition is honest, a colour outside the palette is not.

**`chip-hidden`** — not a chip: `Wallets ocultas` in `hidden`, inline, no border. It occupies
the slot where the reference prints a truncated address, which is what makes it read as
native rather than as something withheld.

**`segmented`** — `Diario · Semanal · Mensual` and `SOL · USD` as pill segments; selected
segment `surface-3` with cyan text. All three windows are real aggregations; none is a
disabled stub.

**`modal-kol`** — opened from a row, dismissible by `Esc`, backdrop click and a close button;
focus trapped; the trigger row regains focus on close. Header: 64px avatar, `name`, cabal
chip, the `@handle` (always, with `Wallets ocultas` beside it where wallets are hidden —
same rule as the row), and the period's total PnL in `numeric-lg` by sign.
**Where the reference prints a truncated address, we print nothing.**

Then, in order: **`card-pnl-evolution`** — a line chart in `semantic-gain` (or
`semantic-loss` when the period is negative) with point markers, `Diario · Semanal ·
Mensual` segments, and a time axis. **Not `1D / 7D / 30D`**, which the reference uses and
which would be false here: spec §4.9 makes every window calendar-aligned UTC and never
rolling, so `Semanal` is the current ISO week — one day long on a Monday — and is not
`7D`. The genre's label loses to the spec's arithmetic; **`card-stats`** — PnL total, trades, volume; **`card-chain-pnl`** — one
line, SOL, because that is every chain we index; **`list-defi-trades`** — the KOL's trades,
each with verb, SOL amount by sign and its USD equivalent, and where the wallet is hidden
the row reads `PRIVADO` with a padlock instead of a signature link.

**`state-unpriced`** — `sin precio` in `semantic-stale`, never a dash, never a red −100 %.

## Every surface has two states

A surface is not designed until both are. **An empty state says what will be here and does
not apologise** — no "Ups", no shrug illustration, no spinner pretending to be progress, and
above all **no zeroed rows**: kolscan.io was captured twice showing fifty rows of `+0.00 Sol`
from a stalled indexer, which reads as fifty traders who all broke exactly even.

| Surface | Populated | Empty |
|---|---|---|
| `leaderboard` | ranked rows, PnL by sign | `Todavía no hay operaciones cerradas.` / `Aquí va el ranking por PnL realizado del período, en cuanto los KOL del padrón cierren su primera posición.` |
| `feed` | rows arriving at the top | `El feed está esperando la primera operación.` / `Cada compra y cada venta de los KOL del padrón aparece aquí, en cuanto la cadena la confirma.` |
| `modal-kol` chart | line with points | `Sin operaciones cerradas en este período.` |
| row, no closed episodes | win rate | `sin cierres` — never `0 %` |
| any figure with no price | the number | `sin precio` |
| `list-defi-trades` | the KOL's trades | `Sin operaciones en este período.` |
| `modal-kol` on a **transient** failure (network, 5xx) | the cards | `No se pudo cargar este KOL.` with a retry |
| `modal-kol` when the KOL is **gone** (404) | the cards | `Este KOL ya no está en el padrón.` — **no retry**, and the row leaves the list when the modal closes |
| `modal-kol` while loading | the cards | **no copy at all** — the cards reserve their height and stay blank. `Cargando…` is a spinner in words, and this system does not ship spinners |

Absence is rendered as absence, never as a zero.

**A failure state must not offer an action that cannot work.** A KOL withdrawn or suspended
between the list's render and the click is gone, not unreachable: a retry button there is a
control that is guaranteed to fail, which `Do's and Don'ts` already forbids. The two cases
are distinguished by the response, not guessed at — `404` is gone, everything else is
transient — and the stale row is removed on close rather than left to invite a second click.

## Do's and Don'ts

- **Do** keep every figure tabular and every name bold.
- **Do** fix column widths so a live update never reflows a table.
- **Do** keep cyan off every figure.
- **Don't** print a wallet address on any surface, truncated included. Both references do;
  `SECURITY.md` and spec §8 forbid it and a test asserts it over rendered HTML.
- **Don't** hotlink an avatar. Every photo comes from `/api/avatar/<kol_id>`.
- **Don't** use green or red for anything that is not profit or loss. The podium tints are
  `podium-N`, which is why they exist as their own tokens.
- **Don't** show a control that does not work. A window we cannot aggregate is not a
  disabled tab with a tooltip; it is absent.

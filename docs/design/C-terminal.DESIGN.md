---
version: alpha
name: kolscanhispano-C-terminal
description: "A pure-black terminal for a Solana trade tracker: #000000 canvas, 28px rows, 2px radii, and monospace as the default voice rather than the exception. Space Grotesk sets display; IBM Plex Mono sets body and every figure. The single accent is magenta (#f0437e), used on the mark and on focus and never on data — the deliberate inversion of the source, which paints its statistics in brand colour. Here a number is coloured only by what it means. Motion is an 80ms flash on arrival and nothing else."
colors:
  primary: "#f0437e"
  on-primary: "#1a0208"
  primary-hover: "#ff6b9b"
  ink: "#e8e8ea"
  ink-muted: "#9a9aa0"
  ink-subtle: "#5f5f66"
  canvas: "#000000"
  surface-1: "#0b0b0c"
  surface-2: "#121214"
  hairline: "#1c1c1f"
  hairline-strong: "#2a2a2e"
  semantic-gain: "#26c281"
  semantic-loss: "#ff4d4d"
  semantic-neutral: "#5f5f66"
  semantic-stale: "#9a7b32"
typography:
  display-lg: { fontFamily: "Space Grotesk", fontSize: 32px, fontWeight: 600, lineHeight: 1.1, letterSpacing: -0.8px }
  headline:   { fontFamily: "Space Grotesk", fontSize: 20px, fontWeight: 600, lineHeight: 1.2 }
  body:       { fontFamily: "IBM Plex Mono", fontSize: 12.5px, fontWeight: 400, lineHeight: 1.45 }
  label:      { fontFamily: "IBM Plex Mono", fontSize: 10.5px, fontWeight: 500, letterSpacing: 0.06em, textTransform: uppercase }
  numeric:    { fontFamily: "IBM Plex Mono", fontSize: 12.5px, fontWeight: 500, fontVariantNumeric: "tabular-nums" }
  numeric-lg: { fontFamily: "IBM Plex Mono", fontSize: 16px, fontWeight: 600, fontVariantNumeric: "tabular-nums" }
rounded: { sm: 0px, md: 2px, lg: 4px, pill: 999px }
spacing: { row-height: 28px, gutter: 12px, panel-padding: 10px }
motion:  { data-in: "80ms linear", hover: "0ms", reduced: "none" }
---

## Overview

Base direction: ClickHouse's design analysis. What was taken is its posture — near-pure black,
data fragments sitting directly on the canvas without decorative framing, and an accent used as
voltage rather than as paint. What was deliberately not taken is its signature move: ClickHouse
colours its statistics in brand yellow. **This direction inverts that.** A figure here is coloured
only by meaning — gain, loss, unknown — and the accent is forbidden on data. The electric yellow,
the sans body face, and the marketing card rhythm are all gone; monospace as the default voice and
a 28px row are what make this ours.

## Colors

`canvas #000000`. Panels barely lift to `surface-1 #0b0b0c`; most surfaces are the canvas itself
with a hairline. This is the densest of the three directions and the least decorated.

**Magenta `#f0437e` is the only chromatic accent and is forbidden on any figure.** Wordmark, focus
ring, live indicator, one primary action per view.

**Green and red are reserved for direction of money.** `semantic-gain #26c281`,
`semantic-loss #ff4d4d`. `semantic-stale` for a price we no longer trust.

Pure black plus a saturated accent is a contrast risk: the accent is never used for body text, and
the floor is 4.5:1 for prose and 7:1 for figures.

## Typography

Space Grotesk carries display and headline only. **IBM Plex Mono carries everything else** — body,
labels, and every figure — with tabular figures on by default. This is the direction where
monospace is the voice rather than the exception, which suits a page that is 80 % numbers.

Spanish `es-ES` numerals: `+18,42 SOL`, `1.802,4`, `68,4 %`. Monospace does not excuse English
separators.

## Layout

Full-bleed to 1440px with 12px gutters. 28px rows put roughly twenty leaderboard entries and
fifteen feed rows on one screen. Column widths are fixed in `ch` units so a mono table never
reflows. On narrow viewports the leaderboard drops the secondary currency before it drops the win
rate, and never wraps a figure.

## Shapes & Depth

2px radii, 0px on table cells. No shadows, no glows, no gradients. A hairline is the only divider.

## Components

**`row-leaderboard`** — 28px, hairline bottom. Rank in `numeric` `ink-subtle`; avatar 18px square
with a 2px radius; name in `body`; cabal tag in `label` on `surface-2`; `wins/losses` and win rate
in `numeric` `ink-muted`; PnL in `numeric-lg` by sign; secondary unit in `numeric` `ink-subtle`.
Ranks 1–3 carry a magenta left rule, 2px. No medals.

**`row-feed`** — 28px. `avatar name verbo monto símbolo @ precio` then relative time right-aligned,
all in mono, reading as a log line. Sign colour on verb and amount. A new row flashes
`surface-2` for `motion.data-in` and settles — the only animation in the system.

**`segmented-window`** — `Diario · Semanal · Mensual` and `SOL · USD` as square segments, selected
in `surface-2` with magenta text, `día UTC` beneath in `label`.

**`chip-hidden-wallets`** — `Wallets ocultas` in `label` `ink-subtle`.

**`state-unpriced`** — `sin precio` in `label` `semantic-stale`. Never a dash, never −100 %.

## Do's and Don'ts

- **Do** treat the feed as a log: one line, one event, no cards.
- **Do** fix column widths in `ch` so mono tables never move.
- **Do** keep magenta off every number — that inversion is the point of this direction.
- **Don't** colour a statistic with the brand, which is exactly what the source does.
- **Don't** add a second animation.
- **Don't** let pure black plus saturated magenta fall below the contrast floors.

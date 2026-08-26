---
version: alpha
name: kolscanhispano-A-editorial
description: "A near-black editorial canvas for a Solana trade tracker, built on #0a0a0b with a single warm amber accent (#e0913a) and an Instrument Serif display voice that deliberately refuses the neon-crypto genre. Numbers are the argument: every figure sits in IBM Plex Mono with tabular figures, and colour on a number means gain or loss and nothing else. Rows breathe at 44px, panels carry 8px radii and hairline borders, and motion is a slow 240ms fade reserved for data arriving. The system reads as a financial broadsheet that happens to update every four seconds."
colors:
  primary: "#e0913a"
  on-primary: "#12100c"
  primary-hover: "#eaa55c"
  ink: "#f4f3f1"
  ink-muted: "#b9b6b0"
  ink-subtle: "#7d7a74"
  canvas: "#0a0a0b"
  surface-1: "#121214"
  surface-2: "#17171a"
  hairline: "#232326"
  hairline-strong: "#33333a"
  semantic-gain: "#3fb950"
  semantic-loss: "#f0563f"
  semantic-neutral: "#7d7a74"
  semantic-stale: "#8a7a4a"
typography:
  display-lg: { fontFamily: "Instrument Serif", fontSize: 44px, fontWeight: 400, lineHeight: 1.1, letterSpacing: -0.5px }
  headline:   { fontFamily: "Instrument Serif", fontSize: 26px, fontWeight: 400, lineHeight: 1.2 }
  body:       { fontFamily: Inter, fontSize: 14px, fontWeight: 400, lineHeight: 1.5 }
  label:      { fontFamily: Inter, fontSize: 12px, fontWeight: 500, letterSpacing: 0.02em, textTransform: uppercase }
  numeric:    { fontFamily: "IBM Plex Mono", fontSize: 14px, fontWeight: 500, fontVariantNumeric: "tabular-nums" }
  numeric-lg: { fontFamily: "IBM Plex Mono", fontSize: 20px, fontWeight: 500, fontVariantNumeric: "tabular-nums" }
rounded: { sm: 4px, md: 8px, lg: 12px, pill: 999px }
spacing: { row-height: 44px, gutter: 24px, panel-padding: 20px }
motion:  { data-in: "240ms cubic-bezier(0.16,1,0.3,1)", hover: "160ms ease-out", reduced: "none" }
---

## Overview

Base direction: Vercel's published report-website guidance. What was taken is its *discipline* —
evidence before decoration, an explicit priority order, a refusal of hero imagery and icon
jewellery, and the idea that a data page is an argument rather than a dump. What was deliberately
not taken is everything that makes it Vercel: Geist, the light-first canvas, and its stated goal
of communicating Vercel authorship. Instrument Serif in the display role is the single decision
that moves this furthest from both its source and from the crypto-dashboard genre.

## Colors

`canvas #0a0a0b` under everything; panels lift to `surface-1 #121214`, hover to `surface-2`.
Hairlines at `#232326` do the separating — never shadows.

**Amber `#e0913a` is the only chromatic accent** and it never touches a number. It marks the
wordmark, focus rings, the active timeframe, and at most one call to action per view.

**Green and red are reserved.** `semantic-gain #3fb950` and `semantic-loss #f0563f` mean profit
and loss and are used for nothing else — not for status, not for validation, not for a chart line
that happens to need a second colour. `semantic-stale #8a7a4a` marks a price we no longer trust;
`semantic-neutral` marks a figure with no direction.

Contrast floor: body text 4.5:1 on its own surface, numeric 7:1 — a figure is read at a glance or
it has failed.

## Typography

Instrument Serif carries display and headline. Inter carries body, labels and navigation. **IBM
Plex Mono with `font-variant-numeric: tabular-nums` carries every number**: PnL, percentages,
amounts, token quantities, prices, timestamps. Columns of figures must align on the decimal down
the whole page; a proportional digit anywhere in a table is a defect.

Spanish `es-ES` formatting throughout: `1.802,4` and `+18,42 SOL`, never the English separators.

## Layout

12-column grid, 1200px maximum, 24px gutters. Rows are 44px — comfortable, not cramped; this
direction accepts fewer rows above the fold in exchange for legibility. The leaderboard is a
single full-width table. The feed is a single column at 720px with the timestamp right-aligned.

## Shapes & Depth

8px radii on panels, 4px on chips and inputs, pill only on toggles. Depth comes from surface
steps and hairlines. No drop shadows, no glows, no gradient borders.

## Components

**`row-leaderboard`** — 44px, `surface-1`, hairline bottom. Rank in `numeric` `ink-subtle`; avatar
28px circle; name in `body` at 500; cabal tag as a 2px-radius chip in `surface-2`; win/loss and
win rate in `numeric` `ink-muted`; PnL in `numeric-lg` coloured by sign; the secondary unit in
`numeric` `ink-subtle` beneath it. Rank 1–3 get an amber hairline on the left edge, not a medal.

**`row-feed`** — 44px, transparent, hairline bottom. Avatar, name, verb (`compró`/`vendió`),
amount in `numeric`, token symbol in `body` 500, price in `numeric` `ink-muted`, relative time
right-aligned in `numeric` `ink-subtle`. The verb and the amount carry the sign colour; the rest
stays neutral. New rows fade in over `motion.data-in`; nothing slides, nothing bounces.

**`chip-hidden-wallets`** — the literal string `Wallets ocultas` in `label` `ink-subtle` on
`surface-2`. It appears wherever an address would have been.

**`state-unpriced`** — the string `sin precio` in `label` `semantic-stale`. Never a dash, never a
zero, never a red −100%.

## Do's and Don'ts

- **Do** let a number's colour mean exactly one thing: the direction of money.
- **Do** keep the accent off every figure, including totals.
- **Do** show `sin precio` when a price is unknown, and say so in words.
- **Don't** add a second accent, a gradient, a glow, or a chart that needs a legend of five colours.
- **Don't** animate anything a user did not cause, except a row arriving.
- **Don't** reach for an icon where a Spanish word fits.

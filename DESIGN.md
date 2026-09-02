---
version: beta
name: kolscanhispano
description: "kolscanbrasil.io in Spanish: the same dark leaderboard-first tracker, cloned surface by surface, with three exceptions of our own. Near-black #0f1113 ground, ranked cards with gaps, a podium marked by 🏆🥈🥉 over a tinted bar and a fading wash. Names in bold, hidden wallets in grey italic, cabal tags as solid coloured chips, circular avatars served from our own origin. One SOL figure per card, signed and coloured, with the fiat total in parentheses at the end. Inter sets text, JetBrains Mono sets every figure with tabular numerals. The mould is theirs; the identity, the accent and every asset are ours."
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
spacing: { row-height: 68px, gutter: 16px, panel-padding: 16px }
motion:  { data-in: "140ms ease-out", hover: "90ms linear", reduced: "none" }
---

## Overview

**This document describes a clone of kolscanbrasil.io, translated into neutral Spanish,
with three exceptions.** Owner's decision, 2026-09-02: *"quiero literalmente la misma web
pero en español."* Every surface, layout, hierarchy, colour, density, component, label and
behaviour is theirs unless one of the three exceptions below says otherwise. Where taste
once said something different here, the mould won and this document was rewritten rather
than argued with — the reconnaissance and the surface-by-surface map are
`docs/clone-map.md`, and the audit that preceded it is `docs/parity-kolscanbrasil.md`.

**The three exceptions, and only three:**

- **(a) No address that is not public, and no hotlinked face.** Every avatar is served from
  `/api/avatar/<kol_id>`; no wallet address reaches any surface, truncated included, where
  theirs prints one. `SECURITY.md` and spec §8; `address-invariant.test.ts` asserts it over
  rendered HTML.
- **(b) Nothing that signs a transaction or moves funds.** `no-money-path.test.ts` fails if
  a transaction-constructing or -sending API becomes importable from application code.
- **(c) No asset and no code of theirs, copied byte for byte.** Logo, icons, illustrations
  and CSS are rebuilt by hand to look the same; typefaces are matched with the nearest free
  one. Unicode glyphs — 🏆🥈🥉, `𝕏` — are nobody's asset and are used as they are.

Two things the reconnaissance found that are **not** cloned, and why: their window toggle
ships in English on one page and Portuguese on another, and two of the four blocks in their
KOL modal render empty. A defect on the mould is not a design; we take the layout and the
labels, and the behaviour stays ours. `docs/clone-map.md` §0 has the measurements.

Where a rule below is ours rather than theirs it says so. Everything else is a description
of their site.

This direction superseded "Instrumento" (a 36px hairline instrument panel) on 2026-08-27,
which is why the row height, the ground and the modal are what they are.

## Identity

The wordmark is the domain in Inter 700, with **`.fun` in the accent** — the dot alone is
invisible at 20px, measured rather than assumed. Subtitle:
**"Clasificación de traders hispanos"**. No logo, no mascot, no illustration.

**The accent stays cyan `#22d3ee`** and neither reference uses it. It marks the wordmark,
focus rings, the selected tab, and the live indicator. **It never touches a figure.**

## Colors

`canvas #0f1113` under everything — near the ground the genre uses, deliberately not
identical to it. Panels at `surface-1`, hover `surface-2`, selected `surface-3`. Hairlines
separate; there are no shadows except the modal's scrim.

**Green and red are direction of money and nothing else.** `semantic-gain #3ecf7f`,
`semantic-loss #f2555a`. No status pill, no chart series, no validation message may use them.

**The podium is three medals over three tints.** 🏆 🥈 🥉 in the rank box — the mould's own
glyphs, and Unicode is nobody's asset (exception c) — over `podium-N`: a solid 3px bar down
the card's left edge and a `podium-N-wash` gradient fading out across it. Rank 1 green, 2
amber, 3 blue.

**This paragraph read *"three tints, not three metals"* until 2026-09-02**, and it was
enforced: the glyph was a `★` in `podium-N` precisely so the podium would not spend a colour
outside the palette. The owner's clone decision replaced it. The consequence is stated
rather than hidden — the three emoji are the only colours in this system that answer to
nothing, and they are confined to a box that carries no figure. The tints did not leave with
the glyph; they are what the bar and the wash are painted in, which is where the rank now
reads from.

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
| `cabal-a #a78bfa` | 6.95 | PASS |
| `cabal-b #f472b6` | 7.14 | PASS |
| `cabal-c #fdba74` | 11.22 | PASS |
| `cabal-d #94a3b8` | 7.38 | PASS |

The four cabal tints are measured against `canvas #0f1113`, the ink the solid chip prints
in; every other row is against `surface-1`. **The chip went solid on 2026-09-02** and the
tints stopped being foregrounds: the pair a reader actually looks at is now dark ink *on*
the tint, so that is the pair the table measures. Contrast is symmetric, so the rows below
are unchanged in kind and only in value. `ink` on each podium wash: 14.18, 14.28, 14.78 —
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

**The ranked list is called `Clasificación`, everywhere a reader can see.** Nav label,
page title, `<title>`, meta description, the wordmark subtitle, body copy and every CTA
that points at it. It had three names at once — the nav said `Clasificación`, the body
said *"el ranking"*, and the onboarding CTA said *"leaderboard"* — which reads as three
screens rather than one. `ranking` and `leaderboard` survive only where a reader never
meets them: identifiers, CSS class names, and the `/leaderboard` route, which stays
because changing a published URL costs more than the inconsistency it removes.
`copy.test.ts` scans for it.

**One documented exception: the avatar monogram is set in `system-ui`.** The fallback avatar
is an SVG served from `/api/avatar/<kol_id>` and consumed inside an `<img>`, which is an
isolated document that cannot reach `next/font`'s `@font-face`. A platform boundary, not an
oversight; it applies only to that glyph, and never to a figure.

## Layout

**992px, and 1280 is the ceiling rather than the target** — the mould centres its ranking in
about 992px, and at 1280 a row of four figures is mostly the space between them
(`docs/parecido-2026-09-02.md` §2). 16px gutters.

**Rows are 68px** — enough for a 40px circular avatar and one line of identity beside it. They
were 56px with a two-line identity block; the line merged on 2026-09-02 and the height went up
rather than down, because the mould's rows are ~84px and the density it buys is the point. The
exception is `list-defi-trades` inside the modal, which stays 36px: a one-line trade row needs
neither the avatar nor the room.

**The ranking is a list of cards, not a table**, with a gap between them and `radius-md`
corners, the way theirs is. The figure columns are fixed **grid tracks**, so a figure
crossing `9,99 → 10,01` reflows nothing — the rule that used to say "fixed column widths"
kept its job when the table went. The only fixed-layout table left in this product is
`/admin`'s roster, which no reader sees.

Header: wordmark and subtitle left, nav centre, the wallet action right. **The window and
currency controls are on the page**, in one row with its title — `docs/clone-map.md` §2: the
mould puts them to the right of `KOL Leaderboard`, not in the chrome. They were in the header
until 2026-09-02, and the cost of moving them is stated rather than hidden: off `/leaderboard`
and `/cabals` there is no window toggle in reach, and the home page's top ten is explicitly
the daily window with the USD total, with `Ver todo` beside it.

## Responsive

**This section exists because it was quoted before it was written.** Three fixes on
2026-08-31 rested on "nothing may push the page sideways" — a line that lived in
`e2e/viewport.spec.ts`'s own commentary, a previous author's gloss on Layout's *"1280px
maximum, 16px gutters"*, read back as if this document said it. It did not. A rule enforced
by a test and absent from the norm is one nobody can argue with and nobody agreed to.

**Two sizes are designed and guarded: 1280×900 and 390×844** — the layout maximum against a
laptop, and a phone. There is no breakpoint system and no intermediate design; between them
the layout is fluid, and those two are what the e2e suite asserts.

**The page never scrolls horizontally, at either size.** `document.scrollWidth` may not
exceed `window.innerWidth`. Wide content — `/admin`'s table, a trade list —
scrolls **inside its own container**, never by moving the body.

That is the rule the ranking table broke: under `table-layout: fixed` a column with no
stated width collapsed to zero and the table measured 581px inside a 390px viewport, before
anything was clicked. So **every column in a fixed-layout table states its width** — the
same requirement the Do's already make for a different reason (*"fix column widths so a live
update never reflows a table"*), and the two now share one cause.

**Scrolling inside the container was not enough for the ranking, and it stopped being a
table on 2026-09-02.** Stating every width kept the *document* still and moved the defect
one level down: at 390 the six columns came to 768px inside a 358px card, so the PnL — the
figure the page is sorted by and the reason a reader opens it — sat off the right edge
behind a scroll nothing announced. Hiding columns under a media query cannot fix it (under
`table-layout: fixed` a hidden cell keeps its `<col>`'s width; tried and reverted the same
day, `docs/parity-kolscanbrasil.md` §3) and it would remove data on the size most readers
are on.

**The feed row wraps below 640px too**, and it was the last surface still clipping. Its
sentence had about 150px of a row whose other three parts are fixed, so the ellipsis was
printing `compró 1…` — a name, a verb and three characters of an amount. A feed row is a
sentence, not a column of figures: it takes two lines and says the whole thing.

So **the ranking card wraps below 640px**: the rank and the identity keep the left, and the
two figures stack on the right in the order they hold at 1280 — everything visible without
scrolling anything. 640px is not a designed size — the two designed sizes are still 1280×900
and 390×844 — it is where the four fixed tracks plus the identity block stop fitting, which
is the only honest place to change shape. `e2e/viewport.spec.ts` asserts the PnL is inside the viewport at 390,
which is the assertion nobody had written when this shipped.

**Clipping is not a compact layout, it is a bug.** A cell whose text is in the DOM but
painted outside its box still reads `31/08 02:12 UTC` from `textContent` while the glyphs
are gone. Any guard for it asserts the cell is **reachable** — inside the visible box once
its own container is scrolled — never merely that the text exists.

## Components

**`row-leaderboard`** — a card: 68px minimum, `radius-md`, a hairline border, `surface-2` on
hover, whole card clickable and focusable (it opens the modal). Left to right: the rank —
🏆 🥈 🥉 on the podium, a **plain** `numeric` numeral in `ink-subtle` below it; 40px circular
avatar from `/api/avatar/<kol_id>`; **one line of identity** — `name`, then the
**`@handle`, always**, linked to X, then `Wallets ocultas` in `hidden` where that KOL's
wallets are hidden, then the cabal chip; then right-aligned, the SOL figure in `numeric-lg`
coloured by sign, and the fiat total in `numeric` `ink-muted` in parentheses.

It was a two-line block — name over handle — until 2026-09-02; the mould reads them across
(`docs/clone-map.md` §3). Only the name yields: a handle cut to `@cripto…` and a chip cut to
`EJ` are unreadable, a shortened name is still a name. **The name is not the link.** The row
opens the modal and `KolRow` excludes anything inside an `<a>`, so linking the name would
take the row's largest target away from what the row is for.

**No record column and no header row**, because the mould has neither. `Cerradas` and
`% ganadas` were on this card until 2026-09-02 and came off with the clone decision; the
fields survive in `/api/leaderboard` and in the empty-state rule, which is keyed on whether
anything closed in the window.

The handle and the hidden marker are **not alternatives**, and an earlier draft of this
document wrongly wrote them as one. On both references a row carries a handle *and* an
identity chip that is either a truncated address or `Wallets Ocultas`: the handle is public
identity, the wallet is the secret. `hide_wallets` defaults to `TRUE` here, so treating it
as a handle switch would erase the person from almost every row. `Wallets ocultas` occupies
the **address** slot and nothing else.

Ranks 1–3 additionally carry their `podium-N-wash` as a **gradient fading out across the
card**, with a solid 3px bar of `podium-N` down its left edge. A flat wash reads as "this row
is a slightly different colour"; the bar and the fade read as a podium.

**`chip-cabal`** — the group's 3–4 letter tag, `label`, `radius-sm`, **solid**: the ground is
one of four tints assigned per cabal — `cabal-a` violet, `cabal-b` pink, `cabal-c` peach,
`cabal-d` slate — and the text is `canvas` on it. It was tinted text on `surface-2` until
2026-09-02; theirs is solid. Four fixed tokens rather than a generated hue, because a generated
one can land on green or red — reserved here for money — or on a podium tint. A fifth cabal
reuses the first: repetition is honest, a colour outside the palette is not.

**`chip-hidden`** — not a chip: `Wallets ocultas` in `hidden`, inline, no border. It occupies
the slot where the reference prints a truncated address, which is what makes it read as
native rather than as something withheld.

**`segmented`** — `Diario · Semanal · Mensual` and `USD · ARS` as pill segments; selected
segment `surface-3` with cyan text. All three windows are real aggregations; none is a
disabled stub.

The currency toggle chooses **what the parenthesised total is printed in**, not what the
ranking is sorted by: the ranked figure is always SOL, the way the mould's is always the
chain's. It read `SOL · USD` until 2026-09-02.

**The peso is a conversion, and the page says so.** It is the row's USD total at one public
rate, and the qualifier line names the rate, which dollar it is and when it was quoted —
`1 US$ = 1.545 ARS · dólar blue · 02/09 11:55 UTC`. With no current rate the figures read
`sin precio` and the line says there is none; a stale rate is never used quietly.
`docs/round-ars.md` is the round behind all of it, and **which dollar is the owner's open
decision**, carried by one environment variable.

**`modal-kol`** — opened from a row, dismissible by `Esc`, backdrop click and a close button;
focus trapped; the trigger row regains focus on close. Header: 64px avatar, `name`, cabal
chip, the `@handle` (always, with `Wallets ocultas` beside it where wallets are hidden —
same rule as the row), and the period's total PnL in `numeric-lg` by sign.
**Where the reference prints a truncated address, we print nothing.**

Then **`card-calendario-pnl`**, full width: a calendar heatmap, one cell per UTC day of the
window, green or red by that day's realized figure and shaded in three steps against the
window's own biggest day. A day with no closed position is an **empty cell**, never a zero.
`Diario · Semanal · Mensual` segments sit in its head. It was a line chart until 2026-09-02;
the mould's first block is a calendar, so ours is.

**Not `1D / 7D / 30D`**, which the mould uses and which would be false here: spec §4.9 makes
every window calendar-aligned UTC and never rolling, so `Semanal` is the current ISO week —
one day long on a Monday — and is not `7D`. That is the one thing on this page the clone
decision did **not** settle, because it is not a rendering change: it changes what every
figure in the product means, and it has its own round (`docs/clone-map.md` §8). The grid
therefore spans the window, which makes `Diario` a single cell — the honest render of a
measurement whose finest grain is a day.

**Below it, two columns**: the figures on the left, the trade list on the right, one column
below 640px. Left, in order: **`card-stats`** — PnL total, trades, volume; **`card-chain-pnl`** — one
line, SOL, because that is every chain we index; **`card-wallets`** — how many of this
KOL's wallets are published and how many are not, **as counts with a padlock and never as
a list of addresses** (`DECISIONES.md`, 2026-08-31, which moved the visibility decision
from the KOL to the wallet and is what this card exists to state; a KOL with no wallets
renders no card, because absence is rendered as absence). Right: **`list-defi-trades`** — the KOL's trades,
each with verb, SOL amount by sign and its USD equivalent, and where the wallet is hidden
the row reads `PRIVADO` with a padlock instead of a signature link.

**`podium-cabals`** — `/cabals`'s podium: three cards, **#2 left, #1 centre and taller, #3
right**, each with its medal, a 64px monogram, the name, the `(TAG)` in `ink-subtle`, the SOL
total in `numeric-lg` by sign, the USD total beneath it and the member count last. The tint
arrives as on a ranked card — a wash fading down, a solid bar of `podium-N` — and **not as the
mould's coloured halo**, because Colors says there are no shadows here except the modal's
scrim. Below 640px the three stack and read 1, 2, 3: the arrangement is a shape, and a shape
with nothing to arrange is a wrong order.

**`row-cabal`** — the `row-leaderboard` card with a member count where a KOL card has none:
rank, monogram, name over `(TAG)`, `N miembros`, then the SOL total and the USD total.

**`/trade`** — the affiliate landing (`docs/clone-map.md` §7), and the one page here with no
figure on it: a `Socio · …` pill, a two-line `display-lg` whose second line is the **accent**
(their green is a colour this system reserves for money), `▣ … ▣` dividers in the accent with
a hairline running to each side, and four numbered cards over a ghosted `numeric` numeral,
the last bordered in the accent. **The call to action is a real `rel="sponsored"` link once
spec §1.9's affiliate row exists, and a plain unfocusable label while it does not** — never a
disabled button, which is the one shape the last Don't forbids.

**`state-unpriced`** — `sin precio` in `semantic-stale`, never a dash, never a red −100 %.

## Every surface has two states

A surface is not designed until both are. **An empty state says what will be here and does
not apologise** — no "Ups", no shrug illustration, no spinner pretending to be progress, and
above all **no zeroed rows**: kolscan.io was captured twice showing fifty rows of `+0.00 Sol`
from a stalled indexer, which reads as fifty traders who all broke exactly even.

| Surface | Populated | Empty |
|---|---|---|
| `leaderboard` | ranked rows, PnL by sign | `Todavía no hay operaciones cerradas.` / `Aquí va la clasificación por PnL realizado del período, en cuanto los KOL del padrón cierren su primera posición.` |
| `cabals` | a podium of three over a list | `Todavía no hay cabals con posiciones cerradas.` / `Aquí van los grupos del padrón, ordenados por PnL realizado del período, en cuanto sus miembros cierren su primera posición.` |
| `feed` | rows arriving at the top | `El feed está esperando la primera operación.` / `Cada compra y cada venta de los KOL del padrón aparece aquí, en cuanto la cadena la confirma.` |
| `modal-kol` calendar | a cell per day of the window | `Sin operaciones cerradas en este período.` |
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
- **Do** fix the width of every column of figures — a grid track or a `<col>` — so a live
  update never reflows the list under the reader.
- **Do** keep cyan off every figure.
- **Don't** print a wallet address on any surface, truncated included. Both references do;
  `SECURITY.md` and spec §8 forbid it and a test asserts it over rendered HTML.
- **Don't** hotlink an avatar. Every photo comes from `/api/avatar/<kol_id>`.
- **Don't** use green or red for anything that is not profit or loss. The podium tints are
  `podium-N`, which is why they exist as their own tokens.
- **Don't** show a control that does not work. A window we cannot aggregate is not a
  disabled tab with a tooltip; it is absent.
- **Don't** copy a byte of theirs. The mould is the layout, the hierarchy and the labels;
  every asset, every rule of CSS and every line of code here is written from the capture,
  never lifted from the page (exception c).

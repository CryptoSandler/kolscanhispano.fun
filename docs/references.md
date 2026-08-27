# Reference teardown: kolscan.io and kolscanbrasil.io

Captured 2026-08-25 with Firecrawl (rendered DOM + full-page screenshots). Screenshots live in the
session scratchpad, not in this repo. Everything below is observed behaviour or arithmetic inferred
from observed numbers; neither site publishes a methodology page.

**Capture caveat — kolscan.io was degraded at capture time.** Its trade feed showed data 5–6 days
old, the leaderboard rendered every row as `+0.00 Sol ($0.0)` with `0 / 0` win/loss, and `/trades`
and `/tokens` rendered as empty shells (client-hydrated, no data arrived). The header SOL price did
tick live ($97.73 → $97.97 across captures), so the frontend is alive and the indexer is not. Layout
and copy below are reliable; the *values* on the leaderboard are not.

---

## 1. kolscan.io

### Information architecture

| Route | What it is |
|---|---|
| `/` | Hero + live trade feed + value props + FAQ |
| `/trades` | "Realtime Trades" — full-page feed with a "Filter Wallets" control |
| `/tokens` | "Realtime Token Tracker" with market-cap filter tabs: `Low Caps`, `$100k+`, `$1m+` |
| `/leaderboard` | "KOL Leaderboard", 50 ranked wallets, Daily/Weekly/Monthly |
| `/account/<wallet>` | Per-wallet page: stats, holdings, trade log, per-token PnL |
| `/privacy`, `/terms` | Legal |

There is **no per-token page.** `/tokens` is a market-cap-filtered discovery list, not a
`token/<mint>` detail view. Nothing on the site shows "which KOLs touched this mint". Sitemap
crawling surfaced only `/account/*` detail pages.

Persistent chrome: wordmark, live SOL price pill, nav, a Pump.fun affiliate button
(`join.pump.fun/HSag/kolscan`), wallet search, Connect Wallet, and a settings popover with
**Theme**, **Sounds** (audio ping per incoming trade), and **Custom Settings** (a link field noted
"Supports comma seperated lists" — [sic], their typo).

Visual identity: near-black background (#0b0b0c-ish), white text, blue accent (#2f6fed-ish) for
links and the highlighted hero word, red/green for sell/buy amounts, orange/amber for USD prices.

### Home feed — what a trade row carries

One sentence per trade, avatar-led:

> `[avatar] MoneyMike sold 1.23 sol (16.9m) of SP3ND at $0.0000071        5d ago`

Fields per row: KOL avatar (CDN-hosted, keyed by wallet: `cdn.kolscan.io/profiles/<wallet>.png`),
display name linking to `/account/<wallet>`, side (`bought`/`sold`), SOL amount, token amount in
parentheses, token symbol, unit price in USD, relative age, and the whole timestamp links out to
`solscan.io/tx/<signature>` with the absolute UTC time as the link title. Buy amounts render green,
sell amounts red. Ten rows on the home page.

### Leaderboard

Header `KOL Leaderboard`, tabs `Daily | Weekly | Monthly`. Top 3 get a trophy graphic; ranks 4–50
are numbered. Each row: rank, avatar, display name (links to `/account/<w>?timeframe=1`), X icon,
optional Telegram icon, wallet prefix (first 6 chars, e.g. `HFx9E1`), a `wins / losses` pair, then
PnL as **`+0.00 Sol`** with **`($0.0)`** underneath. SOL is the primary unit, USD is secondary — the
inverse of the Brazilian site. Footer promotes a "Pump Leaderboard" and an app download QR.

### Account page — the densest page on the site

Header: avatar, display name, X link, wallet prefix, a **PnL Calendar** widget, and timeframe tabs
`1d | 3d | 7d | 14d | 30d`. A `Stats / Holdings` toggle switches the panel below.

Stats panel (observed on `CyaE1V…`, the "Cented" wallet):

| Field | Example |
|---|---|
| Solana balance | `837.22 SOL` |
| USDC balance | `0.00` |
| Win Rate | `27.3%` |
| Avg Duration | `3d` |
| Top Win | `+5.2 Sol` |
| Volume | `$29.1k` |
| Realized Profits | `$775.8` |
| Unrealized Profits | `-$1,565.3` |

**Realized and unrealized are reported separately and only in USD here.** Note the win rate (27.3%)
does not match the per-token tally shown lower on the same page (`3 / 8` = 37.5%), so the two are
computed over different windows or different universes.

`Defi Trades`: a searchable reverse-chronological log. Each entry is `Buy`/`Sell`, the input
amount+asset, the output amount+asset, and a relative timestamp linking to Solscan. Both legs are
shown as raw amounts — no USD on this list.

`Token PnL`: sortable `Most Recent | Profit | Loss`, headed by a `3 / 8` win/loss ratio and an
aggregate `-8.06 Sol (-$789.5)`. One card per mint:

| Field | Example (TRUMPSPEED) |
|---|---|
| Token icon + symbol | metadata from Irys / Axiom / pumper.ink CDNs |
| Age | `5d ago` |
| PnL | `-4.06 Sol (-$397.5)` |
| Bought | `9.62 Sol (93.6m)` |
| Sold | `3.53 Sol (18.3m)` |
| Holding | `2.037 Sol (75.3m)` |
| ROI | `-42.2%` |
| Duration | `2s` |

### How kolscan.io computes PnL (inferred)

Per mint, in SOL, over the selected timeframe:

```
pnl = sol_out_from_sells + current_value_of_remaining_position - sol_in_from_buys
roi = pnl / sol_in_from_buys
```

Verified against the captured cards:

- **TRUMPSPEED**: `3.53 + 2.037 - 9.62 = -4.05` vs `-4.06` displayed; `-4.06 / 9.62 = -42.2%` ✅
- **BUDDY** (fully closed): `7.81 - 7.10 = +0.71`… displayed `+1.01`, so the closed case does not
  reconcile exactly — the trade log shows buys that predate the window, so **the per-token card
  mixes a lifetime cost basis with a windowed trade list.** Treat the exact basis as unknown.
- **HYPE**: `22.32 - 17.32 = +5.00` vs `+5.19` displayed. Same drift, same cause.

So: token-level PnL is **not** purely realized — it folds in mark-to-market on the open remainder.
The *account* stats panel is where realized and unrealized are split.

Four behaviours worth stealing or avoiding:

1. **Unpriceable holdings are valued at zero.** `PUMPIT`: bought 3.01 SOL, sold 0, still holding
   42.56m tokens, ROI shown as `-100.0%`. `Holding` renders as a bare token count (`42.56m`) when
   there is no price, and as `X Sol (N tokens)` when there is. A rug and an unindexed pool look
   identical to the reader.
2. **Unknown metadata degrades to the mint.** Tokens whose metadata never resolved appear as
   `Spl Token` in the trade log and as `3tNV5H…` on the PnL card, with a placeholder image.
3. **Duration is per-mint holding time**, from first buy to last sell — `2s` and `5d` both appear.
   Open positions show the age of the position.
4. **Stablecoin legs are counted as trades.** A `USDC → SOL` swap shows up in `Defi Trades` as a
   `Sell` of 167 USDC. Any PnL model has to decide whether stable/SOL rotation is a "trade".

### Copy (verbatim)

- Hero: **"Track the Top Memecoin Traders in Realtime"** ("Realtime" in blue)
- Search placeholder: "Enter wallet address"
- Value props, three tiles: "Monitor Trades from Top Wallets" / "Discover New and Trending Tokens" /
  "Analyze the Most Profitable Wallets"
- CTA: "Follow us on X"
- FAQ:
  - *What is Kolscan?* — "Kolscan is a Solana wallet tracker that monitors the activities of top
    memecoin traders and KOLs. It provides realtime transactions, token PnL, and a leaderboard
    ranking their performance."
  - *Is Kolscan free to use?* — "All Kolscan features are free to use."
  - *Can I track non-KOL wallets?* — "Yes, you can search any wallet address on Kolscan. However,
    its data is initially limited to the last 100 transactions unless you choose to load more."
  - *How do I get my wallet on the leaderboard?* — "We are looking for the top trenchers! If you
    have $100k+ PnL in recent months, DM us your wallet for verification on X @kolscan."
- Footer: "© 2026 Kolscan. All rights reserved. | Privacy | Terms of Use"

The last FAQ answer is the whole curation model: manual, DM-based, with a stated PnL bar.

---

## 2. kolscanbrasil.io

A far smaller product: **three pages, no trade feed, no per-KOL page, no per-token page.**

| Route | What it is |
|---|---|
| `/` | The KOL leaderboard — this *is* the home page |
| `/cabals` | Group leaderboard |
| `/trade` | "Terminal Parceiro — GMGN", an affiliate landing page |

Multichain from the start: **Solana, BSC, Base, Ethereum**. Attribution in metadata:
`author`/`creator` = `SimbasJungles`, `twitter:creator` = `@SimbasJungles`, theme colour `#111315`,
`og:locale` `pt_BR`, `robots: index, follow` — SEO is treated as a first-class channel, which
kolscan.io does not bother with.

### Leaderboard (home)

Header: 🇧🇷 flag + `KOLScan Brasil` (with "Brasil" in blue) + tagline "Ranking de Traders
Brasileiros". Nav: `Trade` (with a green live dot), `Cabals`, `Conectar Wallet`.

Two independent toggles: **`USD | BRL`** and **`Daily | Weekly | Monthly`**. 160 KOLs ranked.

Row anatomy — this is the important part:

```
[🏆] [avatar] Frosty [CR] [𝕏] Wallets Ocultas   +2.87 ETH  +1.99 BNB  +1.78 SOL   (R$44.564,1)
[🥈] [avatar] Yoda   [ELC] [𝕏] 0x3719 [EVM]     +2.10 ETH  +1.52 BNB              (R$32.271,2)
[ 4] [avatar] pedrolucio (humble arc 😌🙏) [HUA] [𝕏] 0x347f [EVM]  …               (R$15.611,4)
```

- Rank 1/2/3 get trophy/silver/bronze icons and a coloured row glow (green/gold/blue); the rest are
  numbered.
- The X handle links to `x.com/<handle>`; the avatar is hotlinked straight from
  `pbs.twimg.com/profile_images/…`. No self-hosted avatar CDN.
- A **cabal badge** (`CR`, `ELC`, `HUA`, `CPD`, `FRD`, `CUM`, `RLR`, `DMC`, `QBD`, `ELX`) sits next
  to the name, colour-coded per cabal.
- Wallets are either shown as a truncated chip with a chain tag (`0x3719` `EVM`, `6BwjER` `+4` `SOL`
  `EVM` — the `+N` means more wallets than fit) or hidden behind the italic label **"Wallets
  Ocultas"**. Roughly 80% of rows are Wallets Ocultas.
- **PnL is one column per chain** (ETH / BNB / SOL, each in native units, green positive, red
  negative), with an em-dash where the KOL had no activity on that chain, and the **fiat total in
  parentheses on the right** — `(R$44.564,1)`, pt-BR number format. Fiat is the sort key and the
  headline; native amounts are the detail. Exactly inverted from kolscan.io.
- There is no win/loss count, no win rate, no volume, no trade count. Despite the meta description
  promising "PnL, win rate e performance", **win rate is not rendered anywhere on the site.**
- The tail of the list (rank ~70 onward) is all `(R$0,0)` — inactive KOLs are kept in the ranking
  rather than filtered out.

### Cabals

`Ranking de Cabals` / "Grupos de traders competindo por lucro" / `← Voltar ao Leaderboard`. Same
`Daily|Weekly|Monthly` and `USD|BRL` toggles.

Top three are large cards (logo, name, ticker in parentheses, aggregate PnL, member count); the rest
fall into an "Outros Cabals" grid. Aggregate PnL only — `Cleiton Rasta (CR) +R$2.929.502, 9 membros`;
`Humble Arc (HUA) +R$1.010.370, 3 membros`; `ChapaDAO (CPD) R$-59.808, 5 membros`. Cabal logos come
from `unavatar.io/x/<handle>`, ImgBB, or local files. Ordering is by PnL, though the captured page
renders the podium visually as 🥈/🏆/🥉 (centre-stage layout) while the numeric order is CR > HUA >
ELC — a presentation bug worth not copying.

Sizes are small enough that a cabal is a hand-maintained tag, not an inferred cluster: 2 to 12
members, ten cabals total.

### `/trade`

"Terminal Parceiro — GMGN. GMGN é o terminal parceiro do KOLScan Brasil — rápido, multichain e sem
atrito. Conecte no GMGN. Opere em todas as chains, sem atrito." A referral page. The monetisation
model on both sites is affiliate flow to a trading terminal (Pump.fun on one, GMGN on the other),
with the product itself free.

### Copy register

Portuguese, informal but not slangy, keeps English product nouns untranslated: "KOL Leaderboard",
"Trade", "Cabals", "Wallets Ocultas", "membros". Titles are SEO-shaped and long: "KOLScan Brasil -
Ranking dos Melhores Traders Brasileiros de Crypto em Solana, BSC, Base e Ethereum".

---

## 3. Side by side

| | kolscan.io | kolscanbrasil.io |
|---|---|---|
| Chains | Solana only | SOL + BSC + Base + ETH |
| Home page | Live trade feed | The leaderboard |
| Live trade feed | Yes (`/`, `/trades`) | No |
| Per-KOL page | Yes, rich (stats, log, token PnL, calendar) | No |
| Per-token page | No | No |
| Cabals / groups | No | Yes |
| PnL unit | SOL primary, USD secondary | Fiat primary, native per chain secondary |
| Win rate | Yes (account page) | Never displayed |
| Realized vs unrealized | Split on account page; blended per token | Not distinguished |
| Timeframes | Daily/Weekly/Monthly + 1/3/7/14/30d per account | Daily/Weekly/Monthly |
| Currency toggle | No | USD / BRL |
| Wallet disclosure | Full wallet in URL, prefix shown | Mostly "Wallets Ocultas" |
| Avatars | Self-hosted CDN keyed by wallet | Hotlinked from twimg |
| Identity | Wallet-first (`/account/<wallet>`) | Person-first (X handle) |
| Monetisation | Pump.fun affiliate | GMGN affiliate |
| Curation | Manual, DM on X, "$100k+ PnL" bar | Manual, unstated |
| SEO | Minimal | Deliberate (OG, robots, long titles) |

## 4. What this implies for kolscanhispano.fun

- **The token page is genuinely new.** Neither reference has one. "Which KOLs bought this mint, and
  when" is the differentiating surface, not a port.
- **Person-first identity beats wallet-first** for a community site, and it is what the Brazilian
  site does: the X handle is the primary key a reader recognises. Multiple wallets per KOL is
  table stakes, and hiding the addresses is the norm, not an exception.
- **Publishing both realized and unrealized separately is a correctness advantage.** The reference
  sites blur them, which is where their numbers stop reconciling.
- **Both sites display an unpriceable bag as a -100% loss.** That is a defensible default only if
  the UI says so; a distinct "sin precio" state costs little and is more honest.
- **Cabals are a tagging feature, not an algorithm** — cheap to add later, and the badge slot in the
  leaderboard row is the only UI it needs.
- **Inactive KOLs stay in the ranking at zero** on the Brazilian site. With a curated list that is
  fine and even desirable; it shows the roster.
- **The affiliate link is the only revenue surface on either site**, and both put it in the nav.

---

## 5. Genre extraction for the aesthetic pass

Re-captured **2026-08-27** with Firecrawl: `https://kolscan.io/leaderboard`,
`https://kolscan.io/trades`, `https://kolscanbrasil.io`.

**Provenance rule, same as TENEDOR's.** Neither site declares a licence. Nothing is copied:
no asset, no logo, no illustration, no licensed face, no copy string. What is recorded here is
**structure and hierarchy** — which is not ownable and is what makes a tracker legible as a
tracker. Every observation below is a note about someone else's page, not material for ours.

**Capture caveat, again.** kolscan.io's leaderboard was still degraded on 2026-08-27: all fifty
rows read `+0.00 Sol / ($0.0)` and `0 / 0`. Its SOL ticker moved between captures ($97.73 →
$97.95), so the frontend is alive and the indexer is not — the same condition recorded on
2026-08-25. Structure is therefore reliable; magnitudes are not.

### What the genre is, in three seconds

Both sites open on a **leaderboard**, not a marketing page. Dark ground —
kolscanbrasil.io declares `theme-color #111315`. Figures are the largest thing on the row and
carry the sign. Rank is a numeral, with a trophy or medal on the podium. Nothing decorative
competes with a number.

### The leaderboard row, as both sites build it

| Slot | kolscan.io | kolscanbrasil.io |
|---|---|---|
| Rank | `1..50`, trophy on first | `001..`, 🏆🥈🥉 on the podium |
| Avatar | own CDN, keyed **by wallet address** | hotlinked from `pbs.twimg.com` |
| Name | display name, links to account page | display name, sometimes with a group tag |
| Social | X and Telegram glyphs | `@handle` linking to `x.com` |
| Identity chip | **truncated address** (`HFx9E1`) | **truncated address** (`0x3719`) + chain, or **`Wallets Ocultas`** |
| Record | `0 / 0` wins/losses | not on the row |
| PnL | `+0.00 Sol`, largest type on the row | `+2.87 ETH +1.99 BNB +1.78 SOL`, per chain |
| Fiat | `($0.0)` beneath, muted | `(R$44.564,1)`, comma decimal |

Timeframe is a three-way tab in both — `Daily / Weekly / Monthly`. kolscanbrasil.io adds a
`USD / BRL` unit toggle; kolscan.io puts a live SOL price in the header instead.

### The feed

kolscan.io keeps it on its own page — *"Realtime Trades"*, with a *"Filter Wallets"* control.
kolscanbrasil.io's landing page carries **no feed at all**: it is leaderboard-only.

So a live feed on the home page is not a genre requirement. Putting one there is our choice,
and it is the choice that makes the site read as alive on the first three seconds.

### Two places the genre collides with our spec — the spec wins, both times

1. **Addresses.** Both sites print a truncated wallet address on every public row, and
   kolscan.io keys both its avatar URL and its account URL by the full address. `SECURITY.md`
   and spec §8 forbid publishing an address in any form, truncated included, and `serialize.ts`
   is the single place that enforces it. **The identity chip is the X handle here, never an
   address.** kolscanbrasil.io's `Wallets Ocultas` label — which it applies per-KOL — is what
   our whole site does unconditionally, and confirms the phrasing is idiomatic in the genre
   rather than an apology.
2. **Avatars.** kolscanbrasil.io hotlinks `pbs.twimg.com` directly, so X sees every visitor's
   request and a broken upstream is a broken row. Spec §6 requires deriving from the handle via
   unavatar, **proxied and cached by `kol_id`**, never a hotlink. Same visual result, no third
   party in the page's request path, and no address anywhere in the URL.

### What we take, and what stays ours

Taken: leaderboard-first, dense rows, sign-carrying figures as the largest element, podium
marking, the three-way timeframe tab, a fiat figure subordinate to the native one, and the
dark ground the whole category shares.

Not taken: the accent (`DESIGN.md` sets cyan `#22d3ee`, which neither reference uses), the
typefaces, every asset, every string, the multichain columns (v1 is Solana only), the wallet
connect in the header (spec: `/registro` is the only page that ever connects a wallet), and
the sounds and theme-switcher chrome kolscan.io carries.

---

## 6. Second genre pass — the owner's chosen direction

**Re-captured 2026-08-27** (second capture of the day, after the direction change):
`https://kolscanbrasil.io` — HTTP 200, `theme-color #111315`, 69,027 markdown chars.
`https://kolscan.io/leaderboard` and `/trades` as recorded in §5.

Same provenance rule as always: neither site declares a licence, **nothing is copied** —
no asset, no logo, no face, no string. Structure and hierarchy only.

The **KOL detail modal** below is not from a scrape: it is a client-side view no crawler
reaches. It is recorded from **screenshots the owner supplied on 2026-08-27**, and is
marked as such because it is the one part of this file not independently verifiable from
a URL.

### The reference is double, and they split cleanly

kolscan.io is **SOL-only, like us**, so its row and its feed map directly.
kolscanbrasil.io is multichain, but it owns the parts the owner picked: the medals, the
highlighted podium, the cabal badges, and the detail modal.

| Element | kolscan.io | kolscanbrasil.io | **Ours, and why** |
|---|---|---|---|
| Rank | `1..50`, trophy on first | `001.` zero-padded + 🏆🥈🥉 | **Brazil.** The owner asked for medals and a highlighted podium. |
| Podium emphasis | none | gradient-tinted row | **Brazil**, as green / amber / blue tints. |
| PnL columns | one SOL figure | one per chain, signed | **kolscan.io.** We are SOL-only; a per-chain row would be one column wide and imply chains we do not index. |
| Fiat | `($0.0)` under the figure | `(R$74.999,2)` at row end | **Brazil**: at row end, in parentheses, subordinate. |
| Record | `0 / 0` wins/losses | absent | **kolscan.io.** We compute win rate, and `sin cierres` covers its absence. |
| Identity chip | truncated address | truncated address **or** `Wallets Ocultas` | **Neither.** See the invariant below. |
| Avatar | own CDN, keyed by address | hotlinked `pbs.twimg.com` | **Neither.** Our own `/api/avatar/<kol_id>`. |
| Feed | its own page | none | **kolscan.io**, kept on the home page. |
| Unit toggle | SOL price in header | `USD` / `BRL` | **See the currency note.** |
| Window tabs | Daily/Weekly/Monthly | Daily/Weekly/Monthly | **Both.** We already aggregate all three, so all three are real. |

### The row, as the reference builds it (verbatim from the capture)

    001. 🏆  [avatar]  YodaELC  @yodacalls   0x3719 EVM      +3.84 ETH +6.80 BNB  (R$74.999,2)
    002. 🥈  [avatar]  kurtzCR  @kurtzxx     Wallets Ocultas +0.43 ETH -2.72 SOL  (R$39.928,6)

`Wallets Ocultas` sits exactly where the truncated address sits — it is the *same slot*,
which is what makes our unconditional version read as native to the genre rather than as
something withheld.

### The detail modal (owner screenshots, 2026-08-27)

Photo, name, cabal badge, X handle, total PnL in green, and — in the reference — a
truncated address. Then: a **PNL EVOLUTION** card, a green line chart with point markers
and `1D / 7D / 30D` tabs over an hour-range axis; a **STATS** block of PnL Total, Trades,
Volume; a **CHAIN PNL** block, one line per chain; and a **DEFI TRADES** list where a
hidden wallet's rows read `PRIVATE` with a padlock, showing the amount in native currency
and its fiat equivalent.

### The invariants the clone does not get to break

1. **No address, anywhere, ever — truncated included.** Both references print one; we
   print the X handle, and `Wallets ocultas` where there is no public handle to print.
   `SECURITY.md` and spec §8 are the authority, `serialize.ts` is the enforcement, and
   `src/app/*-invariant*` asserts it over rendered HTML. In the modal, where the
   reference puts the address next to the handle, we put nothing.
2. **No hotlink.** Every photo is fetched server-side and served from `/api/avatar/<kol_id>`.
   The reference's `pbs.twimg.com` URLs put X in every visitor's request path.
3. **The seed stays obviously fake**, with generated placeholder images — never a real
   person's photo standing in for an invented KOL.
4. **`noindex` stays** until launch.

### Currency: a product question, not a technical one

The reference toggles `USD / BRL` because it serves one country. We serve Spain and
Latin America, and CLAUDE.md fixes the copy as neutral Spanish for exactly that reason —
so a single national currency is the wrong shape here, and `ARS` would be as arbitrary
for a reader in Madrid or Bogotá as `BRL` would. **Built: `SOL / USD`**, the unit every
reader can price against. Adding a national currency is a product decision, recorded in
the batch report rather than taken here.

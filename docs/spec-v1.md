# kolscanhispano.fun — v1 specification

Status: approved design, ready for an implementation plan.
Date: 2026-08-25.

kolscan.io for the Spanish-speaking community (Spain + Latam), the way kolscanbrasil.io is for
Brazil. Solana only. The domain is the brand. Reference teardown of both sites: `docs/references.md`.

Stack inherited from `outbid-tokens`: Next.js + Postgres (Neon) + Vercel, rate limiting and
`ip_hash` in Postgres, admin behind `ADMIN_TOKEN` with an audit log, security headers, cron via
GitHub Actions. No payments. UI copy in neutral Spanish; code, comments, commits and docs in English.

---

## 1. Scope

**In v1**

1. A roster of Spanish-speaking KOLs — display name, X handle, avatar, one or more Solana wallets —
   populated two ways: seeded from the admin, and by KOLs registering themselves at `/registro`.
   Every profile passes through admin approval before it is visible.
2. Real-time indexing of approved wallets through a Helius Enhanced Transaction webhook, storing
   normalised swaps.
3. A live trade feed on the home page.
4. A page per token: which KOLs bought or sold it and when, plus DexScreener metadata.
5. A leaderboard of **realized** PnL — daily, weekly, monthly — in USD and SOL, with win rate.
6. A page per KOL: trades, open positions, realized and unrealized PnL shown separately.
7. Cabals, minimal form: a group field per KOL (created in the admin) rendered as a badge next to
   the name.
8. Terms, privacy and a risk disclaimer, in Spanish.
9. An affiliate slot in the nav — link and label configurable from the admin, empty at launch.

**Not in v1**

Other chains. Alerts (Telegram/X). A cabal leaderboard and `/cabals` page (v1.5, once real groups
exist). PnL calendar, average duration, top win, token discovery/trending. Wallet connect anywhere
outside `/registro`. Accounts, sessions, payments. WebSockets.

---

## 2. Pages

| Route | Contents |
|---|---|
| `/` | Live trade feed, newest first. Wordmark, nav, affiliate slot. |
| `/kol/<slug>` | Profile, realized and unrealized PnL, win rate, open positions, trade log. |
| `/token/<mint>` | Token metadata, price, and the list of KOLs that bought or sold, with timestamps. |
| `/leaderboard` | Ranked realized PnL. Toggles: `Diario / Semanal / Mensual` and `SOL / USD`. |
| `/registro` | Self-registration. The only page that connects a wallet. |
| `/como-calculamos-el-pnl` | Plain-language explanation of the PnL model. |
| `/terminos`, `/privacidad` | Legal. |
| `/admin/*` | Behind `ADMIN_TOKEN`. |

`slug` is derived from the X handle, immutable once approved, so a rename never breaks a link.

### Feed row

```
[avatar] Nombre [TAG] compró 1,23 SOL (16,9M) de $SP3ND a $0,0000071      hace 4 min
```

Buys green, sells red, USD price in amber, relative time. If the KOL's wallets are public, the
timestamp links to Solscan; if they are hidden, it renders as plain text (§7).

### Leaderboard row

```
 4  [avatar] Nombre [TAG] 𝕏   12 / 5   68,4 %      +18,42 SOL     ($1.802,4)
```

Rank, avatar, name, cabal badge, X link, `wins / losses`, win rate, realized PnL in the selected
unit, the other unit in parentheses. Ranks 1–3 get medals. Inactive approved KOLs stay in the list
at zero — the roster is part of the point.

Numbers are formatted `es-ES` (`1.802,4`), dates relative in Spanish.

---

## 3. Data model

```
kol            id, slug, display_name, x_handle unique citext, avatar_override_url,
               cabal_id, hide_wallets bool default true,
               status enum(pending, approved, rejected, suspended),
               approved_at, suspended_at, created_at

kol_wallet     id, kol_id, address_enc bytea, address_hmac bytea unique, key_version,
               proof_signature_enc, proof_message_enc, proof_verified_at,
               status enum(active, withdrawn), added_at, withdrawn_at,
               backfill_status enum(queued, running, done, capped, failed), backfill_cursor

cabal          id, tag unique (3-4 chars, uppercase), name, logo_url, created_at

kol_claim      id, x_handle, display_name, otp_code, tweet_url, tweet_verified_at,
               terms_accepted_at, hide_wallets bool default true,
               status enum(draft, submitted, approved, rejected), expires_at, ip_hash

claim_wallet   id, claim_id, address_enc, address_hmac, key_version,
               proof_signature_enc, proof_message_enc, proof_verified_at
               -- addresses proven during registration; promoted to kol_wallet on approval.
               -- The global uniqueness check spans claim_wallet and kol_wallet together, so two
               -- pending claims cannot proof the same address.

siws_nonce     nonce pk, address, claim_id nullable, expires_at, consumed_at

raw_tx         signature_hmac pk, signature_enc, payload_enc, key_version, slot, block_time,
               received_at, parsed_at, parse_error, source enum(webhook, backfill, reconcile)

trade          id, signature_hmac, signature_enc, slot, instruction_index, kol_id, wallet_id,
               mint, side enum(buy, sell), token_amount numeric, sol_amount numeric,
               usd_amount numeric, sol_usd numeric, price_sol numeric, price_usd numeric,
               fee_sol numeric, block_time, basis enum(known, unknown)
               unique (signature_hmac, instruction_index, wallet_id)

position       kol_id, mint, qty numeric, cost_sol numeric, avg_cost_sol numeric,
               realized_sol numeric, realized_usd numeric, first_buy_at, last_trade_at,
               basis enum(known, unknown), dirty bool
               pk (kol_id, mint)

pnl_position_daily
               kol_id, mint, day date, realized_sol, realized_usd, wins, losses
               pk (kol_id, mint, day)
               -- The replay is scoped to one (kol, mint), so realized PnL accumulates per
               -- position first. A per-mint replay writing kol-level daily rows directly
               -- would overwrite every other mint's contribution to that day.

pnl_daily      kol_id, day date, realized_sol, realized_usd, wins, losses
               pk (kol_id, day)
               -- Derived: the sum of pnl_position_daily over the KOL's mints for that day,
               -- excluding positions whose basis is unknown (§4.5).

token          mint pk, symbol, name, decimals, image_url, price_usd, price_sol, liquidity_usd,
               price_state enum(priced, stale, unpriced), pair_url, updated_at

sol_price      minute timestamptz pk, usd numeric

helius_usage   day date pk, credits_estimated int, pushes int, api_calls int

setting        key pk, value jsonb          -- affiliate slot, caps, feature switches

audit_log      id, actor, action, target_type, target_id, before jsonb, after jsonb,
               at, ip_hash
```

`trade` is the only source of truth. `position`, `pnl_daily` and the leaderboard are derived and
recomputed from it, which is what makes late-arriving backfill data safe (§5.3).

All money is `numeric`, never float. Token amounts are stored raw alongside `decimals`.

Wallet addresses, transaction signatures and raw payloads are encrypted at rest and searched through
a keyed HMAC index; §8 explains why and what that does and does not buy. Everything else — mints,
amounts, timestamps, prices — stays in cleartext: it is not personal data and the derived tables
need to aggregate over it.

---

## 4. PnL model

### 4.1 Unit of account

SOL is the truth; USD is derived. Every trade stores `sol_amount`, `usd_amount` and the `sol_usd`
rate at its block time. USD rankings sum the USD value **at trade time** and never re-price. The SOL
and USD rankings will differ; that is correct and is explained on `/como-calculamos-el-pnl`.

### 4.2 Cost basis: weighted average, per (kol, mint)

Lifetime PnL is identical under FIFO and weighted average; only the realized/unrealized split
differs, and the leaderboard is realized-only. Weighted average wins because it is stable when
trades arrive out of order — which is exactly what a 30-day backfill landing after the webhook has
already written today's trades produces. FIFO lots would force a full-position replay on every late
insert.

```
buy:   qty += q;  cost_sol += sol_in;  avg = cost_sol / qty
sell:  realized_sol += sol_out - avg * q_sold
       qty -= q_sold;  cost_sol -= avg * q_sold
```

Basis is per KOL, not per wallet: a KOL with three wallets has one position per mint.

### 4.3 What counts as a trade

A trade is a swap where the wallet's SOL/WSOL balance moves against a SPL token balance.

- **SOL-quoted swaps**: taken directly.
- **USDC/stable-quoted swaps**: normalised to SOL at the `sol_usd` rate of that block.
- **Token ↔ token swaps**: close leg A and open leg B at the implied SOL value of the trade.
- **SOL ↔ stablecoin rotation is not a trade** and is not indexed. kolscan.io counts these, which is
  why its trade log shows entries like `Sell 167 USDC`.
- **Stablecoin ↔ stablecoin rotation is not a trade either.** Decided extension, batch 2,
  commit `9a42a1c`. The rule above named SOL on one side, so a USDC↔USDT swap fell through
  the stable branch — USDC read as the quote, USDT as the token — and was written as a
  position in a dollar, priced off the other dollar at `sol_usd`. Two such rows existed in a
  2,397-transaction sample of real mainnet swaps: `sell 178.034051 for 0.89020365 SOL` and
  `buy 143.573972 for 0.71789742 SOL`, in wallets whose entire real native movement was the
  transaction fee (17,117 and 13,541 lamports). The reason is the one already in this
  section: the wallet took no position. Whether a stablecoin can be priced is a reason to
  refuse a *quote*; it is not a reason to book a *position*. `parse-swap.ts` names the union
  once as `STABLE_MINTS` so the rotation test and the quote branch cannot drift apart again.
- **Transfers between wallets of the same KOL are netted out**, not recorded as a sell and a buy.

### 4.4 Fees

The SOL side of a trade is the wallet's **actual net SOL/WSOL balance delta**, not the nominal swap
amount. That already contains AMM fees, launchpad fees and slippage, with no double counting. The
transaction fee and any identifiable tip are taken from the Helius payload (`fee`, in lamports) and
subtracted separately, stored in `trade.fee_sol`. At the 0.25–3 SOL ticket sizes visible in the
reference data, fees are material.

### 4.5 Unknown cost basis

Tokens that arrive by transfer — airdrop, bridge, an unregistered wallet — have no cost. The
position is marked `basis = unknown`; its sells are **excluded from the leaderboard** and shown on
the KOL page labelled *sin base de costo*. Without this, anyone can manufacture realized profit by
funding a position from outside.

### 4.6 Prices and the unpriced case

`token.price_state` has three values:

| State | Condition | Rendering |
|---|---|---|
| `priced` | DexScreener pair, liquidity ≥ `PRICE_MIN_LIQUIDITY_USD`, traded < 24 h | normal value |
| `stale` | pair exists but fails one of the above | value + *precio desactualizado* chip |
| `unpriced` | no pair, or below the liquidity floor | **no number**; *sin precio* chip |

An unpriced bag is never rendered as −100 %. Both reference sites do exactly that, which makes a rug
and an unindexed pool look identical. Because the leaderboard is realized-only, price state cannot
affect the ranking at all — that is the main reason for choosing realized.

### 4.7 Realized vs unrealized

- **Leaderboard**: realized only, bucketed by the timestamp of the sell.
- **KOL page**: `PnL realizado` and `PnL no realizado (marcado a precio)` as two separate figures,
  each labelled, with the price state of every open position visible.

Never a single blended number. kolscan.io blends them per token and its own page contradicts itself
(win rate 27.3 % in the stats panel, `3 / 8` = 37.5 % in the token list directly below).

### 4.8 Win rate

Per **closed position**, not per sell. A position counts once, when ≥ `CLOSED_POSITION_THRESHOLD`
(default 95 %) of the acquired quantity has been sold; it is a win if **that episode's** realized
PnL is positive — the realized total since the position last reopened, never the cumulative one.
A position that reopens after closing can close again, and counts again.

Deciding on the cumulative total would mean that once a position had ever been in profit, every
later closure counted as a win: a day whose own realized PnL is negative would carry a win, which
is the contradiction §4.7 objects to in the reference site.

Counting per sell rewards whoever exits in twelve tranches. The UI states the definition:
*posiciones cerradas ganadoras / posiciones cerradas*.

### 4.9 Windows

Calendar-aligned UTC: `Diario` = the current UTC day, `Semanal` = the current ISO week, `Mensual` =
the current calendar month. The UI labels it (`día UTC`). The community spans UTC−6 to UTC+1 and
there is no "Hispanic" timezone; any local choice hands the day boundary to one country.

### 4.10 Recomputation

`trade` inserts mark `(kol_id, mint)` dirty. A worker replays every trade of a dirty position in
`block_time, slot, instruction_index` order and rewrites `position` and the affected `pnl_daily`
rows. Idempotent, order-independent, and cheap because it is scoped to one position.

---

## 5. Ingestion

### 5.1 Verified Helius numbers

From `helius.dev/pricing`, `helius.dev/pricing.md` and `helius.dev/docs/webhooks`, checked
2026-08-25:

| Free plan | Value |
|---|---|
| Credits | **1,000,000 / month** |
| RPC rate limit | **10 requests/sec** |
| DAS | 2 req/sec |
| Webhooks | **included** |
| Archival data | **included** (needed for a 30-day backfill) |
| Support | community only |

| Operation | Credits |
|---|---|
| RPC call | 1 (`getProgramAccounts` and archival calls: 10) |
| DAS call | 10 |
| **Webhook push** | **1** — charged whether or not our endpoint processes it |
| **Webhook create / edit / delete via API** | **100 per request** |
| **Enhanced Transactions API call** | **100** |

Two consequences that shape the design:

1. **Editing the webhook is expensive.** A naive reconciliation cron running every 15 minutes would
   cost 96 × 100 = 9,600 credits/day, ~288k/month — 29 % of the entire free budget on bookkeeping.
   So: store a hash of the applied address set and **call the edit API only when the set actually
   changed**.
2. **The Enhanced Transactions API costs 100 credits per call** and returns up to 100 transactions,
   so it is ~1 credit per transaction. Gap detection must not use it: `getSignaturesForAddress` is
   1 credit and returns up to 1,000 signatures, so we detect gaps cheaply by signature and only pay
   the enhanced parser for the transactions we are actually missing.

**Also verified:** Helius retries failed deliveries and duplicates are expected, so ingestion must be
idempotent. And Helius auto-disables failing webhooks — on the free plan, evaluated over a **24-hour
window** at a ≥95 % failure rate, checked every 4 hours — and **free plans get no email
notification**. A disabled webhook is therefore a silent outage; §5.5 covers it.

**Capacity, verified:** up to **100,000 addresses per webhook** via the API. A single webhook covers
v1 by three orders of magnitude; the reconciler is still written so that sharding is a config change.

**Delivery contract, verified:** our endpoint must return `200` **within 1 second**. Helius retries
on `5xx`, on `4xx` other than `403`, on timeout and on connection failure — **3 attempts, 1 second
apart** — and if all fail **the event is permanently lost**, with no re-queue. That single sentence
is the whole argument for §5.5: the only recovery for a dropped event is our own gap repair.
Enhanced webhooks do not deliver failed transactions, which is what we want.

### 5.2 Webhook

One Enhanced Transaction webhook, `transactionTypes: ["SWAP"]`, `accountAddresses` = every `active`
wallet of every `approved` KOL — **bare addresses, no names or labels, and a neutral webhook name**
(§8.5).

`POST /api/webhooks/helius`:

1. Compare the `Authorization` header against `HELIUS_WEBHOOK_SECRET` in constant time. Reject
   otherwise, and rate-limit by `ip_hash` as in `outbid-tokens`.
2. Encrypt the payload and insert into `raw_tx` with `ON CONFLICT (signature_hmac) DO NOTHING` —
   the idempotency barrier for Helius retries (§8.2).
3. Return `200` immediately. No parsing in the request path — the budget is 1 second end to end,
   and three failed attempts lose the event for good.

A worker parses unparsed `raw_tx` rows into `trade` rows. Parse failures are recorded in
`parse_error` and left in place: the payload is already paid for, so a parser fix can reprocess it
without spending another credit. Storing raw first is what makes the parser cheap to iterate on.

### 5.3 Backfill

**Backfill starts on admin approval, never on registration.** This is the single most important
quota rule: otherwise anyone with a script can drain the monthly budget by registering wallets with
long histories.

On approval, each wallet is queued. A GitHub Actions cron drains the queue, `BACKFILL_WALLETS_PER_RUN`
(default 1) at a time, walking `/v0/addresses/{address}/transactions?type=SWAP` back to
`BACKFILL_DAYS` (default 30) or `BACKFILL_MAX_PAGES` (default 30 pages ≈ 3,000 transactions),
whichever comes first. A wallet stopped by the page cap is marked `capped` and shown as such in the
admin — a silent truncation would read as complete history.

Cost: 100 credits per page. A 30-page wallet costs 3,000 credits; approving 60 wallets costs
~180,000, about 18 % of a monthly budget, spread across days by the queue.

Adding a wallet later backfills it in full. A KOL cannot choose the date from which they are counted.

### 5.4 Address-set reconciliation

A cron computes the desired address set from the database, hashes it, and compares it with
`setting['helius_webhook_address_hash']`. If unchanged: no API call, zero credits. If changed: one
edit call (100 credits), then the hash is updated. Approving, suspending, withdrawing a wallet or
adding one all flow through this single path, so the database stays the source of truth and the
webhook is only ever repaired, never manually curated.

### 5.5 Gap repair

Webhook deliveries can be lost, and on the free plan the webhook can be disabled without notice.
Every `RECONCILE_INTERVAL_HOURS` (default 6), per active wallet:

1. `getSignaturesForAddress` (1 credit) for the window since the last known signature.
2. Diff against `raw_tx`.
3. Batch the missing signatures into `POST /v0/transactions` calls of 100 (100 credits each).

If a wallet returns a gap larger than `HEALTH_GAP_ALERT`, or if no webhook push has arrived at all
in `HEALTH_SILENCE_HOURS`, the run writes a health record and surfaces a banner in the admin.

**Self-healing.** A banner alone is not enough: on the free plan the auto-disable is silent and the
window is 24 hours, so a weekend outage is a weekend of lost trades. When the reconciler sees both
signals together — no pushes in `HEALTH_SILENCE_HOURS` *and* `getSignaturesForAddress` showing real
on-chain activity in that window — it repairs the webhook itself:

1. Read the webhook. If it exists and is inactive, `PATCH { "active": true }` (100 credits).
2. If it is gone, recreate it from the database address set (100 credits).
3. Backfill the silent window through the gap-repair path above, so nothing is lost.
4. Write an `audit_log` entry — `webhook_reactivated` or `webhook_recreated` — with the silent
   window, the number of transactions recovered and the credits spent, and raise the admin banner
   anyway. Self-healing that heals quietly hides a recurring fault.

100 credits is a rounding error against 1M/month; a day of missing trades is not. Re-enabling grants
a 24-hour grace period, so a repair loop cannot thrash: the reconciler additionally refuses to repair
the same webhook more than `HEALTH_REPAIR_MAX_PER_DAY` (default 3) times in 24 hours, and escalates
to the banner alone after that.

### 5.6 Budget enforcement

`helius_usage` accumulates an estimate per day from the credit table above. When the running month
exceeds `HELIUS_MONTHLY_CREDIT_BUDGET` (default 800,000 — 80 % of the free tier):

1. Backfills pause first (largest, least urgent consumer).
2. Then gap repair reduces to `HEALTH_GAP_ALERT`-triggered runs only.
3. Live webhook ingestion is never throttled — it is the product.

Our own client limiter stays at `HELIUS_MAX_RPS` (default 5, half the free-tier 10) so a burst never
trips the account limit.

### 5.7 Prices and metadata

Never Helius. DexScreener for token metadata and prices, cached in `token` with a TTL per state
(`priced` 60 s, `stale` 5 min, `unpriced` 1 h). SOL/USD from a single source once per minute into
`sol_price`; trades resolve their rate from the containing minute, and the backfill uses the
historical row for its block time.

---

## 6. Registration (`/registro`)

The only page in the product that connects a wallet. It signs a message and **never builds, signs or
sends a transaction**.

### 6.1 Flow

| Step | Endpoint | Effect |
|---|---|---|
| 1 | `POST /api/registro/nonce` | Issues a nonce bound to the address, 5-minute expiry |
| 2 | `POST /api/registro/verify` | Verifies the ed25519 signature, creates the claim, sets a short-lived httpOnly cookie |
| 3 | `POST /api/registro/handle` | Records the X handle, issues a one-time code |
| 4 | `POST /api/registro/tweet` | Validates the pasted tweet URL |
| 5 | `POST /api/registro/wallet` | Adds another address; one signature per address, nonce bound to the claim |
| 6 | `POST /api/registro/submit` | Requires terms acceptance; moves the claim to `submitted` |

Proven addresses live in `claim_wallet` until approval, when they are promoted to `kol_wallet` rows
and the backfill queue is filled. Uniqueness is checked across both tables, so a second pending
claim cannot proof an address that is already spoken for.

Signed message:

```
kolscanhispano.fun quiere verificar que controlas esta wallet.
Esto es una firma de mensaje. No mueve fondos ni aprueba ninguna transacción.

Wallet: <address>
Acción: <alta de perfil | agregar wallet a #<claim>>
Nonce: <nonce>
Expira: <ISO8601>
```

Verified server-side with `tweetnacl` against the UTF-8 bytes. The nonce is consumed on first use;
the domain line binds the signature to this site; expiry bounds replay.

### 6.2 X handle verification

The KOL posts a tweet containing the one-time code and pastes its URL. The server fetches the tweet
through the public syndication endpoint and checks two things: the handle in the URL matches the
claimed handle, and the code appears in the text.

**This is an assistant, not a gate.** X's API is no longer free to read and the syndication endpoint
is unofficial. If the fetch fails, the claim still reaches the admin queue with the tweet URL
attached and a human approves it. Because every registration is admin-approved anyway, an unreliable
fetch degrades to manual review rather than breaking the flow. Firecrawl is the fallback fetcher.

### 6.3 Avatar

Derived from the verified handle via `unavatar.io/x/<handle>`, proxied through
`/api/avatar/<kol_id>` and cached — so the public URL is keyed by `kol_id` and leaks nothing (§7),
and the image is served from our own domain rather than hotlinked. No user uploads: no storage, no
image validation, no content moderation, no abuse surface on a public endpoint. The admin can set
`avatar_override_url` when the derived image is wrong or missing.

### 6.4 Wallets that cannot sign

Ledger and Squads-style multisigs do not reliably sign off-chain messages. `/registro` says so
up front and points those KOLs to manual onboarding through the admin, rather than letting them
discover it at the signature prompt.

### 6.5 Abuse controls

Rate limit by `ip_hash`. One pending claim per handle. `kol_wallet.address` is globally unique — an
address belongs to one KOL and cannot be claimed by another. Claims expire after
`CLAIM_TTL_HOURS`.

---

## 7. Hidden wallets

`hide_wallets` defaults to `true`. A hidden KOL's wallets are indexed identically; only publication
changes. This is a promise that leaks through implementation details, so it is specified as
invariants:

| Leak | Closed by |
|---|---|
| API responses carrying `wallet` for the front end to hide | The serializer **omits** the address for hidden KOLs. Enforced in the data layer, not the component. |
| The Solscan link on each trade | For hidden KOLs, neither the signature nor the link is exposed. The timestamp renders as text. |
| Avatars served from a wallet-keyed CDN path | Avatars are keyed by `kol_id`. kolscan.io serves `cdn.kolscan.io/profiles/<wallet>.png` and leaks the address in the image URL. |
| Token page "who bought" | Name and cabal badge only. Never address, never signature. |
| Enumerable identifiers and cursors | Feed cursor is `(block_time, id)`; ids are not guessable. |
| The admin | Sees everything; every view of a hidden wallet is written to `audit_log`. |

**Honest copy, on the KOL page and in the terms:** amount, mint and timestamp are enough to find the
transaction in any explorer. *Wallets ocultas* means we do not publish the address — it is not
anonymity. Promising more would be a lie.

Spanish label wherever a wallet would otherwise appear: **"Wallets ocultas"**.

---

## 8. Protecting the wallet ↔ KOL link

`hide_wallets` (§7) governs what we publish. This section governs what an attacker gets from the
database itself. The two are different problems and the second one is where most of the risk is: the
mapping from a public persona to a set of Solana addresses is the most sensitive thing this product
holds, and it exists because indexing requires it — not by accident.

### 8.1 Encryption at rest with a keyed search index

`kol_wallet.address` is stored as `address_enc`: **AES-256-GCM**, a fresh 96-bit IV per row, the
auth tag stored with the ciphertext, and AAD binding the value to its column and row id so a
ciphertext cannot be moved between fields or rows. Alongside it, `address_hmac` holds
**HMAC-SHA-256** of the address under a **separate key**, which provides:

- equality lookup — the webhook resolves an incoming address by HMAC, never by decrypting rows;
- the globally unique index that enforces "one address belongs to one KOL" (§6.5).

Two independent keys, `WALLET_ENC_KEY` and `WALLET_HMAC_KEY`, live in Vercel environment variables
and **never in Neon**. A database dump alone therefore yields neither the addresses nor a usable
rainbow table over them: without the HMAC key an attacker cannot test a guessed address against the
index.

`key_version` is stored per row. Rotation re-encrypts rows in place under the new version; rotating
the HMAC key additionally rebuilds the index, which is possible precisely because we can still
decrypt.

> **Superseded 2026-08-28 (migration `010_drop_key_version.sql`, see DECISIONES.md).** The
> `key_version` *column* is gone. Nothing ever wrote it, so it said `1` on every row because the
> default said `1`, and a rotation to v2 would have left it saying `1` on the v2 rows. The version
> is still stored per row — as byte 0 of the blob, inside the AEAD's authenticated data — and
> "which rows are still v1" is still a plain SQL question: `get_byte(payload_enc, 0)`. The rest of
> this paragraph stands: rotation re-encrypts in place, and rebuilding the index remains possible
> because the rows can still be decrypted.

### 8.2 Signatures and raw payloads are encrypted too

**A transaction signature identifies the wallet to anyone with an explorer.** Encrypting the address
column while leaving `trade.signature` and the Helius payload in cleartext would buy nothing against
a database compromise — the attacker would paste signatures into Solscan and rebuild the whole map.

So the same treatment applies uniformly:

- `raw_tx`: `payload_enc` and `signature_enc`, keyed by `signature_hmac` (which also gives the
  idempotency barrier for Helius retries).
- `trade`: `signature_enc`, with `signature_hmac` in the uniqueness constraint.

Uniform, not conditional on `hide_wallets` — otherwise toggling the flag would require re-encrypting
history, and a KOL who switches to hidden would have left plaintext behind. Public KOLs get their
signature decrypted at serialization time so their Solscan links still work.

The cost is that raw payloads can no longer be queried with SQL. That is acceptable: parsing already
happens in the application, and the parser reads rows it decrypts in memory.

### 8.3 No real addresses in the repository

Real addresses must never appear in seeds, fixtures, tests, logs or error messages. Errors and log
lines reference `wallet_id` and `kol_id`; the logger carries a redaction rule for base58 strings of
address and signature length.

A test scans the tracked working tree for base58 strings of 32–44 characters (addresses) and 87–88
characters (signatures) and fails on anything outside an explicit allowlist. The allowlist holds
only well-known public constants — the SOL and USDC mints, the SPL Token, Associated Token and
System program ids — each with a comment saying why it is there. It holds no wallet addresses at
all, because tests that need a keypair **generate an ephemeral one at run time** rather than
hardcoding one. That keeps the allowlist small enough that adding to it is a visible, reviewable
act.

### 8.4 Admin reveal is a deliberate, logged act

Addresses render masked in every admin view by default (`Abc1…9xYz`). Revealing one requires a
step-up secret, `ADMIN_REVEAL_SECRET`, distinct from `ADMIN_TOKEN`, so a leaked session token is not
by itself a de-anonymisation tool. Each reveal decrypts exactly one row, is scoped to the request,
and writes an `audit_log` entry naming the actor, the target and the reason. There is no bulk
reveal.

**Export endpoints do not exist.** No CSV, no JSON dump, no "download all". The admin is a review
surface, not a data extraction tool; a feature that exports the roster is a feature that exfiltrates
it.

### 8.5 Third parties see addresses or names, never both

The Helius webhook is registered with **bare addresses only** — no names, no labels, no tags, and a
neutral webhook name that identifies nothing. Helius necessarily learns the address set, since that
is what it watches; it never learns whose it is.

The other outbound calls are the mirror image: DexScreener is queried by mint, `unavatar.io` by X
handle. Neither ever receives a wallet address. No third party is given both halves of the link.

### 8.6 What this does not protect

Written out in `SECURITY.md`, and stated here because a security control that oversells itself is
worse than none: **a compromised server with access to the environment defeats all of it.** The keys
are there, the decryption path is there, and the mapping falls out. These layers raise the cost of a
database-only compromise — a leaked connection string, a stolen backup, a Neon-side incident — and
they narrow accidental exposure through logs, fixtures and exports. They are not a defence against
an attacker who already runs our code.

## 9. Admin

`ADMIN_TOKEN`, every mutation in `audit_log` with actor, before, after and `ip_hash`.

- **Approval queue**: pending claims with handle, tweet link and its verification result, wallet
  list, signature proofs. Approve or reject with a reason. Approval creates the KOL, enqueues
  backfills, and triggers address-set reconciliation.
- **KOL editing**: display name, cabal, `hide_wallets`, `avatar_override_url`. A name change by the
  KOL sets `status = pending` again and re-enters the queue; cabal assignment is admin-only.
- **Cabals**: create with a 3–4 character uppercase tag, name and logo. Assign to KOLs. No
  aggregate view in v1.
- **Withdraw a wallet** — `kol_wallet.status = withdrawn`. Indexing stops, the address leaves the
  webhook at the next reconciliation, **and the history stays**: past trades keep counting in
  already-closed periods. The KOL page shows *N wallets · 1 retirada*. Without this, a KOL can
  delete a losing wallet before a period closes and the leaderboard becomes rewritable by the people
  it ranks.
- **Suspend a KOL** — `kol.status = suspended`. This is the removal the terms promise. The profile
  disappears from **every public surface, including already-closed leaderboards**, indexing stops,
  and all their wallets leave the webhook. Data stays in the database with its audit trail; nothing
  is deleted.

  Withdrawing a wallet and suspending a KOL are two different operations with two different
  buttons. One is bookkeeping, the other is honouring a removal request.
- **Affiliate slot**: label and URL in `setting`. Empty at launch renders nothing.
- **Health**: ingestion lag, credit usage against budget, capped backfills, wallets with no recent
  pushes.

---

## 10. Realtime, caching, security

Polling, no WebSockets. `GET /api/feed?since=<cursor>` returns trades after the cursor; the client
polls every 3–5 s with `ETag`/`If-None-Match`, so an idle feed costs a `304`. Two seconds of edge
cache on the unparameterised first page. Index on `trade (block_time DESC, id DESC)`.

Leaderboard and token pages are ISR with a short revalidate; both read the derived tables, never
recompute at request time.

Security headers, `ip_hash` rate limiting and the admin token pattern come from `outbid-tokens`. The
webhook endpoint additionally verifies its shared secret in constant time. No cookies except the
short-lived registration cookie; no analytics that fingerprint.

---

## 11. Legal and brand

`/terminos`, `/privacidad`, and a risk disclaimer in the footer: the site publishes public on-chain
data, is not investment advice, and past results guarantee nothing. The terms state plainly that
**any listed KOL can request removal and it will be honoured** — implemented as the suspend
operation in §9 — and explain what *wallets ocultas* does and does not mean (§7).

Brand: a typographic wordmark reading `kolscanhispano.fun`, one accent colour, dark background. No
design pass before launch.

---

## 12. Testing

Test-driven, per the repo workflow. Beyond normal coverage:

- **`/registro` never builds or sends a transaction.** An assertion over the registration module's
  import graph and source that no transaction-constructing or transaction-sending API is reachable
  from it — no `Transaction`/`VersionedTransaction` construction, no `sendTransaction`,
  `signTransaction`, `signAllTransactions`, `sendAndConfirmTransaction`. The wallet adapter is
  configured for `signMessage` only. This test is the guarantee behind the promise the signed
  message makes to the user, so it fails the build.
- **No real addresses in the repository** (§8.3): the base58 scan over the tracked tree, with the
  allowlist of public program and mint constants. Adding an address to the allowlist must be a
  deliberate, reviewed change.
- **Crypto round-trip and index**: encrypt/decrypt with AAD binding, a ciphertext moved between rows
  or columns fails to authenticate, the HMAC index resolves an address the webhook is matching, and
  the uniqueness constraint rejects the same address under a second KOL.
- **Admin reveal**: a reveal without the step-up secret fails; a successful reveal writes exactly one
  `audit_log` row; no route returns more than one address per request.
- **Hidden-wallet invariants**: a serializer-level test asserting that no public API response for a
  hidden KOL contains an address or a signature — feed, KOL page, token page, leaderboard.
- **PnL golden cases**: partial exits, re-entry after a full exit, out-of-order backfill arriving
  after live trades, unknown-basis inflows, unpriced positions, token↔token swaps, fee handling.
  The recomputation must be order-independent — feeding the same trades in a shuffled order must
  produce identical `position` and `pnl_daily` rows.
- **Idempotency**: replaying a webhook payload, and a backfill that overlaps live data, produce no
  duplicate trades.
- **SIWS**: expired nonce, reused nonce, wrong domain in the message, signature from a different
  key, address that is not a valid ed25519 public key.

---

## 13. Configuration

| Key | Default | Purpose |
|---|---|---|
| `HELIUS_API_KEY`, `HELIUS_WEBHOOK_SECRET` | — | Credentials |
| `HELIUS_MONTHLY_CREDIT_BUDGET` | `800000` | 80 % of the free tier |
| `HELIUS_MAX_RPS` | `5` | Half the free-tier limit |
| `BACKFILL_DAYS` | `30` | History fetched per new wallet |
| `BACKFILL_MAX_PAGES` | `30` | ≈3,000 transactions, 3,000 credits |
| `BACKFILL_WALLETS_PER_RUN` | `1` | Queue drain rate |
| `RECONCILE_INTERVAL_HOURS` | `6` | Gap repair cadence |
| `HEALTH_SILENCE_HOURS` | `3` | Silence that triggers the health check |
| `HEALTH_REPAIR_MAX_PER_DAY` | `3` | Cap on self-healing attempts before escalating (§5.5) |
| `PRICE_MIN_LIQUIDITY_USD` | `1000` | `unpriced` floor |
| `CLOSED_POSITION_THRESHOLD` | `0.95` | Win-rate closure rule |
| `CLAIM_TTL_HOURS` | `48` | Registration claim expiry |
| `ADMIN_TOKEN` | — | Admin auth |
| `WALLET_ENC_KEY` | — | AES-256-GCM key for addresses, signatures, payloads (§8.1) |
| `WALLET_HMAC_KEY` | — | Separate HMAC-SHA-256 key for the blind index (§8.1) |
| `ADMIN_REVEAL_SECRET` | — | Step-up secret for revealing one address (§8.4) |

Every cap is configurable so the free tier can be re-tuned, or a paid plan absorbed, without a code
change.

---

## 14. Open items

1. Seed roster: 15–20 KOLs entered from the admin so the site does not launch empty.
2. The syndication endpoint used for tweet verification is unofficial and may break; the manual path
   is the contract, the fetch is the convenience.

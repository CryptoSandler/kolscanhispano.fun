# Multichain: what moves, what does not, and what it costs

Analysis before code, for adding **Robinhood Chain (4663), BNB Chain (56) and Ethereum (1)**
to a Solana-first tracker. Written 2026-08-31. Everything below is read out of the code with
line references, or measured; where it is inferred it says so.

Provider selection and the Robinhood-specific findings are in their own sections, which are
filled from separate research passes.

---

## 1. What is coupled to Solana, and what already is not

The hypothesis going in was: ingestion, the swap parser, the SOL price path and wallet
signing are chain-specific; the PnL engine, the UTC windows, the leaderboard, wallet
encryption and avatars are agnostic. **It is right in outline and wrong in four places**,
and the four are what would have made this overrun.

### Agnostic, confirmed, no work

- `src/lib/windows.ts` — UTC calendar arithmetic, imports nothing.
- `src/lib/crypto.ts` `encrypt`/`decrypt`/`aadFor` (`:47-82`) — string in, bytes out. The
  only rule is that an AAD part contains no `:`.
- The whole avatar path — `avatar.ts:31` keys on the X handle, and `serialize.ts` exposes
  it by `kol_id`. A wallet's chain never enters it.
- `src/lib/pnl.ts` — no lamport, no mint constant, no decimal count; `parseDecimal`/`mulDiv`
  over strings and `utcDay`. Two seams below, but the arithmetic itself carries over.
- `monogram.ts`, `chart.ts`. `format.ts:133` hardcodes a `" SOL"` suffix: one line.

### The four places the hypothesis was wrong

**1.1 — `raw_tx.signature_hmac` is the primary key on its own** (`migrations/001_core.sql:45`),
and `trade_unique_idx` is `(signature_hmac, instruction_index, wallet_id)` (`001:92-93`).
Both dedupe with `ON CONFLICT DO NOTHING` (`raw-tx.ts:97`, `parse-swap.ts:1683`).

The same signed transaction broadcast on two EVM chains has **an identical hash**. The
second chain's copy is dropped, the webhook answers `200 OK`, and nothing anywhere records
that it happened. `chain` must enter both keys **before the first EVM row lands** — this is
the one item on the list that is unrecoverable after the fact, because the evidence of the
loss is the row that was not written.

**1.2 — `blindIndex` is case-sensitive** (`crypto.ts:104-105`, `HMAC(\`${domain}:${value}\`)`).
Structurally agnostic as hoped — it never touches base58 — but EIP-55 `0xAbC…` and lowercase
`0xabc…` hash to different digests. `kol_wallet.address_hmac` is `UNIQUE` (`001:30`) and
`findWalletByAddress` (`wallets.ts:17-23`) is the only lookup path, so a wallet registered in
one casing and delivered by the indexer in another **is invisible forever** — it looks
untracked, and untracked means silently skipped.

The fix is canonicalisation *before* `blindIndex`, never inside it: the function's contract
is "arbitrary string", and teaching it about address formats would make every caller's
behaviour depend on what it guesses the string is.

**1.3 — `mint` is a bare key in five places**: `token.mint` PK (`001:59`),
`position (kol_id, mint)` (`001:110`), `pnl_position_daily (kol_id, mint, day)` (`003:23`),
two indexes (`001:95-96`), and the join `LEFT JOIN token tk ON tk.mint = t.mint`
(`feed.ts:75`). Deterministic CREATE2 deployment puts **the same address on several EVM
chains routinely**, so two different tokens would share one price row and merge into one
position. `token` becomes `(chain, address)`, `trade` references it compositely, and `chain`
enters both PnL keys.

**1.4 — `decimal.ts`'s stated margin is false for EVM, and that is worse than a break.**
It says (`:17-22`): *"18 leaves nine spare digits below the smallest unit that exists on
chain"*, and `parseDecimal` (`:50-58`) says its rounding is *"unreachable in practice"*
because *"no value this system writes has more than 9 fractional digits"*.

EVM native is 18 decimals. **One wei is exactly one unit in the last place**, so the spare
digits are zero and the rounding is reachable. Verified by arithmetic, not assumed:
`18 − 9 = 9` on Solana, `18 − 18 = 0` on EVM.

Nothing breaks today, but two written invariants stop being true, and a false invariant is
discovered later and more expensively than a broken one. **Recommendation: `DECIMALS` 18 →
27**, which restores *"nine spare digits below the smallest on-chain unit"* exactly for an
18-decimal chain. Checked: all 20 `NUMERIC` columns are declared with no precision or scale,
so Postgres already stores arbitrary scale and this is an application-side change with no
column migration.

### Chain-specific as expected, with one surprise

- **The parser's unit grid is inside it, not at its edges.** `LAMPORT_DECIMALS = 9`
  (`parse-swap.ts:240-243`), `toLamports` (`:906-909`, which *divides and truncates* above 9
  decimals — a WETH leg would lose nine digits), `wsolLamportsIn`, `stableLamportsFor`, the
  `WSOL_MINT` filter (`:937`, `:1211`). An EVM parser reuses the **shape** of this file and
  none of its constants.
- **`sol_price` generalises cleanly** to `native_price(chain, minute, usd)` with PK
  `(chain, minute)`; migration 009's `usd > 0` CHECK is chain-independent. Only the
  *sources* are Solana-bound: the Binance `SOLUSDC` symbol (`prices.ts:59-61`) and a
  `chainId !== "solana"` filter (`:785`).
- **The surprise: the Helius route is barely coupled.** `webhooks/helius/route.ts:87-140`
  authenticates, bounds the body and stores — **it never parses**. Only the shared secret and
  the `{signature, slot, timestamp}` event shape are Solana's. An EVM ingestor is a sibling
  route writing the same `raw_tx`, which is precisely why 1.1 bites there first.

### Two seams in the "agnostic" PnL engine

`TRADES_SQL` (`pnl.ts:81-85`) needs `AND chain = $3`. And its replay order —
`block_time, slot, instruction_index` — is the chain's sequence under Solana's names; on EVM
that pair is `(block_number, log_index)`. **`log_index` is genuinely non-zero**, so the
tiebreak the file's header currently calls inert becomes load-bearing the day EVM rows land.

### The no-doxx guard is nearly blind to EVM

`hygiene.ts:6` scans base58, which **excludes `0`** — so a 40-hex address is chopped at every
zero and only about 7.6% of them survive as a run long enough to clear the 32-character floor.
The honest change is a second pattern anchored on the prefix (`0x` + 40 hex, and `0x` + 64 for
tx hashes), **not** a bare `[0-9a-f]{40}`: that is a git SHA, and `ACTION_PIN`'s note
(`:43-45`) already records why blanket hex exemption opens a hole — `address_hmac` is 64
lowercase hex. Requiring the `0x` prefix means the existing SHA carve-out needs no second
exception.

### Wallet proof

SIWS is documented and unbuilt (`docs/spec-v1.md:104`, `:421-443`).
`kol_wallet.proof_signature_enc` / `proof_message_enc` (`001:32-34`) are unused `BYTEA`, so
**EIP-4361 (SIWE) fits with no migration** — the open question on that table is `chain`, not
the proof columns. `ids.ts:9-15` needs EVM siblings for fixtures.

---

## 2. Ranking: consolidated USD, with a chain filter

**Recommendation applied, and it is a product decision — left open for the owner.**

`leaderboard.ts` is agnostic in code and single-chain in meaning: its `SELECT` (`:58-70`)
sums `pnl_daily` with no chain predicate, so the moment a multi-chain roster exists it would
silently rank on a cross-chain total. That is the right *default* — a KOL's skill is not
per-chain, and a tab per chain fragments a small roster into several thin ones — but it must
be a decision rather than an accident.

So: **one ranking, consolidated in USD, with a chain filter on top.** USD because it is the
only unit that can add SOL, BNB and ETH without inventing a rate between them.

The part that cannot wait: **`pnl_daily`'s PK is `(kol_id, day)`** (`001:121`) and `chain`
has to enter it *before rows exist*, because a chain cannot be back-derived from an
aggregate. The filter is cheap later; the key is not.

---

## 3. What this implies for the batch order

Tanda 1 is the seam and it is mostly schema — and three of its items (1.1, 1.3, and the
`pnl_daily` key) are **irreversible if they land late**, because each is a key that silently
merges or drops rows once real data exists. Nothing about them requires knowing which
provider or which DEX, so they are safe to build before the research questions close.

The parser and the ingestor do depend on those answers, which is what tanda 2 is for.

---

## 4. Robinhood Chain (4663)

Verified live 2026-08-31 unless marked inferred.

| Fact | Value |
|---|---|
| Chain id | **4663** (`eth_chainId` → `0x1237`), testnet **46630** |
| Stack | Arbitrum Orbit / Nitro, settles to Ethereum, ETH gas, single-operator sequencer |
| RPC | `https://rpc.mainnet.chain.robinhood.com` (responded live) |
| Explorer | `robinhoodchain.blockscout.com` — canonical, the only one the official docs name |
| Block time | **0.101 s/block**, measured over 100k / 1M / 5M-block spans |
| Status | Mainnet live since 2026-07-01, TVL $725M |

### Two premises in the brief were wrong, and both change the design

**4.1 — The nftraffle lesson is the opposite of how it reached me.** I passed on "measure
block time against Blockscout, not third parties". The repository says something else, and
says it in capitals: block time is measured **against the RPC**, and Blockscout is ruled out
as a source of truth — *"Verification reads the RPC, with Blockscout as a fallback for logs
only… never as the source of truth for a verdict. Why: **an explorer is a re-indexer**"*
(`nftraffle/docs/superpowers/specs/2026-08-31-multichain-analysis.md:180`). Half the
recollection survives — not third parties — and the half that did not is the half that would
have pointed our ingestion at an explorer.

Reinforced by measurement: Blockscout's API sits behind a Cloudflare interstitial for
non-browser clients, so **RPC is the ingestion path regardless of preference**.

What nftraffle actually measured, and why it mattered there: third parties quote ~250 ms for
Nitro chains; the real figure is 0.101 s, about 2.5× faster. Its note on the discarded first
attempt is worth keeping — *"four seconds of span against one-second timestamp resolution
measures the resolution, not the chain"*. And the direction of danger is inverted from
Solana's: Solana can only lag, whereas a Robinhood chain running **faster** than estimated
is the failure that bites. Also carried over: a real node **prunes** old blocks, so a `null`
at a low height means "too old", not "look higher" — bracket back from the head.

**4.2 — Testnet cannot verify the parser, only the plumbing.** Tanda 2 as briefed is
"ingestion and parse verified with real testnet swaps". Chain 46630 is live and reachable,
but it has **near-zero DEX volume** — there are no real swaps to parse. It verifies
connection, auth, budget accounting and storage; it cannot verify a decoder.

The honest shape: **plumbing on testnet, parsing against mainnet history replayed
read-only.** That costs nothing and risks nothing — reading logs is not writing — and it is
the only way to meet real swaps before the surface opens. There is also no official faucet;
third-party ones exist and are listed, untested (nftraffle hit this same gap and never
closed it).

### Which DEXes, measured rather than guessed

Far from "too early to tell". 24h DEX volume **$1.40B**, 7d $6.40B, 30d $16.5B
(`api.llama.fi/overview/dexs/robinhood-chain`, read 2026-08-31):

    Uniswap V4  $560.4M     Up v3        $51.9M     SushiSwap V3  $3.6M
    Uniswap V3  $543.6M     Arcus Spot   $19.8M     Ekubo         $3.2M
    Uniswap V2   $87.4M                             0x            $1.7M

**Uniswap is ~85% of 24h volume.** Decode V4 and V3 first, V2 third, and stop. Curve and
PancakeSwap are deployed and effectively dead — hundreds of dollars a day.

Event decoding is stock: the V4 PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`
(listed on Uniswap's own deployments page for chain 4663) emits the canonical v4 `Swap`
topic0, 1,520 of them in a 200-block sample.

### The trap, and the design rule it forces

The chain's UniversalRouter `0x8876789976dEcBfCbBbe364623C63652db8C0904` is a
**Robinhood-modified fork** — its v4 swap struct carries an extra `minHopPriceX36`, so stock
Uniswap SDK calldata reverts, and two look-alike routers exist on the chain. That affects
**calldata, not events**.

So the rule: **attribute swaps at the pool level from `Swap` logs, never by router
allowlist.** In the sample that router was only ~14% of v4 swap senders and the largest
sender was unidentified — a router allowlist would have silently dropped 86% of the volume,
which is the same failure shape as §1.1: a drop that leaves no evidence.

That inference is mine, not measured; the router fork and the address are documented, the
14% is from one 200-block sample.

### What this does to ingestion volume

0.101 s/block is roughly **ten blocks a second, 850k blocks a day**. Any design that walks
blocks is not viable on a throttled GitHub cron. Ingestion has to be either pushed to us, or
pulled as `eth_getLogs` **filtered by address over a block range** — never block-by-block.
That constraint lands on the provider question in §5.

---

## 5. Ingestion provider

**Alchemy for all three chains** — one Address Activity webhook per chain, plus a
cursor-based `eth_getLogs` reconciliation sweep. Robinhood Chain's first-party RPC is the
free backstop. All verified 2026-08-31.

### Why push, and why a sweep anyway

Alchemy pushes, so the cron's 46–337 minute gaps are irrelevant to the live path — the same
shape as Helius today, into the same encrypted-store-then-parse pipeline.

The sweep exists because a gap only loses events if you poll `latest − N`. With a persisted
cursor block it is a wider range, not lost data. Measured: Robinhood's own RPC answered
`eth_getLogs` **genesis to latest** with an address filter in **0.30 s**, no block-range cap,
erroring only past 10,000 *matched* logs. So lateness costs nothing and the sweep is
gap-proof by construction — which is what makes §4's 850k-blocks-a-day survivable.

**The lazier alternative, named as the house posture requires: poll only, no webhooks.** It
fits the free tier easily. It costs push latency and the "live feed" story, which is most of
what this product is.

### The arithmetic

Free tier: **30M compute units/month**, 5 apps, 5 webhooks, all mainnets.

    webhook delivery   0.04 CU/byte  ~1 KB event  =  ~40 CU     30M / 40 = 750k events/month
    eth_getLogs                                   =   75 CU
    200 wallets x 3 chains x 20 trades/day        =  ~120k events/month  ~= 12M CU
    5-min sweep, 3 chains, 25,920 calls           =  1.94M CU/month

Both paths together stay under 15M of 30M. One webhook covers up to 100,000 addresses, so
**payload bytes are the binding constraint, not wallet count** — count CU, not requests, and
port the per-chain env budget and hard client-side cap over unchanged.

The real risk is Address Activity firing on inbound spam airdrops, which are heavy on BNB. If
CU climbs, move BNB to a Custom Webhook GraphQL filter over DEX-pool logs.

### What each provider would learn, against our existing split

Alchemy learns the full watchlist of addresses, our receiver URL and our IP — **no handles,
no names**. That is the slot Helius already occupies, so it does not cross the third-party
split SECURITY.md describes. Deliveries carry an HMAC `X-Alchemy-Signature`; verify it at the
boundary exactly as the Helius secret is verified today. No key, no signing, no wallet
anywhere in this.

Robinhood's own RPC learns which addresses we query. They run the chain and see the activity
regardless — but our *query pattern* reveals the watchlist, which is a different disclosure
and worth stating.

### Rejected, with the reason

- **QuickNode — disqualified, and worth saying loudly.** Its "free" tier is a **30-day
  trial**, after which the account is deactivated and *"all services will be disabled,
  including RPC endpoints, Streams, Alerts, Webhooks"*. That is a paid-plan requirement on
  day 31, against a hard constraint.
- **Blockscout** — pull-only, and bot-gated: default `curl` UA gets **403**, a browser UA
  gets 200, and `/api/eth-rpc` returned **429** under light load. Pretending to be a browser
  to reach an ingest dependency is not a foundation. It stays valuable as an independent
  human-readable cross-check and as the self-host escape hatch if terms change — running it
  needs an archive node, so not now.
- **Ankr** — no push, and no evidence of 4663 support.

**No free public RPC fallback exists on BNB**: the public dataseeds refuse `eth_getLogs`
outright, `-32005 limit exceeded` even on a 12-block range. Robinhood's works and showed no
rate limiting over 25 rapid calls, though it is state-pruned — logs are fully indexed, which
is all we need.

### Reorgs

Alchemy's payload carries a **`removed` boolean** for a transaction no longer on the
canonical chain, which is most of the problem solved for free. We build: an idempotent upsert
keyed on `(chainId, txHash, logIndex)` — which is §1.1's key by another name — honour
`removed`, and carry a `finalized` flag from the `finalized` block tag.

Measured finality lag:

    BSC        finalized trails latest by      5 blocks  (~3.3 s)
    Robinhood  finalized trails by        10,418 blocks  (~17.6 min)   L1 settlement, not reorg risk
    Ethereum   genuine 1-2 block reorg window, ~13 min to finality

Robinhood's lag is Arbitrum Nitro settling to L1, not reordering risk: the sequencer gives
soft finality with no reordering absent operator misbehaviour. So **display on soft finality
and mark hard-final later** — otherwise the feed is 18 minutes stale on the chain we activate
first.

**One thing left unverified**: what Alchemy actually does at the 30M CU ceiling on free. The
docs cover throughput 429s, not monthly exhaustion. Our own client-side cap fires first by
design, so this is a documentation gap rather than an operational one — but it does not get
written into a brief as "it throttles" until someone has seen it.

---

## 6. Batch plan

**Tanda 1 — the seam.** Schema and signing, no provider dependency, so it can start now:
`chain` into `raw_tx`'s key, `trade`'s unique index, `token`'s PK, both PnL keys, and
`kol_wallet`; address canonicalisation before `blindIndex`; `DECIMALS` 18 → 27; the no-doxx
guard widened to `0x`-anchored hex; `native_price(chain, minute, usd)`; and the onboarding
modal with SIWS **and** SIWE, chain badge per wallet, per-wallet `is_public`.

Three of those keys are **irreversible if they land late** — each silently merges or drops
rows once real data exists, and the evidence of the loss is the row that was not written.

**Tanda 2 — one EVM adapter, three configs.** Alchemy webhook + sweep, pool-level `Swap`
decoding for Uniswap V4/V3/V2, native price per chain on the existing per-minute rule.
Plumbing verified on testnet; **parsing verified against mainnet history replayed
read-only**, because testnet has no swaps to parse (§4.2). Each chain stays behind an env
flag and its public surface stays closed until its ingestion carries real data.

**Activation order: Robinhood → BNB → Ethereum**, as briefed. Robinhood first is well
supported by the research: it is the one with a first-party free RPC that answers
`eth_getLogs` without a range cap, and its DEX volume is concentrated enough that two
decoders cover 85%.

---

## 7. What I need from you, in unblocking order

1. **Alchemy account + one API key**, with apps for Robinhood Chain (4663), BNB (56) and
   Ethereum (1). Blocks all of tanda 2. Free tier suffices per §5.
2. **The webhook signing secret** Alchemy issues per webhook, one per chain — the analogue of
   `HELIUS_WEBHOOK_SECRET`, and the thing that makes the ingest endpoint refusable.
3. **A decision on the ranking** (§2): consolidated USD with a chain filter is applied; say
   if you want a tab per chain instead. It changes `pnl_daily`'s key, so it is cheap now and
   expensive after rows exist.
4. **Testnet funds** for chain 46630 if you want plumbing verified on testnet rather than
   against mainnet reads. There is no official faucet; third-party ones are listed in §4.2
   and untested. Not a blocker — the read-only mainnet replay covers more.
5. Nothing else. No private key, no signing key, no wallet is needed by any part of this.

## Las direcciones de Robinhood Chain, una por fila — 2026-09-04

Sondeadas contra la cadena por RPC (`eth_chainId` devolvió `0x1237` = **4663**, que confirma el
id que `chain.ts` declara). Lo probado y lo no probado van separados a propósito: una fila que
diga qué es un contrato sin fuente verificada es exactamente lo que `CLAUDE.md` prohíbe escribir.

| address | qué es | probado por RPC | fuente |
|---|---|---|---|
| `0x8366a39cc670b4001a1121b8f6a443a643e40951` | Uniswap V4 **PoolManager** | 24.009 bytes de bytecode; responde `owner()`; saldo 12.086 ETH; nonce 1 | **pendiente de explorador.** El nombre viene del comentario en `hygiene.ts`, no de una verificación |
| `0x8876789976dEcBfCbBbe364623C63652db8C0904` | **UniversalRouter** (fork de Robinhood) | 24.546 bytes; **responde `poolManager()`**, que lo ata al de arriba; saldo 0; nonce 1 | **pendiente de explorador**, pero el `poolManager()` es evidencia real de la relación |

**Las tres "direcciones" de smartmoney no son direcciones.** Son hashes de topic de evento, de
32 bytes:

| valor completo (64 hex) | qué es |
|---|---|
| `0xec36bf57…cbfc455` | `CURVE_BUY`, topic de evento (`smartmoney/src/robinhood/rpc.ts:11`) |
| `0x8113d738…151f59df` | `CURVE_SELL`, topic de evento (`rpc.ts:12`) |
| `0x8d4aad49…` | `TOKEN_LAUNCHED`, topic de evento (`rpc.ts:13`) |

Los tres devuelven **0 bytes de bytecode, saldo 0 y nonce 0** en la cadena: no son cuentas.

**Cómo se produjo el error, porque importa más que el error.** `docs/round-robinhood.md` §2 dice
*"tres direcciones, ninguna en la allowlist, y copiar ese módulo rompe la suite en el import"*.
Eso salió de un `grep -o "0x[a-fA-F0-9]\{40\}"` sobre el repo ajeno, que matcheó los **primeros 40
caracteres de un hash de 64** y los presentó como direcciones. El sondeo por RPC lo deshizo en un
comando: un contrato tiene bytecode, un topic no.

**El guardián nunca tuvo ese defecto.** `EVM_IDENTIFIER` exige el prefijo `0x`, longitudes
**exactas** de 40 o 64 y frontera a la derecha, así que ve un topic como un identificador de 64 y
no como una address de 40 seguida de basura. Comprobado: marca los dos topics como identificadores
de 64 caracteres, **ninguno** como address, y no marca los dos contratos allowlisteados.

**Lo que eso cambia para la tanda (3).** El bloqueo que la ronda describía —"cinco direcciones que
establecer antes de poder copiar"— no existe: son **dos** contratos, ya allowlisteados, más tres
constantes de evento. Pero los topics **sí** los marca la rama de 64, así que copiar ese módulo
necesita allowlistearlos **como topics de evento y no como contratos** — una lista distinta, con
su propio comentario, porque un topic público y una address de wallet no son la misma clase de
cosa aunque compartan la forma.

**Lo que sigue pendiente y no se escribe como cierto:** qué son exactamente los dos contratos según
un explorador de Robinhood Chain o la documentación de PONS. El `poolManager()` del segundo es
evidencia fuerte de que el par es PoolManager + router de Uniswap V4, y no es una verificación.

---

## El agregador dominante de Robinhood Chain (2026-09-04, desde arrival)

**`0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc`** — un **agregador de swaps de terceros**, activo
desde el **2026-07-03**, con **≥761 usuarios distintos en 7 días** y una tarifa fija de
**0,014444444444444444 ETH por operación**.

Su método dominante es `0x4d819a2a` =
`swap((uint8,address,address,address,uint24,int24,address,bytes,address,bytes32)[],address,uint256,uint256,uint256)`
— rutas multi-salto con PoolKey estilo Uniswap v4. **No se le pudo poner nombre comercial**: 752
bytes de bytecode, sin `name()`, y no se consultó el explorador de Robinhood por D2.

### Por qué importa acá

**Todo lo que pasa por ese router se parece entre sí.** Tipo de transacción, priority fee, gas limit
y selector son del programa, no de quien opera. Cualquier análisis de comportamiento —«estas dos
wallets se configuran igual, deben ser la misma persona»— **está confundido si los sujetos usan el
mismo agregador**, y en esta cadena eso es lo más probable.

**La regla que sale de esto:** cuando dos sujetos comparten herramienta, el control son **los otros
usuarios de esa herramienta**, no wallets al azar. Medido en un caso real: contra wallets al azar,
dos grupos compartían 3 de 5 parámetros de firma; contra usuarios del mismo router, **0 de 5**.

### Y una advertencia para cualquier indexación de PONS

En la ingesta de arrival, **el 37,4% de las operaciones quedaron atribuidas al router** y no a sus
usuarios: es la «wallet» número uno del leaderboard por un factor de cuatro, y son cientos de
personas en una fila. Quien indexe PONS por eventos de curva **tiene que decodificar el `recipient`
del swap** o va a construir un ranking con un primer puesto que no existe.


---

## Allowlist de identificadores públicos — canónica

**Esta sección es la fuente.** `src/lib/hygiene.ts` mantiene las mismas listas en
código y `hygiene-allowlist.test.ts` compara las dos **en ambas direcciones**, así
que ninguna mitad puede derivar sin romper la suite.

**Por qué el código no lee este archivo en tiempo de ejecución**, que era lo
primero que se intentó: `src/app/api/admin/kol/route.ts` importa el guardián, y
Next empaqueta siguiendo imports, no rutas de archivo — `docs/multichain.md` no
viaja al despliegue, así que un `readFileSync` acá funcionaría en local y fallaría
en producción. Es el mismo patrón que ya usa `wallet-proof-store.test.ts` contra el
`CHECK` de Postgres: una lista en cada lado y un test que las ata.

**Y por qué la sección está delimitada en vez de leer todo el documento:** este
archivo también lo escanea el guardián. Si cualquier dirección escrita en cualquier
párrafo se permitiera a sí misma, pegar una wallet acá por error dejaría de ser un
error — que es exactamente lo que el guardián existe para atrapar. Solo cuentan las
filas de las dos tablas de abajo.

### Contratos

Direcciones de 40 hex. Un contrato es un identificador público y permanente que
lista cualquier explorador; una wallet no.

<!-- allowlist:contracts -->
| address | qué es |
|---|---|
| `0x8366a39cc670b4001a1121b8f6a443a643e40951` | Uniswap V4 PoolManager, Robinhood Chain 4663 |
| `0x8876789976dEcBfCbBbe364623C63652db8C0904` | UniversalRouter (fork de Robinhood), 4663 |
| `0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc` | Agregador de swaps de terceros, 4663 |
<!-- /allowlist:contracts -->

### Topics de evento

Hashes de 64 hex, **no direcciones**. Van en una lista aparte y con su propio
comentario porque un topic público y una wallet no son la misma clase de cosa
aunque compartan la forma — y porque presentarlos como direcciones ya produjo un
error una vez (§ "Las direcciones de Robinhood Chain").

Los tres primeros se verificaron por RPC el 2026-09-04: **0 bytes de bytecode, saldo 0,
nonce 0**. No son cuentas.

Los valores completos se copiaron de `smartmoney/src/robinhood/rpc.ts:11-14`, que es
donde este mismo documento dice que viven. Un primer intento de esta tabla los
**inventó** a partir de las formas truncadas de arriba (`0xec36bf57…cbfc455`) — en
un documento que afirma verificación por RPC, que es la peor forma posible de estar
equivocado. Se corrigió leyendo la fuente antes de escribir.

<!-- allowlist:topics -->
| topic | qué es |
|---|---|
| `0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455` | CURVE_BUY |
| `0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df` | CURVE_SELL |
| `0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607` | TOKEN_LAUNCHED |
| `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822` | PancakeSwap V2 `Swap`, BNB 56 |
| `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67` | PancakeSwap V3 `Swap`, BNB 56 |
<!-- /allowlist:topics -->


---

## BNB (56): lo medido contra mainnet — 2026-09-05

**La credencial existe y funciona.** Es la misma key de la app `arrival` de
Alchemy que `smartmoney` usa en `ROBINHOOD_RPC_URL`; el endpoint de BNB es el
mismo host con otra red. En este repo vive como `ALCHEMY_BNB_RPC_URL`.

    eth_chainId     -> 0x38  (= 56, BNB mainnet)
    eth_blockNumber -> 120.151.893

**Y no la habíamos encontrado por buscar mal.** Dos veces se reportó "no hay
credencial de Alchemy en esta máquina", buscando la cadena `ALCHEMY` en
`.env.local`, en el entorno y en todos los repos. La key estaba en una variable
llamada `ROBINHOOD_RPC_URL`. Buscar por el nombre del proveedor no encuentra una
credencial guardada con el nombre de su uso; buscar por **la forma del valor**
—un host `*.g.alchemy.com`— sí.

### Los topics, verificados contra historia real

| evento | topic0 | logs / 10 bloques | pools distintos |
|---|---|---|---|
| PancakeSwap **V2** `Swap` | `0xd78ad95f…59d822` | 162 | 109 |
| PancakeSwap **V3** `Swap` | `0xc42079f9…bcca67` | 19 | 14 |

### El techo que decide el diseño

    tiempo de bloque   0,45 s   (medido sobre 100 bloques)
    bloques por día    192.000
    eth_getLogs        MÁXIMO 10 BLOQUES por llamada — plan Free

Ese tope no es una elección nuestra: el endpoint lo devuelve como error y nombra
el rango que sí aceptaría. Con él, **recorrer un día entero cuesta 38.400
llamadas** (19.200 por topic), y a los ~250 ms medidos por llamada son **~2,7
horas de reloj por día**. En un cron cada 15 minutos eso no entra, que es
exactamente lo que §5 anticipaba: *"any design that walks blocks is not viable on
a throttled cron"*.

**Proyección de CU:** 38.400 llamadas/día × el costo publicado de `eth_getLogs`
(75 CU) ≈ **2,88 M CU/día** sólo por caminar bloques de BNB, sobre un techo Free
de ~10 M/día **compartido con la ingesta de Robinhood de `smartmoney`**. El costo
por llamada es el número publicado por Alchemy y **no lo pude verificar desde
acá**; el conteo de llamadas sí está medido.

### Lo que sí es viable, y está probado

`eth_getLogs` **filtra por posición de topic**, y eso cambia el problema:

    sin filtrar, 10 bloques        25 logs
    filtrando topics[2] = wallet    2 logs

`topics[2]` es el `recipient` del swap en V2 y en V3, así que se puede pedir
"swaps cuyo destinatario es esta wallet" en vez de "todos los swaps". Eso es lo
que hace barato un **Custom Webhook con filtro GraphQL** —la salida que §5 ya
proponía— y lo que evita el problema que §4 documenta para PONS: atribuir al
router en vez de a la persona.

**Sigue faltando** el webhook en sí: endpoint público, secreto de firma y alta en
el dashboard de Alchemy, el mismo trío que Helius ya tiene. El flag de BNB en
producción espera a eso, no al parser.

# kolscanhispano.fun — implementation plan, batch 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the numbers true. Batch 1 built an ingestion path, a PnL engine and two screens
that work locally; nothing runs them on a schedule, no trade carries a price, a transaction with
two swaps of one mint collapses into one, and whole classes of swap are declined rather than
valued. This batch closes those, in that order, and adds no new screen.

**Architecture:** Two GitHub Actions workflows run the existing `parsePending` and
`recomputeDirty` directly against Neon from the runner — no HTTP endpoint and no deploy, because
nothing is deployed and the work is pure database work. A Postgres advisory lock, not a table,
keeps a scheduled run and a manual dispatch from racing. Prices come from DexScreener, which the
spec already designates and which costs no Helius credits, with Helius DAS as the fallback for a
mint DexScreener has never seen — that fallback is what makes "no row without a symbol" true.

**Tech Stack:** unchanged from batch 1. No new runtime dependency.

**Spec:** `docs/spec-v1.md`. Design: `DESIGN.md`. Batch 1's ledger, including its 31 triaged
deferrals, is the input to several tasks here.

## How this plan differs from batch 1's, deliberately

Batch 1's plan dictated exact test code. Fourteen of its Critical and Important findings were
defects **in that dictated test code** — tests that were green and could not fail for the reason
they named: a scanner blind to embedded addresses, a version byte whose authentication was never
exercised, a production guard that compared itself, a unique index verified by string match, a
"stores no plaintext" assertion that passed without encryption, a win rate that could not tell a
win from a loss.

So this plan states **the property and what would count as evidence**, and leaves the test to the
implementer, who has the code in front of them. Every task ends by mutating the implementation and
reporting which test died. A mutation that survives is a missing test, not a passing suite.

## Global constraints

- English in code, comments, commit messages and file names. UI copy in neutral Spanish, `es-ES`.
- **No real Solana addresses or transaction signatures in the repository.** Generate them.
- Money is `numeric` in SQL and scaled `BigInt` in TypeScript. **No money through a float.**
- Row ids are application-generated UUIDs.
- Never interpolate an address, signature, key, IP or connection string into a message or log.
- **Green means `npm test` and `npx tsc --noEmit`, both clean.** `npm run test:e2e` must still pass
  for any task touching a page.
- Stage **by path**. Never `git add -A`. Commits carry **no trailers**.
- Migrations are never edited once applied; a change is a new numbered file matching `^\d{3}_`.
- **Nothing is deployed in this batch.** No Vercel project, no DNS, no secrets written by us.

## Task order and why

The user's priority is that the numbers be true before anything else is built. Tasks 1–3 make the
engine run at all; 4–5 make its inputs complete; 6–7 make its coverage honest; 8 measures the
assumption the parser rests on; 9 pays down the two deferrals that bite first.

---

### Task 1 — A Postgres advisory lock

**Files:** `src/lib/lock.ts`, its test.

**Interface:** `withLock<T>(name: string, fn: () => Promise<T>): Promise<T | null>` — returns
`null` without running `fn` when the lock is held elsewhere.

Use `pg_try_advisory_lock` on a hash of `name`, on a dedicated client held for the duration, and
release it in a `finally`. Not a table: the database already offers this, it needs no migration,
and it cannot leak a stale row if a runner is killed — the lock dies with the connection.

**Properties to prove.** A second caller gets `null` while the first holds it, and runs normally
once released. The lock is released when `fn` throws, and the throw still propagates. Killing the
connection releases it. Two different names do not block each other.

**Evidence:** concurrent calls in one test, and a probe that holds the lock from a second client.

---

### Task 2 — The two cron workflows

**Files:** `scripts/parse-pending.ts`, `scripts/recompute-dirty.ts`,
`.github/workflows/parse-pending.yml`, `.github/workflows/recompute-dirty.yml`.

Each script loads `.env.local` (or the runner's environment), takes the lock, runs the existing
function, prints a one-line summary, and exits non-zero on failure. Each workflow runs on a
`schedule` and on `workflow_dispatch`, uses `concurrency` with `cancel-in-progress: false`, checks
out, `npm ci`, and runs its script with the secrets below as `env`.

**Why the runner does the work instead of calling an endpoint:** `outbid-tokens` calls an HTTP
endpoint because its work lives in the app and Vercel Cron cannot send an auth header. Here
nothing is deployed, and both functions are pure database work with no HTTP surface — a runner
with `DATABASE_URL` does it directly, with no endpoint to authenticate and no deploy to depend on.

**Schedules:** parse every 5 minutes, recompute every 15. GitHub's scheduler is best-effort and
runs late under load; both functions are derived from state, so a late run does what a punctual
one would.

**Secrets the workflows read** — the report must list these for the user to add by hand. **Never
write a secret, never invent a value:** `DATABASE_URL`, `WALLET_ENC_KEY`, `WALLET_HMAC_KEY`.

**Properties to prove.** Running a script twice in a row is idempotent. A second run while the
first holds the lock exits cleanly having done nothing, and says so. A parse failure exits
non-zero. No secret is ever echoed — grep your own output.

**Evidence:** the scripts run locally against the test branch; `actionlint` or `yq` parses both
workflows. The workflows themselves cannot be executed from here — say so rather than claiming
they were.

---

### Task 3 — Migration 004: one-off dirty sweep

**Files:** `migrations/004_dirty_sweep.sql`.

`UPDATE position SET dirty = TRUE`. That is the whole migration.

**Why it is needed:** batch 1's fee correction changed `applyTrade`, but `replayPosition` sets
`dirty = FALSE` when it finishes, so every position already replayed is clean and no cron will
ever revisit it. Their `realized_sol` overstates by their trades' fees and their `wins`/`losses`
can be inverted. Adding the cron alone does not fix them.

**Properties to prove.** Applying it marks every existing position dirty; it is idempotent;
running the recompute afterwards produces the fee-corrected figures. Apply to both branches.

---

### Task 4 — Prices and token metadata

**Files:** `src/lib/prices.ts`, its test, `src/lib/fixtures/dexscreener.ts`.

**Source decision, and the reasoning, because the user asked for Helius first.** Spec §5.7 already
designates DexScreener for token metadata and prices and forbids Helius for them, for a reason
that still holds: the Helius free tier is 1M credits and DAS costs 10 credits per request, so
pricing SOL once a minute would spend 43 % of the month's budget on one number. DexScreener is
free, needs no key, batches up to 30 mints per call, and is already in the spec — it is not a new
service. **Helius DAS is the fallback**, and it is where "Helius first" earns its place: a mint
with no DexScreener pair has no symbol there, and `getAsset` gives one for 10 credits, rarely.

- `solUsdAt(minute)` — reads `sol_price`; a writer fetches the SOL/USDC pair and upserts a row.
- `tokenMetadata(mints[])` — batches to DexScreener, upserts `token` with symbol, name, decimals,
  image, price, liquidity and a `price_state` per §4.6; falls back to Helius DAS for a mint
  DexScreener does not know, and marks it `unpriced` rather than inventing a price.

**Properties to prove.** A mint with a pair gets a symbol and a price. A mint with no pair gets a
symbol from the fallback and `price_state = 'unpriced'` — **never a price**. A mint neither source
knows is still not rendered without a symbol: decide what it shows and make it explicit. Batching
respects the 30-mint limit. A network failure leaves the previous cached row rather than blanking
it. Nothing here writes a price it did not receive.

**Evidence:** fixtures for both sources; one live call against DexScreener is acceptable and should
be reported, since it needs no key.

---

### Task 5 — Value every new trade, and backfill the old ones

**Files:** `src/lib/parse-swap.ts` (valuation call site), `scripts/backfill-prices.ts`.

At parse time, resolve `sol_usd` for the trade's minute and write `usd_amount` and `price_usd`.
`usd_amount` stays NULL **only when there is genuinely no rate** — that is the honest case §4.6
names, and it must remain distinguishable from a rate we simply never fetched.

The backfill walks existing trades with a NULL `usd_amount`, fetches the rates for their minutes,
fills them, and marks the affected positions dirty so the recompute picks them up.

**Properties to prove.** A trade parsed while a rate exists carries USD. A trade parsed with no
rate carries NULL and is not silently zeroed. The backfill is idempotent and re-runnable, and it
marks positions dirty. Feed rows show a symbol; a token with no price shows `sin precio` from
DESIGN.md, never a dash and never −100 %.

---

### Task 6 — Real `instructionIndex`

**Files:** `src/lib/parse-swap.ts`, `src/lib/fixtures/swap.ts`, tests.

Today `instructionIndex` is hardcoded `0` while the unique key is
`(signature_hmac, instruction_index, wallet_id)`, so **two swaps of the same mint by one wallet in
one transaction net into a single trade** — a wrong number, not a refusal. Two swaps of different
mints already refuse as `unsupported_quote`.

**Do the fixture first and prove it red.** Build a payload with one wallet swapping one mint
twice, run it against the current parser, and record what it produces before changing anything.
That recording is the finding; the fix follows it.

**Properties to prove.** Two same-mint swaps in one transaction become two trades with distinct
instruction indices and correct individual amounts. One swap still becomes one trade with the same
index it has today, so no existing row changes identity. Re-parsing is idempotent.

**Open question this may surface:** whether the Helius enhanced payload exposes per-instruction
detail at all. If it does not, say so and stop — a derived index that is not the real one is worse
than the honest `0`, and the answer changes the design rather than the code.

---

### Task 7 — Stablecoin and token↔token quotes

**Files:** `src/lib/parse-swap.ts`, tests.

Spec §4.3 already says how: a stablecoin-quoted swap normalises to SOL at the block's rate; a
token↔token swap closes leg A and opens leg B at the implied SOL value. Both currently land as
`unsupported_quote`.

**The rule that governs this task:** if a leg cannot be valued **with certainty**, it stays
`unsupported_quote` **with a reason**. Never a guessed number. Batch 1 spent ten rounds removing
fabricated cost bases; this task must not reintroduce one under a different name.

**Properties to prove.** A USDC-quoted buy produces the same SOL-denominated trade a SOL-quoted
one of equal value would. A token↔token swap where both sides are priceable produces a close and
an open that conserve value. A swap where either side is unpriceable stays declined, with a reason
distinct from the others. Every existing parser property from batch 1 still holds — re-probe them,
do not assume.

---

### Task 8 — Shadow measurement of `userAccount: ""`

**Files:** `scripts/measure-user-account.ts`, a written finding in the report.

Nine review rounds in batch 1 rest on the premise that Helius emits `userAccount: ""` rarely. The
premise is asserted nowhere, and the blunt rule built on it — an unattributable non-zero balance
change makes the row malformed — refuses real traffic if the shape is common.

Measure two numbers over at least a few hundred real enhanced SWAP payloads: the fraction of
deliveries carrying a non-zero balance change with an empty or unreadable `userAccount`, and the
`malformed_payload` rate the current parser would produce on them. Report against the thresholds
already recorded: **2 % and 10 %**.

**Measure only. Do not change the parser on the strength of this** — bring the number back.

**This task needs a `HELIUS_API_KEY` and there is none.** If it is absent, this is a blocked task:
say so, skip it, and continue. Do not substitute synthetic payloads and call the result a
measurement — the entire point is that synthetic payloads are what created the doubt.

---

### Task 9 — The two deferrals that bite first

**Files:** `src/lib/rate-limit.ts`, its test, `scripts/prune-rate-limit.ts` or a cron step.

**An injectable clock.** The rate-limit tests were flaky because four sequential Neon round trips
can straddle a fixed window boundary; batch 1 widened the window from 60 s to 3600 s, which shrank
the flake window about sixty-fold without removing it. Make the clock a parameter with a default,
and pin the boundary behaviour deterministically — including the case the widening papered over: a
call landing exactly on a boundary.

**Pruning.** `rate_limit` is the only unbounded table with no cron, and the webhook writes to it on
every unauthenticated hit. Delete rows older than a few windows, from one of the existing
workflows rather than a third.

**Of the remaining 22 deferrals in batch 1's ledger, take only what fits without growing the
batch.** Name what you took and what you left. Leaving them all is an acceptable answer.

---

## Out of scope, by instruction

`/registro` and SIWS, the admin, cabals, the token page, the KOL page, the legal pages, and any
deploy — no Vercel project, no DNS, no secrets written by us.

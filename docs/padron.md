# The roster: admin creation, `/registro`, and the backfill

The round `CLAUDE.md` requires before a model change, written before the code. Three
decisions here change what a row means, and one of them was decided by a measurement that
contradicted the obvious design.

---

## 1. The measurement that settled the tweet check

Spec §6 verifies a handle with *"a tweet with a one-time code"*. How that tweet is read was
never written down, and the obvious answer is wrong.

**Measured 2026-09-01, from this machine, unauthenticated:**

    curl -s https://x.com/jack/status/20            -> 200, 164,338 bytes
    grep -c 'just setting up my twttr'              -> 0
    grep -oE '<meta[^>]*og:(description|title)'     -> (nothing)

x.com serves an application shell. The tweet text is not in it, and neither are the
`og:` tags that used to make this trivial. **A direct fetch of the tweet URL cannot verify
anything**, and a check built on one would either always fail or — worse — be written to
"pass when the fetch succeeds", which is a check that approves everybody.

    curl -s https://api.fxtwitter.com/jack/status/20 -> 200, the text and the author

That works, and it is the wrong answer. A third-party mirror asked *"who wrote this tweet"*
becomes the root of trust for who owns a handle: if it is compromised, misconfigured, or
simply replaced by its operator, anyone can claim anyone. Identity is exactly the question
not to outsource.

    curl -sL 'https://publish.twitter.com/oembed?url=…&omit_script=1'
    -> 200 {"author_name":"jack","author_url":"https://x.com/jack",
            "html":"…<p …>just setting up my twttr</p>&mdash; jack (@jack) …"}

**`publish.twitter.com/oembed` is X's own endpoint, needs no credentials, and returns both
the author and the text.** It is first-party, so it is the one source whose answer about a
tweet is not a third party's opinion. No X API key exists in this environment (checked), and
this needs none.

**The handle comes from `author_url`, never from `author_name`.** `author_name` is the
*display name*: it is user-settable, not unique, and two accounts can share one. `author_url`
is `https://x.com/<handle>`, and the handle is the thing `kol.x_handle` is unique on. A check
that compared display names would accept an impostor who set their display name to their
target's — which is the single easiest attack on this flow and costs nothing to mount.

**Failure is refusal, never acceptance.** A protected account, a deleted tweet, a rate limit
and a network error all produce "not verified". The one bug this check can have is being
written so that an unreachable oEmbed means "fine".

---

## 2. Registration writes to `kol` and `kol_wallet`, not to `claim` tables

Spec §6.1 routes registration through `claim` and `claim_wallet`, promoted to `kol` and
`kol_wallet` on approval, with *"uniqueness checked across both tables, so a second pending
claim cannot proof an address that is already spoken for."*

**This builds the pending KOL directly in `kol` with `status = 'pending'`.** The argument
for the deviation, and the argument against it:

**For.** Uniqueness across two tables is a check somebody writes and can forget; uniqueness
in `kol_wallet` is `UNIQUE (chain, address_hmac)`, which the database enforces on every
insert and which this batch already relies on. Two tables holding the same shape of row,
with the same encryption and the same blind index, is the `key_version` mistake in a
different costume: two sources of truth for one fact, and the one that is easier to read is
the one that drifts. And `kol.status` already has `pending` in its `CHECK` — the state
exists, it simply had nothing writing it.

**Against, and it is real.** A pending KOL's wallets are in the same table the ingestion
reads, so a pending registration starts being indexed before anyone approved it. That is
the argument the claim tables win: `claim_wallet` cannot be indexed by accident because
nothing reads it.

**Why it is answered rather than fatal.** Indexing a pending KOL's wallet writes trades that
no public surface shows — `status = 'approved'` gates the feed, the ranking and the detail,
and `address-invariant.test.ts` proves a pending KOL with a *published* wallet reaches no
surface at all. The cost is storage and Helius credits for a roster that may be rejected;
the benefit is that an approved KOL has history from the moment they are approved instead of
waiting for a backfill. The exposure the claim tables actually prevent — squatting an
address someone else would have registered — is identical either way, because the spec
checks uniqueness across both tables precisely so that a pending claim *does* reserve the
address.

**Recorded as a deviation from spec §6.1**, not as an oversight. If the owner wants the
claim tables, the migration is additive and this flow moves behind them.

---

## 3. The backfill re-parses rows that already succeeded

There are **4,631 `raw_tx` rows in production, 4,503 of them parsed with `parse_error IS
NULL` and 0 trades** (measured 2026-09-01). They did not fail. They succeeded at deciding
that the wallet was not one of ours — because the roster was empty.

So the backfill is not the requeue the roadmap describes. `roadmap.md` §1 is about clearing
`parse_error` on rows that were *refused*; this clears `parsed_at` on rows that were
*accepted and found nothing*. The two are different states and want different words.

**It is safe because the write is idempotent, and that is a property of existing code rather
than a hope.** `insertTrade` is `ON CONFLICT (chain, signature_hmac, instruction_index,
wallet_id) DO NOTHING`, so re-parsing a row that already produced a trade produces no second
one. A row that produced nothing and still matches nothing simply gets marked parsed again.

**Bounded, and bounded by a number the caller passes.** A sweep that resets every row in one
statement and then hands 4,503 rows to the next cron tick is a five-minute job in a workflow
budgeted for six. The script takes a limit, reports what it moved, and is re-runnable — so
the operator decides how much to reprocess and can watch the first batch before committing
to the rest.

**What it must not do:** touch rows with a `parse_error`. Those are the roadmap's problem
and mixing the two would make one script that nobody can reason about.

### The premise this rests on failed the first time it was tested, 2026-09-02

The requeue's whole argument is *"every wallet added to the roster makes some of them
attributable"*. On 2026-09-02 the first three wallets were added — the three tracker
crossings of `docs/padron-candidatos.md`, created `pending` with their provenance and then
approved — and the argument did not hold. Measured, in this order:

- 25 rows requeued, 75 parsed (the 25 plus the 50 already queued), `parse_error` 0, **trades
  0**.
- Every stored payload then scanned rather than sampled: **5,128 of 5,128 readable, 99,817
  distinct base58 addresses in them, and not one of the three roster wallets in any.** The
  scan is deliberately coarser than the parser's own `candidateAddresses` — every base58 run
  in the payload, not just the accounts it would consider — so a wallet the parser *would*
  have matched cannot be missing from it.
- `GET https://api.helius.xyz/v0/webhooks` with this environment's `HELIUS_API_KEY`: `200`
  and `[]`. **This key owns no webhook**, while `raw_tx.source` is `webhook` for all 5,128
  rows and the newest arrived while the query was running.

So the ingestion is alive, healthy and watching **somebody else's addresses**, through a
webhook registered under a key this environment does not hold. Two consequences, and neither
is a code defect:

1. **Requeueing the remaining backlog would attribute nothing.** It is ~5,000 payloads of
   decrypt-and-parse against transactions that provably do not touch the roster. The limit
   that corresponds is none.
2. **New transactions of the three approved KOLs will not arrive either**, because nothing
   has told that webhook to watch their wallets. Spec §327 puts `accountAddresses` = every
   active wallet of every approved KOL and tracks it in
   `setting['helius_webhook_address_hash']`; that sync is **unbuilt** — no code references
   that key, and the row does not exist in production.

**Built the same day.** `src/lib/helius-webhook.ts` is spec §5.4's single path, and
`POST /api/admin/kol` and the approve route both call it. A **new** webhook was registered
under this environment's key rather than trying to take over the other one, because the
other one cannot be reached from here:

    b5739db9-5039-49e8-aae6-4d69f467b4ba
    https://kolscanhispano.fun/api/webhooks/helius — enhanced, ["SWAP"], authHeader set
    3 addresses, all 3 on the roster, 0 roster wallets unwatched (verified 2026-09-02)

Both webhooks now deliver to the same endpoint, and that is harmless: `storeRawTxBatch` is
keyed on the signature, so a transaction delivered twice is one row. The foreign one's rows
keep being discarded exactly as before — no wallet of ours appears in them.

**Two things the first run taught, and both are in the code:**

- **`GET /v0/webhooks` summarises.** It listed the new webhook with no `accountAddresses` at
  all while `GET /v0/webhooks/<id>` showed three. Anything checking this webhook has to ask
  for the object, never read the list.
- **A `200` is Helius accepting a request, not Helius holding the set.** The sync now reads
  the webhook back after every write and refuses to store the hash unless the count agrees.
  It costs one extra call per *change* — never per approval, since an unchanged set makes no
  call at all — and without it a silently partial write would leave a hash saying "in sync"
  forever, which is the same shape as the defect this whole module was built to fix.

The repair path was then exercised against the real API rather than only against a fake: the
stored hash was falsified by hand in production, the sync noticed, edited the existing
webhook (it did not create a second), read back three addresses and restored the hash. A
following run made no call at all.

### It worked, and the first trade is dated

The webhook was registered at **16:05:28Z**. The first transaction it delivered that
attributed to a KOL on this roster has a block time of **16:06:29Z** — sixty-one seconds
later. By 17:53Z: **17 trades**, `@k4yeSol` 9 and `@Stigman__` 8, seven positions, and the
public ranking showing all three approved KOLs — the two who traded and `@mambatrades_` at
zero, which is spec §2's roster and the reason an inactive approved KOL stays in the list.

**What the delay is made of, because it is not the webhook.** A trade becomes a row on the
ranking through three hops: the delivery, the parse cron, and the recompute cron. The parse
is scheduled `*/5` and **GitHub actually ran it at 13:36, 09:04, 04:37 and 00:09** that day —
roughly every three hours, which is the throttling `DEFAULT_BUDGET_MS`'s comment already
budgets for. So the honest expectation for a fresh trade is *hours, not minutes*, and the
17 above were attributed in one run that cleared a queue of 102.

That queue is the thing to watch. Ingest measured 2026-08-31 was ~19 rows an hour; on
2026-09-02 it ran 30–60, because the foreign webhook is delivering into the same endpoint.
At four runs a day of ~200 rows the margin is thin, and **deleting the foreign webhook
roughly halves the arrivals** — which is the second reason to do it, after the first one
being that nobody here can manage it.

---

## 4. What the admin route is, and what it is not

Spec §9 gives the admin an approval queue, KOL editing, cabals, withdrawal, suspension,
health. **This batch builds one mutation and one gate:** create an approved KOL with its
wallets, and approve a pending one. Everything else in §9 stays unbuilt and is not pretended
at.

- `ADMIN_TOKEN`, compared in constant time, and **absent means refused** — never "no token
  configured, so allow".
- Every mutation into `audit_log` with actor, before, after and `ip_hash`, which §9 states
  as a property rather than a habit.
- Only chains with live ingestion, for the reason `activeChains` already documents: a wallet
  on a chain nothing reads is a control that does not work.
- A duplicate address is refused **by blind index**, and the refusal says only that the
  address is taken — never by whom, which would be a lookup oracle over the roster.
- **A `pending` create must say where it came from.** `status: "pending"` stages a candidate
  the admin has *not* vouched for — a wallet a public tracker printed beside a handle — so
  the route requires a `provenance` line (the source URL and the date it was read,
  `docs/padron-candidatos.md` §1's standard B) and puts it in `audit_log`. An `approved`
  create needs none: the admin is the provenance, and the audit row names them. The field is
  scanned with `hygiene.ts`'s address scanners before it is stored, because `after` is JSONB
  and this is the first field a caller can write free text into.

---

## 5. The negative tests, before the code

| # | What is presented | Must |
|---|---|---|
| 1 | Admin route with no token, a wrong token, an empty token | refuse `401`, and never on a timing difference |
| 2 | A wallet address of the wrong shape for its chain | refuse, naming the chain and never the address |
| 3 | A wallet on a chain with no live ingestion | refuse |
| 4 | An address already held by **another** KOL | refuse, without naming the holder |
| 5 | The same address twice in one request | refuse |
| 6 | A handle already taken | refuse |
| 7 | A successful creation | leave exactly one `audit_log` row, carrying no address |
| 8 | Nonce reuse, wrong chain, wrong domain, another wallet's signature | refuse — the cases `wallet-proof.md` already names, now over HTTP |
| 9 | A tweet whose **author handle** differs from the claimed one | refuse, even when the code matches |
| 10 | A tweet that does not contain the code | refuse |
| 11 | oEmbed unreachable, 404, or a protected account | refuse — never "could not check, so fine" |
| 12 | A registration | leaves the KOL `pending` and on no public surface |
| 13 | Any refusal, on every route | carries no address, no signature, no nonce, no token |
| 14 | Every route | rate-limited, and the limiter is reached before the work |

The mutation that matters for §1: make the oEmbed check compare `author_name` instead of
`author_url` and confirm **test 9b** dies. A check that compares display names is the one
this document exists to prevent.

It says 9b and not 9 because the mutation was run and 9 survived it. Case 9 submits a link
whose *path* is somebody else's, which the URL check refuses before a request is spent — so
it never reaches the comparison at all. The case that reaches it is the one where the path
says the right handle and X says a different one, which is also the realistic attack: a path
is whatever the caller typed, and an impostor submits
`x.com/<target>/status/<their own tweet id>`.

---

## 6. What `/registro` connects, and what it will connect

The page discovers wallets over the **Wallet Standard** handshake (`src/lib/wallet-standard.ts`)
and shows the ones that declare a Solana chain, `standard:connect` and `solana:signMessage`.
It names no wallet, and a test reads the module's own source to keep it that way.

**One wallet connects straight through; two or more open the chooser.** A chooser with a
single row asks a question with one answer, which `DESIGN.md`'s last Don't calls a control
that does not work. Both branches have an e2e case.

### Rabby, and every other EVM-only wallet

Absent, and not by a list. `rabby.io`, read 2026-09-02, publishes 63 chains — all EVM — and
titles itself *"Your Go-to Wallet for Ethereum and EVM"*. It registers no Solana chain, so no
Solana chooser can show it. `e2e/registro-wallets.spec.ts` registers an EVM-only wallet
alongside Solana ones and asserts it does not appear, which is that rule exercised rather
than described.

### The EVM half, when a chain opens

**Not before.** `activeChains()` already holds that a wallet on a chain nothing indexes is a
control that does not work; an EVM wallet connected today would produce a row no ingestion
reads. The day one opens, `/registro` gains an EVM connection and Rabby appears on its own —
again without anything naming it.

The shape is decided, and it is `nftraffle`'s, which already runs it:

| Piece | How |
|---|---|
| Discovery | **EIP-6963**: listen for `eip6963:announceProvider` **before** dispatching `eip6963:requestProvider`, which is what avoids missing a wallet that announced during the render that attached the listener |
| Proof | **`personal_sign`** over the text `wallet-proof.ts` already builds, with the chain inside the signed payload rather than taken from whatever network the wallet is on |
| Structure | Pure logic apart from `window` — `nftraffle` splits `lib/wallet/evm-discovery.ts` and `lib/wallet/evm-binding.ts`, both tested in Node, against one file that touches the browser. `wallet-standard.ts` is already written that way |

**What does not come across.** `nftraffle` asks a wallet for three things and the third is
payment. That third one is forbidden here — `no-money-path.test.ts` refuses it, and that scan
is what makes "this page cannot move funds" a property of the repository rather than a claim
in a comment. Take the discovery and the signature; leave the send.

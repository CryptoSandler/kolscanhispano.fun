# Candidate roster: Spanish-speaking KOLs

A working list for the owner to strike through and confirm.

**Three rows are registered, 2026-09-02**, on the owner's instruction: the three that cross
the tracker were created `pending` through `POST /api/admin/kol` with their provenance, then
approved through `POST /api/admin/kol/<id>/approve`. Every other row in this file has still
touched nothing — no `kol`, no `kol_wallet`, no admin call — and the alta of any of them
happens only after the owner confirms.

---

## 1. Where a wallet is allowed to come from

Two provenance standards exist, they are not the same thing, and a row says which one it
rests on.

**A — the KOL published it themselves on X.** Provenance is the post URL and its date. This
is what `/registro` produces, over the person's own signature, and it is the stronger of the
two: a signature over `solana:mainnet` cannot be forged, where a post can be deleted.

**B — a public tracker publishes the wallet already labelled with that X handle.**
Provenance is **the tracker URL where the pair appears, plus the date it was read**. The
claim being recorded is *"this tracker says this wallet is this handle"*, which is a third
party's attribution and not the person's own statement. Rows sourced this way are marked
`tracker` so the difference stays visible when the owner reviews them.

**Never C.** A wallet and a handle are never joined by anything this repository worked out
for itself — not from a trade, not from a nickname that resembles a handle, not from
timing. If the pair is not printed by the source, the row has no wallet and is `solo handle`.

**No real names.** The handle is the identity, per the no-doxx rule in `CLAUDE.md`. That
applies to this file's prose as well as to its table.

**Ordered by followers**, descending, measured rather than remembered.

### The wallet cannot be written into this file, and that is not an oversight

`src/lib/hygiene.ts` fails the suite on any base58 run of 32 characters or more anywhere in
the repository, tracked or not — which is every Solana address. So the candidate table
carries the **tracker URL** where the pair is published and never the address itself. The
address travels from that URL into `POST /api/admin/kol` by hand, and never through a file.
This is the same rule that stops an address reaching a public surface, applied to the
repository.

---

## 2. The list

Alphabetical, and without a follower column: reading followers costs a paid profile fetch per
handle, and the owner strikes rows by who the person is rather than by a number this file
would have to keep fresh.

Seeded by the owner, one lot at a time. Existence is X's own oEmbed; the cross is against
every row of the Solana Tracker KOL leaderboard that carried `identity.twitter`
(`https://data.solanatracker.io/v2/pnl/leaderboard/kols`, 621 rows over 7 requests, 507 with a
handle, read 2026-09-01). **Zero Firecrawl.**

| Handle | Status | Tracker wallets | Provenance | Note |
|---|---|---|---|---|
| `@_zeldr1ss` | solo handle | — | — | exists; not in the tracker |
| `@ConorrCrypto` | solo handle | — | — | exists; not in the tracker |
| `@das000000000` | solo handle | — | — | exists; not in the tracker |
| `@DomiTrader` | solo handle | — | — | exists; not in the tracker |
| `@eguito0` | solo handle | — | — | exists; not in the tracker |
| `@gigac312` | solo handle | — | — | exists; not in the tracker |
| `@k4yeSol` | **crosses** | 1 | `https://data.solanatracker.io/v2/pnl/leaderboard/kols`, read 2026-09-01 | staged **pending** 2026-09-02, then approved |
| `@KairosHolder` | solo handle | — | — | exists; not in the tracker |
| `@mambatrades_` | **crosses** | 1 | `https://data.solanatracker.io/v2/pnl/leaderboard/kols`, read 2026-09-01 | staged **pending** 2026-09-02, then approved |
| `@ochouso` | solo handle | — | — | exists; not in the tracker |
| `@Penguzxbt` | solo handle | — | — | exists; not in the tracker |
| `@Stigman__` | **crosses** | 1 | `https://data.solanatracker.io/v2/pnl/leaderboard/kols`, read 2026-09-01 | staged **pending** 2026-09-02, then approved |
| `@victordegods` | solo handle | — | — | exists; not in the tracker |
| `@Von_Draken` | solo handle | — | — | exists; not in the tracker |
| `@zl4sh1x` | solo handle | — | — | exists; not in the tracker |

**Lot 1 (2026-09-02): five handles, five alive, one crossing. Lot 2 (2026-09-02): ten
handles, ten alive, two crossing.** Fifteen so far, none dead — no handle has answered `404`,
so the variant retry has not been exercised against a real miss yet. `docs/references.md` §2.1 is why a crossing row is staged rather than
approved: the tracker's attribution is a third party's claim, and nobody has vouched for
these people or asked to be here.

**A `solo handle` row is not a rejection.** It is a person the tracker does not carry a
wallet for, which is most people. `/registro` is how they supply one over their own
signature — a stronger provenance than any tracker URL, because a signature over
`solana:mainnet` cannot be forged and an attribution can simply be wrong.

## 2b. Discarded, with the reason

No handle from the seed has been discarded yet: none answered `404`, and none produced an
oEmbed status other than `200`.

The sources tried before the seed existed, and why none of them could produce the list on
its own, are below.

| Source | Reachable | Publishes a full wallet | Publishes an X handle | Discarded because |
|---|---|---|---|---|
| `kolscan.io/leaderboard` | yes, `200` | yes — in every `/account/<address>` link | **no** | Zero `x.com/*` links on the page. It pairs a wallet with a *nickname*, and a nickname is not a handle. |
| `kolscan.io/account/<address>` | yes, `200` | yes — the URL itself | **no** | Its whole link set is Solscan transaction links plus site nav. |
| `kolscanbrasil.io` | yes, `200` | **no** | yes — ~170 real `x.com/<handle>` links | Wallets are `Wallets Ocultas` or truncated to six characters. Brazilian by construction. |
| `gmgn.ai/trade/kol` | **no** | — | — | `ERR_ABORTED` — the page did not load. |
| `gmgn.ai/?chain=sol` | yes, `200` | — | token creators' handles only | The wallet and KOL panels render **`You are not logged in to GMGN`**. |
| `app.cielo.finance/leaderboard` | **`404`** | — | — | No public leaderboard at that path. |
| `solanatracker.io/kols` | **`404`** | — | — | No public KOL page. |
| `data.solanatracker.io/v2/pnl/leaderboard/kols` | **`200` with a key** | yes | yes, on 507 of 621 rows | **This is the one that works**, and it is what §2 crosses against. |

## 3. The near-miss, recorded because it nearly shipped

Asked for `displayName`, `walletAddress` and `xHandle` from `kolscan.io/leaderboard`, the
structured extractor returned a confident, complete, well-formed answer for **fifty rows** —
and every `xHandle` in it was the **first six characters of that row's wallet address**:

    <wallet beginning SAALE2…>   ->  xHandle: "SAALE2"
    <wallet beginning AuPp4Y…>   ->  xHandle: "AuPp4Y"
    <wallet beginning Hw5UKB…>   ->  xHandle: "Hw5UKB"

(The addresses themselves are elided here for the reason §1 gives: writing three real
ones into this file to illustrate the rule would have broken it. The first draft of this
paragraph did exactly that, and `hygiene.ts` is what would have caught it.)

That is the truncated-address chip the row displays, read as a handle. Taking it would have
published a **fabricated wallet↔handle pairing for fifty real people**, each one internally
consistent and none of them true.

**The lesson is where the inference came from.** The rule against inferring a pair is easy
to keep against one's own reasoning and easy to lose against a tool that answers the
question it was asked. So the pair is now taken only from a **link the source actually
emits** — `x.com/<handle>` in the page's link set — never from a field an extractor filled
in. Requesting the links rather than a summary is what exposed it: `kolscan.io` emits no
`x.com` link at all, which is the fact the extraction had papered over.

---

## 4. The hispanic filter, and what it can actually measure

**The criterion.** A handle is Spanish-speaking when its **bio** and its **recent posts**
are predominantly in Castilian Spanish. Portuguese is not Spanish, and a Brazilian roster is
the obvious way to get that wrong. The tells, in order: Spanish function words (`que`, `de`,
`para`, `con`, `esto`), `ñ`, and `¿ ¡`; against Portuguese `você`, `não`, `ção`, `ã`, `õ`.
Bio and posts together, because a bio can be one emoji and a post stream can be all tickers.
English-language trading slang (`entry`, `runner`, `bags`) is not evidence either way — the
whole niche uses it in every language.

**What the instrument returns, measured 2026-09-01.** `firecrawl_scrape` on an X profile
gives the display name, bio, exact follower count, and recent posts with URL and date:

    @CarrascosaCris_   60,503 followers, bio, 5 posts with URLs and dates
    @criptoagiota          23 followers, verified, 1 post
    @solana         4,158,480 followers

**Two limits, and the first one contradicts the brief.** It returns **one to five recent
posts, not twenty**. "Predominant language over the last 20 posts" cannot be executed at
that depth today; what can be executed is "bio plus the three-to-five most recent posts",
which is a weaker sample and is what a row would actually rest on. Say so per row rather
than implying twenty were read.

**And a tracker's roster contains handles that no longer resolve.** `@damicripto`, taken
from `kolscanbrasil.io`'s live link set, comes back `@unknown` / `Followers: Unknown`. The
instrument refuses rather than inventing a profile, which is what makes it safe to run over
a list somebody else assembled — but it means a tracker row is not evidence that an account
exists, and every handle is re-checked before it becomes a candidate.

---

## 5. What is still missing, and it is the seed

Every tracker was tried before asking. Three are gated behind a login or an API key this
environment does not have; two are fully readable and do not publish the pair at all. So
there is no row to put in §2, and the honest position is the one `docs/references.md` §1
already recorded about the category leader:

> "We are looking for the top trenchers! If you have $100k+ PnL in recent months, DM us your
> wallet for verification on X @kolscan."

— *"The last FAQ answer is the whole curation model: manual, DM-based, with a stated PnL
bar."* Inbound curation is what `/registro` is, and it needs no seed.

**And the closer reference goes further.** `references.md` §2.1, corrected 2026-09-01:
kolscanbrasil.io — the national clone this product is modelled on — has **self-serve alta**,
where the KOL connects a wallet and claims their own profile. So opt-in is not a scruple
this project invented against the grain of the category; it is what the nearest neighbour
already does, and the DM in §1 is the older shape rather than the standard one.

**For the tracker path, the missing input is a seed of handles, and it is human.** With a
list of handles, §4's procedure runs over each one and produces followers, country and the
language verdict mechanically; the wallet then comes from whichever tracker publishes it
beside that handle, cited by URL and read-date per §1-B, and never from this repository's
own inference.

Two things that would also unblock it, if the owner would rather not supply the list:

- **A Solana Tracker API key.** Its KOL leaderboard returns `identity.twitter` beside the
  wallet, which is exactly a §1-B pair from a single source. It is the one gated source
  whose shape is known to be right.
- **A GMGN login.** Its KOL and wallet trackers are the panels that said `You are not logged
  in`; whether they publish the pair is unknown until someone looks.

---

## 6. After the owner confirms

In order, and none of it before the confirmation:

1. `POST /api/admin/kol` per confirmed candidate — handle plus any confirmed wallets, each
   with `isPublic` set from what the owner decided per wallet, never per KOL. The address is
   typed into the request from its provenance URL; it never enters a file in this repo (§1).
2. `scripts/requeue-untracked.ts` against the real roster, so history catches up with the
   people who were just added. `docs/padron.md` §3 has the bounds: it clears `parsed_at` on
   rows that were *accepted and found nothing*, never on rows carrying a `parse_error`, and
   it takes a limit so the operator decides how much to reprocess.

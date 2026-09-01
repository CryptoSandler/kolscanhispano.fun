# Candidate roster: Spanish-speaking KOLs

A working list for the owner to strike through and confirm. **Nothing here is registered.**
No row in this file has touched `kol`, `kol_wallet` or the admin API; the alta happens only
after the owner confirms, and then through `POST /api/admin/kol` like any other creation.

---

## 1. The rules this list obeys

1. **A wallet appears only if the KOL published it themselves, on X.** Not a wallet found by
   watching the chain, not one inferred from a trade, not one a third party attributed to
   them. Spec §6 and `DECISIONES.md` make the roster opt-in; a list assembled by inference
   would make it the opposite while looking identical from outside.
2. **Every wallet carries its provenance**: the URL of the post, and the date of the post.
   A wallet with no citable post is not a wallet, it is a guess.
3. **No published wallet means the row is `solo handle`** — the candidate still belongs on the
   list, because the handle is the thing the owner is judging. `/registro` is how that person
   supplies a wallet later, over their own signature, which is the only path that produces one
   we are entitled to index.
4. **Ordered by followers**, descending, measured rather than remembered.
5. **No real names.** The handle is the identity, per the no-doxx rule in `CLAUDE.md`. A
   candidate's legal name does not go in this file even when it is public elsewhere.

---

## 2. The list

| # | Handle | Followers | Country | Wallet (Solana) | Provenance: post URL | Post date | Note |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | *empty — see §3* |

**The list is empty on purpose, and that is a finding rather than an omission.** §3 records
what was measured and §4 records the procedure that fills it.

---

## 3. Why the list is empty: discovery does not work from the open web

Measured 2026-09-01, from this machine. Per `CLAUDE.md`'s rule that an environment fact is
verified with a command before it is written down, the queries are here beside the result.

| Instrument | Query shape | Result |
|---|---|---|
| WebSearch | `traders memecoins Solana español X twitter influencers cripto LATAM 2026` | English SEO listicles; zero Spanish-speaking trader handles |
| WebSearch | `"memecoins" trader español twitter wallet Solana pública seguidores` | Copy-trading tool pages; zero handles |
| WebSearch | `mejores influencers cripto España Twitter X handles lista 2026` | Global figures (Saylor, Buterin) + one Spanish lawyer |
| WebSearch | `criptomonedas OR memecoins traders hispanohablantes X … ranking PnL` | Token listicles; explicitly "not covered in these sources" |
| firecrawl_search | `memecoins solana … español`, `includeDomains: ["x.com"]` | **`web: []`** — zero results |
| firecrawl_search | `… site:x.com trader memecoins español` | **`web: []`** — zero results |
| firecrawl_search | `canal español memecoins solana …`, `includeDomains: ["youtube.com"]` | **`web: []`** — zero results |
| firecrawl_scrape | `https://x.com/search?q=memecoins%20solana%20lang%3Aes&f=user` | **Refused**: *"we do not support this site"* |

Two independent search indexes, eight query shapes, and a direct attempt at X's own search.
The Spanish-language memecoin trading scene lives inside X, and **X's search is the one surface
neither instrument reaches.** A profile can be read; the graph cannot be walked.

**The reference product does not discover them either.** `docs/references.md` §1 records
kolscan.io's own answer to *"How do I get my wallet on the leaderboard?"*:

> "We are looking for the top trenchers! If you have $100k+ PnL in recent months, DM us your
> wallet for verification on X @kolscan."

— and the teardown's own conclusion beside it: *"The last FAQ answer is the whole curation
model: manual, DM-based, with a stated PnL bar."* The category leader curates **inbound**.
That is what `/registro` already is here, and it is a better instrument than any list this
document could have contained.

**What was not done, and why.** The remaining way to produce thirty handles was to write down
names the model associates with the niche. Every such handle is either wrong or belongs to a
real person who would then be proposed for a public roster on no evidence at all — the exact
shape of mistake the no-doxx rule exists to prevent, and irreversible in the direction that
matters. `docs/padron.md` §1 already settled the general form of this: *"Failure is refusal,
never acceptance."* An empty list refuses. A plausible list would have accepted everybody.

The one Spanish-language candidate that surfaced from an indexable source is recorded below
rather than in §2, because it has not been verified on X and has no published wallet:

- **YouTube `@AdrianSaenz`** — Spanish-language memecoin trading course, 198,534 views on
  *"Cómo Ganar Dinero Con Trading De Meme Coins"*
  (`https://www.youtube.com/watch?v=wy4onaf39RA`, published 2024-12-28). No X handle in the
  video's metadata, and no published wallet. **Solo handle, and not yet even that** — an X
  account has to be confirmed before this is a candidate at all.

  Recorded by channel handle rather than by the creator's name, which the metadata also
  carries: rule 5 above is a rule about this file, not only about the table in it.

---

## 4. The procedure that fills the list

Discovery is blocked; **verification is not**, and it produces exactly the columns §2 wants.
Given a handle, `firecrawl_scrape` on `https://x.com/<handle>` returns the bio, the exact
follower count, and recent posts with their URL and date. Verified on two live handles
2026-09-01: `@solana` → 4,158,480 followers; `@CarrascosaCris_` → 60,503 followers, five posts
with URLs and RFC-1123 dates.

It also **fails loudly on a handle that does not exist**: a made-up handle returned
`# @unknown (@unknown)` / `Followers: Unknown` rather than an invented profile. So the
instrument refuses rather than confabulates, which is what makes it safe to run over a list
somebody else assembled.

Per candidate handle:

1. `firecrawl_scrape https://x.com/<handle>` → **followers** (column 3), and confirmation the
   account exists. `Unknown` means drop the row, not guess it.
2. Read the bio and recent posts → **country** (column 4) and whether they are a memecoin
   trader rather than a general crypto account. Judged from what they post, not from the name.
3. Search their own posts for a Solana address they published. If found: **wallet**, **post
   URL** and **post date** (columns 5–7). If not found: `solo handle`, and columns 5–7 stay
   empty. There is no third option.

**The seed list is the missing input, and it is human.** The owner reads this scene daily; a
pasted list of handles is the one thing that cannot be derived from here. Thirty handles in,
this procedure produces the table in §2 mechanically.

`/registro` is the other half, and it needs no seed: it makes the KOL supply the wallet over
their own signature, which is a stronger provenance than any post URL in this file — a post
can be deleted, and a signature over `solana:mainnet` cannot be forged.

---

## 5. After the owner confirms

In order, and none of it before the confirmation:

1. `POST /api/admin/kol` per confirmed candidate — handle plus any confirmed wallets, each
   with `isPublic` set from what the owner decided per wallet, never per KOL.
2. `scripts/requeue-untracked.ts` against the real roster, so history catches up with the
   people who were just added. `docs/padron.md` §3 has the bounds: it clears `parsed_at` on
   rows that were *accepted and found nothing*, never on rows carrying a `parse_error`, and it
   takes a limit so the operator decides how much to reprocess.

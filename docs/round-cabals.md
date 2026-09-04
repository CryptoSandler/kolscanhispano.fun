# The round before KOL-owned cabals

`CLAUDE.md`: *"Any change to the model — what a number means, **what a rule decides** — and any
large product decision gets one round **without code** first."* This changes what a rule decides:
today one principal (the admin) may write anything, and this proposal creates a second one whose
authority is scoped to a group it owns. That is an authorization model, and the round comes first.

Written 2026-09-03, before any code. Facts checked against the repository, with the commands.

---

## 0. What the repository already has, and it is more than the brief assumes

| Brief's requirement | Already true? |
|---|---|
| "un KOL solo puede estar en un cabal a la vez" | **Already structural.** `kol.cabal_id UUID REFERENCES cabal (id)` — a single nullable FK. One cabal per KOL is not a rule to enforce; it is the shape of the column |
| "todo pasa por audit_log con procedencia" | **Table exists**: `actor, action, target_type, target_id, before, after, ip_hash, at`. Nothing new needed |
| chip in rows and modal | **Shipping.** `cabalChipClass`, four tints, contrast measured in `DESIGN.md` |
| `/cabals` with ranked totals and members | **Shipping**, `cabals.ts` |
| Fede creates/edits from `/admin` | **Shipping** |

    sed -n 1,20p migrations/001_core.sql        # cabal, kol.cabal_id
    sed -n 142,154p migrations/001_core.sql     # audit_log

**So the feature is not "build cabals". It is "add an owner, a membership request, and a second
authorization principal".** Three of the brief's eight bullets are already done, and naming that
changes what this batch is.

## 1. The strongest case against

**There is no KOL session, and that is a written decision, not an omission.**
`src/app/api/registro/route.ts`: *"**There is no session, deliberately.** Proving wallets across
several requests would need somewhere to remember which ones were proven — a cookie or a `claim`
table — and `docs/padron.md` §2 already argues against building a second roster table. Each
wallet carries its own signature in the one request that creates the KOL."*

Every verb in this brief needs the opposite. *"El líder ve las solicitudes en su panel y acepta o
rechaza"* is a page that must know who is reading it, across requests. Accept, reject, expel,
promote, transfer, leave — six state changes, each of which must be attributable to a specific
KOL. **This is the feature that introduces sessions to a product that decided not to have them**,
and the brief does not mention it.

The alternative — sign every action — is real but it is not free either: six signature prompts
for six clicks, each one a wallet popup, and a leader triaging ten requests signs ten times.

**A signature proves a wallet, not a KOL.** `/registro` verifies that whoever holds a wallet
signed a nonce. To act as a leader, the server must go from a signature to a `kol_id` — which
means the wallet→KOL mapping becomes an **authorization** table, not just an attribution one. It
is currently encrypted with a blind index for lookup (`kol_wallet`), and the threat model changes
the moment a signature over it can expel someone from a group. A KOL who rotates or loses a
wallet loses control of their cabal, and there is no recovery path in the brief.

**"Ningún cabal creado por un líder es editable por admin salvo takedown" is a promise, and
promises are the thing this project writes down before making.** `CLAUDE.md`, *Decisions with a
door*: *"Anything irreversible is written once, and only when explicitly asked for."* A published
guarantee that the operator cannot edit user content is exactly that kind of promise — and
"salvo takedown" is the escape hatch that makes it not-quite-true, which is the shape that reads
worst if it is ever exercised. The mechanism can be built without publishing the promise.

**The empty state is the deliverable again.** Production has **three approved KOLs** and there
are no cabals owned by anyone. Shipping leader panels, request queues, promotion and transfer for
a roster of three is a lot of authorization surface for a group that can be coordinated in a
direct message.

    SELECT status, count(*) FROM kol GROUP BY status;   -- approved: 3

## 2. The collision with the real code

- **`cabal` has no owner, no colour and no X handle**: `id, tag, name, logo_url, created_at`. The
  migration is real — `leader_kol_id`, `color`, `x_handle`, and a flag distinguishing an
  admin-created cabal from a leader-created one, because the takedown carve-out needs to know
  which is which.
- **`cabal.tag` is `UNIQUE CHECK (tag ~ '^[A-Z]{3,4}$')`** — the brief's "3–4 letras" is already
  enforced, and uniqueness means **tag allocation becomes first-come-first-served among users**.
  Today an admin picks them; tomorrow a KOL can take `ORB` and nobody else can ever have it. That
  is a namespace, and namespaces get squatted.
- **The colour is not free.** `DESIGN.md` fixes four cabal tints (`cabal-a..d`) with measured
  contrast ratios, and `design-tokens.test.ts` enforces them. *"Color"* chosen by a leader means
  either a fifth unmeasured colour on a public surface, or a picker limited to the four. The
  second is the only one compatible with the document.
- **`/cabals` reads `pnl_daily`** and cannot answer a rolling window (`CALENDAR_WINDOWS`, added
  today). A cabal board with member counts and totals is unchanged by this feature; only its
  empty state moves.
- **No address may appear.** `address-invariant.test.ts` sweeps rendered HTML for the fixture's
  own addresses in every encoding. A leader panel that lists members is fine; one that shows *who
  signed* must show a KOL, never a wallet. The brief's last test — *"que ninguna address
  aparezca"* — is already the house rule, and the existing sweep extends to the new pages for
  free if they render KOLs.
- **`no-money-path.test.ts` stays satisfied**: every action here signs a *message*, so the
  dormant wallet rules stay dormant, exactly as `/registro` does.

## 3. Recommendation

**Build it, in two batches, and do not publish the promise.**

**Batch A — ownership and membership, signature-per-action, no sessions.**
`leader_kol_id`, `color` limited to the four measured tints, `x_handle`, `created_by`, and a
`cabal_request` table. Every mutating action carries a signature over a nonce that names the
action and the target, the way `/registro` already does — *"each request carries its own proof"*
is the pattern this repository already chose, and it keeps the no-session decision intact. The
leader's panel reads by signature-on-open too: one signature to see the queue, one per decision.
It is more prompts than a session, and it is **one fewer thing to secure**.

If that is judged too heavy in use, the alternative is a short-lived signed cookie issued after
one signature — but that is a session, it reverses a written decision, and it deserves its own
round rather than being smuggled in as an implementation detail of a cabal panel.

**Batch B — transfer, co-leader, takedown.** Promotion and transfer are the actions that can
strand a group: a transfer to a suspended KOL, or a leader whose wallet is gone, leaves a cabal
nobody can administer. Build them after the basic lifecycle is in use, with an explicit answer to
*"who administers a cabal whose leader is gone"*.

**Three things I would change in the brief.**

- **The colour is one of the four, not a picker.** A fifth tint is an unmeasured colour on a
  public surface and `DESIGN.md`'s contrast table is enforced by a test.
- **Tags need a reservation rule.** Unique, uppercase, 3–4 letters, first-come — decide now
  whether a leader can release one, and whether the admin can reclaim a squatted tag, because
  after the first collision it is somebody's identity.
- **Build the carve-out; do not publish it.** Store `created_by` and have `/admin` refuse to edit
  a leader-created cabal. Say nothing on any public surface about what the operator can or cannot
  do until the owner decides to say it. `CLAUDE.md`, *Decisions with a door*: the neutral wording
  costs nothing now and a published promise cannot be withdrawn quietly.

**And the honest reservation.** With three approved KOLs, this is authorization machinery for a
group that fits in one conversation. If the goal is to be ready for a roster that grows, batch A
is the right shape and the signature-per-action pattern is the one that does not reverse a
decision. If the goal is cabals *working* this week, the lazier answer is the one already
shipping: Fede creates them from `/admin`, and this round gets reopened when there are enough
KOLs that the admin is the bottleneck.

## 4. Open, and the owner's

- **Sessions: yes or no?** Signature-per-action keeps the written decision and costs prompts. A
  cookie is comfortable and reverses it. This is the decision the whole batch hangs on.
- **A leader who loses the wallet** — is the admin the recovery path, and does that survive the
  "not editable by admin" carve-out?
- **Tag squatting**: releasable, reclaimable, or permanent?

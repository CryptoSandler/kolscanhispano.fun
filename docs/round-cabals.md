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

## 4. Closed by the owner, 2026-09-04

The three questions this round left open were answered, and all three the conservative way.

**No KOL session. Signature per action.** The written decision in
`src/app/api/registro/route.ts` — *"There is no session, deliberately"* — stands, and every
mutating action carries its own proof over a server-issued nonce, exactly as `/registro` already
does. The cost is a wallet prompt per decision, and the owner's reasoning is that a leader takes
few actions a day; **if it turns out to chafe, it gets revisited with data rather than with a
guess.** That is the sentence that makes this a decision and not an assumption: the thing that
would change it is named, and it is a measurement.

The consequence worth stating: this batch adds a second authorization principal **without**
adding a session, so nothing here can ever be replayed from a cookie, and there is no session
fixation, no CSRF surface and no logout to get wrong. The whole class is absent rather than
defended.

**A leader who loses the wallet: transfer only if there is a co-leader.** Otherwise the cabal is
**orphaned** — it keeps existing, keeps its members and keeps ranking, and only the admin may
reassign it, through `audit_log` with a stated reason. Orphaned is a real state and not an error:
the alternative is a recovery path that lets anyone who can talk to an operator take over a group
they do not control.

This also settles the shape of the carve-out. *"No cabal created by a leader is editable by
admin"* has exactly two exceptions and both are named: a takedown, and reassigning an orphan.
Neither is published as a promise — `CLAUDE.md`, *Decisions with a door* — and both leave a row
in `audit_log` naming the actor, the target and the reason.

**Tags: released 30 days after the cabal dissolves, never reclaimed while in use.** So a tag is
first-come and permanent for as long as the group exists, and the namespace does not fill up with
abandoned three-letter words. The 30 days is a cooling-off: a tag freed the instant a group
dissolves is a tag someone can snipe the moment a rival disbands, and a group that dissolves by
mistake has a month to come back to its own name.

**What that leaves for the build**, all of it now decided:

- `leader_kol_id`, `color` limited to the four measured tints, `x_handle`, `created_by`.
- `cabal_request`, and a `co_leader_kol_id` — needed by the transfer rule above, so it is not a
  batch-B nicety any more.
- A `dissolved_at` on `cabal`, because the tag's 30 days are counted from it.
- Every mutation signed, every mutation in `audit_log` with provenance.

## 5. Decided by the owner, 2026-09-05

The three questions §5 left open were answered the day after they were asked.
Two are built in this batch; the third is a refusal that needed nothing built.

### 5.1 The co-leader is named by the leader, and there are at most two

A signed action each way — `nombrar co-líder` and `revocar co-líder` — through
the same gate and the same audit as the other eight. **Only the leader may name
one.** A deputy who could name deputies would make the cap a formality, since two
of them could keep naming each other's replacements, and it would make "who
delegated this authority" a question the trail cannot answer.

**The cap changed a shape.** `migrations/016` gave `cabal` a single
`co_leader_kol_id`, because §4 only needed somebody to transfer to. Two does not
fit in a column, and a second column is the option that looks cheaper and is
not — every query learns to say `co_leader_kol_id = $1 OR co_leader_2_kol_id =
$1`, and the day the cap becomes three, every one of them is wrong in a way that
still runs. So `migrations/020` moves them to `cabal_co_leader (cabal_id, kol_id,
slot)`, and **`slot` is what makes the cap a constraint instead of a count**:
`CHECK (slot IN (1,2))` with `UNIQUE (cabal_id, slot)` means a third appointment
has nowhere to go. Counting rows in the handler and refusing at two is a
read-then-write, and two appointments arriving together both read one.

Revoking frees a slot and the next appointment reuses it — a handler that only
counted upwards would refuse after one revoke and the cap would quietly have
become one. That is a test.

**The orphan is resolved by the admin, and by nothing else.** Closed 2026-09-05,
after an earlier draft of this section leaned on a dissolution by inactivity that
does not exist — `dissolved_at` is read in three places and written by nothing
but tests, and "inactivity" elsewhere in this product means the opposite
(`docs/spec-v1.md` §72: *"Inactive approved KOLs stay in the list at zero"*).
**No timer and no auto-promotion get built.** A leader who cannot sign and has no
deputy leaves a cabal that only §4's admin reassignment moves, from `/admin`,
with an entry in `audit_log`.

That is a coherent answer rather than a gap, but it carries one obligation: **a
state that resolves only by hand, and that nothing surfaces, resolves when
somebody complains.** So `/admin` lists the orphans — `src/lib/orphan-cabals.ts`
behind `GET /api/admin/cabal` — and it names *which* of the three ways a cabal got
there, because what the admin should do differs:

- **`sin líder`** — `leader_kol_id IS NULL`, already reassigned away or seeded
  before leaders existed.
- **`líder sin wallet activa`** — every wallet withdrawn. This is the case §4 was
  actually about: no signature is possible, so no action of theirs passes the gate.
- **`líder no aprobado`** — suspended or back to pending. `authorise` requires
  `kol.status = 'approved'`, so the cabal is equally stuck, but the fix is
  probably a status and not a new leader.

The member count goes beside each one: it is the stakes of leaving it stuck. A
dissolved cabal is not an orphan — it is finished, and its tag is on the
thirty-day clock.

**The list has no button.** Reassigning is not built, and `docs/padron.md` §4's
"`/admin` does not do cabals" still holds for every control; showing a
reassignment that does nothing would be `DESIGN.md`'s last Don't. What changed is
that the state is visible instead of being something to go looking for.

### 5.2 The queue is read by the leader and the deputies, and is never public

`ver solicitudes` returns the pending queue to whoever leads or deputises the
cabal. `ver mi solicitud` returns an applicant the status of **their own** and
nothing else: not the queue, not their position in it, because a position is a
fact about the other people in it.

Never public, and this is the one-way half: showing who asked to join publishes a
rejection, and a KOL who was turned down cannot be un-published.

**Both reads are signed**, like every write. That is §4's *no KOL session*
showing its price rather than a choice made here — nothing remembers between two
requests that a wallet leads anything, so "show me my queue" has to prove it
exactly as "accept this person" does. It costs a wallet prompt per panel load.

Two smaller things fall out of it and are worth naming:

- **The subject is compared, not looked up.** A leader naming another cabal's tag
  is refused rather than answered about their own, because the tag is what they
  signed.
- **The leader's read is audited, the applicant's is not.** Reading who wants
  into a group is access an account should be able to show later; `@ana` asking
  whether `@ana` was accepted is noise that makes the entries that matter harder
  to find. The audited entry stores **the count, never the handles** — listing
  them would republish inside `audit_log` the thing the read exists to keep
  narrow.

### 5.3 A deputy still cannot take a cabal whose leader is gone

Unchanged, and nothing was built: `transfer` refuses a co-leader. Nothing in the
database distinguishes "the leader is gone" from "the deputy would like the
group", and a self-promotion that cannot be told from a theft is one the audit
trail would record as legitimate. The lost-wallet path stays the admin's.

## Appendix: how these three read while they were open — 2026-09-04

Three things the action layer deliberately did **not** decide. Each is written
here rather than in code because each is one-way: a published fact cannot be
unpublished, and a mechanism built for one of two futures has to be rebuilt for
the other (`CLAUDE.md`, *Decisions with a door*).

### 5.1 Is the pending queue readable, and by whom?

`cabal_request` records who asked to join which cabal. Nothing reads it back
yet, so `/mi-cabal` has a leader accept or reject by naming the applicant's
`@handle` — which the applicant already told them.

The three futures, and what each costs:

1. **Public, on the cabal's page.** Cheapest, and it publishes a rejection: a
   KOL who asked and was turned down is visible to anybody who looks. Not
   reversible once anyone has seen it.
2. **Only the leader, behind a seventh signed action** — `ver solicitudes`,
   proved the same way as the other six. Leaks nothing. Costs a wallet signature
   per panel load, which is what *no KOL session* buys everywhere else, and two
   changes (`PROOF_ACTIONS` plus a migration's `CHECK`, per `DECISIONES.md`).
3. **Nobody: it stays as it is.** The applicant tells the leader out of band.

**Recommendation: 2.** It is the only one of the three that makes the panel a
panel, and the signature-per-read is the same price the owner already accepted
for every write. It is also the only one that stays available whichever way 1 is
later decided — the queue can always become public afterwards, and never
un-public.

The neutral wording, until it is decided: the site promises nothing about who
can see a pending request, and no page says one way or the other.

### 5.2 Nothing appoints a co-leader

`co_leader_kol_id` exists, `cabal_co_leader_distinct` guards it, `expel` and
`transfer` both maintain it — and **no action sets it**. That is a real gap, not
an omission in the writing: §4's decision *"transfer only if there is a
co-leader; otherwise the cabal is orphaned"* rests on a seat that today only the
operator can fill by hand.

It is a seventh action of the same shape as the six (`nombrar co-líder`, subject
a `@handle`, signed by the leader), and it is two changes for the same reason
5.1's is. It was left out because the batch was scoped to the five handlers that
were asked for, and adding signable actions is a decision about what a signature
can authorise — the owner's, not the implementer's.

### 5.3 Can a co-leader take a cabal whose leader is gone?

`transfer` refuses a co-leader, on purpose: **nothing in the database tells "the
leader is gone" from "the deputy would like the group"**, and a self-promotion
that cannot be distinguished from a theft is a theft the audit trail will
record as legitimate.

So the lost-wallet path is the admin's: reassign to the existing co-leader, with
a reason in `audit_log`, which is exactly what §4 says the admin may do for an
orphan. What §4 leaves open is whether *"transfer only if there is a co-leader"*
was meant to happen **without** the admin. If it was, it needs an answer to "how
does the server learn the leader is gone" first — a timeout on the leader's last
signed action is the only candidate that does not require trusting the person
who benefits.

**Recommendation: leave it with the admin.** A cabal changing hands is rare
enough to be worth a human, and the alternative buys convenience with the one
guarantee the whole signature scheme exists to give.

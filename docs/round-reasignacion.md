# Round: the admin reassigning a cabal — 2026-09-05

`CLAUDE.md` requires a round without code before a change to what a rule
decides, and this is the sharpest one this product has: **the only write in the
cabal system authorised by no signature from either party.** The outgoing leader
cannot sign — that is the premise — and the incoming one is not asked.

## 0. Two facts checked before arguing, because both change the argument

**`kol_wallet.status` is never set to `withdrawn` by any code path.** Verified
2026-09-05: `grep -rn withdrawn src scripts --include='*.ts'` outside tests
returns four hits and every one is a comment. Nothing in the product withdraws a
wallet; it can only happen by hand in SQL.

That matters because `líder sin wallet activa` is the orphan reason §4 was
actually about, and it reads as an objective fact about the world. It is not one.
It is **a value the operator sets**, and nobody else — so "this leader cannot
sign any more" is, today, a statement the operator makes about somebody rather
than one the system observes.

**Production has one cabal: leaderless, operator-seeded, with zero members.**

    total 1 | leaderless 1 | seeded (created_by='admin') 1 | dissolved 0
    KOLs with cabal_id: 0

So there is no leader anywhere to take a cabal *from*, and there will not be one
until somebody creates a cabal through `/mi-cabal`. What this feature does in
production **today** is not reassignment at all: it is the initial assignment of
a seeded shell to its first leader.

## 1. The strongest case against

Not caveats. The argument that this should not be built, made as well as its
opponent would make it.

**It falsifies the one claim the whole design rests on.** `migrations/019` says
the signature beside each audit entry "is the only part of this account that does
not rest on trusting the operator", and `SECURITY.md` repeats it. Ship this and
the honest sentence becomes: *every cabal mutation is signed by the person it
affects, except the one that decides who owns the cabal.* An exception in exactly
the highest-value position is not an exception, it is the answer.

**The trigger condition is settable by the beneficiary's own side.** From §0: a
wallet becomes `withdrawn` only by operator action. So the sequence "operator
withdraws the leader's wallet → the cabal appears in the orphan list → the
operator reassigns it, with a reason they also wrote" is available, leaves a
perfectly consistent audit trail, and is **indistinguishable from the legitimate
case**. The hash chain does not help: every row is genuine. The signature does
not help: there was never going to be one. What the account will faithfully
record is that an orphan was resolved correctly.

**The audit entry is evidence for a reader who does not exist.** Nothing publishes
`audit_log`. A KOL who believes their cabal was taken cannot read the entry that
says it was, so the trail's deterrent value is entirely internal — it protects
against a careless operator, not a dishonest one, and the careless case is
already covered by the orphan list making the state visible.

**And the demand is zero.** One seeded cabal, no members, no leaders. Building
the most dangerous verb in the system for a case that does not exist yet is the
first rung of `CLAUDE.md`'s ladder: *does this need to exist at all?*

## 2. The collision with the real code

**Every existing cabal is an orphan.** `leader_kol_id IS NULL` for the only one
there is, because it predates leaders. The orphan list is not going to show a
rare exception in production; it is going to show the whole cabal table until
somebody registers one. A screen built around "this is unusual, look at it"
starts life saying that about everything.

**Half the mechanism already exists and is better than expected.** Since this
batch, `admin.ts`'s `audit()` goes through `appendAudit`, so an admin entry is
already inside the hash chain with `before`/`after` — the brief's third
requirement needs no new code, only the right payload. And `audit_signature`'s
absence already marks an entry as unsigned, so "this one had no signature" is
recorded by construction rather than by a flag somebody has to set.

**The public notice has nowhere to live.** There is no cabal page. `/cabals` is a
ranking, one row per cabal, and `DESIGN.md` measures those rows against the
mould. A notice has to fit in a row that is being kept 1:1 with somebody else's
design, or the product needs a surface it does not have.

**`cabal_co_leader` constrains the write.** The trigger refuses a leader who is
also a deputy, so reassigning to a sitting deputy must delete their row first —
the same ordering `transfer` already needed, and the same one that bit there.

## 3. Recommendation

**Build it, with one rule the brief did not ask for, and one upgrade left at the
door.**

The case against is strong on the *dishonest operator* and weak on everything
else, and the honest response is not to refuse the feature — an orphaned cabal
with members and no way out is a worse product than one with an admin escape
hatch. It is to make the escape hatch **as narrow as the stated purpose**:

**The rule to add: refuse reassignment of a cabal that is not an orphan.** Not a
convention, a precondition checked in the same transaction — if the current
leader is approved and holds an active wallet, the route answers `not_orphaned`
and writes nothing. This converts "the operator can move any cabal" into "the
operator can only finish a state the cabal is already in", and it is the
difference between a power and a repair. It costs one `EXISTS` and it is the
whole reason the argument in §1 does not carry.

It does not close §0's hole — an operator who can withdraw a wallet can still
manufacture the precondition — and nothing in a database can, which is the same
honesty `migrations/018` uses about its own triggers. What it does close is every
case where the operator did not go to that trouble, and it makes the trouble
itself a second, separately-recorded act.

### The door was opened the same day — 2026-09-05

The owner chose the upgrade below, and **the direct handover was deleted rather
than kept beside it.** There is now no way for the operator to move a cabal
alone. What is built:

- `nominateCabal` writes a **standing offer**, good for **seven days**, and moves
  nothing — no leader, no membership, no public notice. The cabal stays orphaned
  and stays on the admin's list, because until somebody signs, nothing happened.
- `reclamar cabal` is the eleventh signed action, against the same gate as the
  other ten. **The beneficiary's own signature is what moves the group**, and the
  audit entry carries it — which the direct version could never have had.
- The claim **re-checks the orphan condition**. Seven days is long enough for the
  old leader to register a wallet or a deputy to appear, and a repair applied to
  something that is no longer broken is a seizure.
- The public notice says *"Reasignado por admin, reclamado por @x el D"*. Both
  halves: naming only the operator would hide who benefited, naming only the
  claimer would read like an ordinary transfer. The date is the **claim**.

**Why seven days.** A nomination is a human-coordination window — somebody has to
be told out of band, open a wallet and sign. A day fails anyone travelling; a
month leaves a live claim on a group sitting in the database long after everyone
has forgotten the conversation. Seven covers a week away and expires while the
reason is still fresh enough to write again.

Expiry is **checked, never indexed**: `WHERE expires_at > now()` in an index
predicate is refused by Postgres, and `migrations/016` has the longer version of
why that refusal is right. `status` carries the fact, the partial unique index
covers `pending`, and both the nominate path and the claim path compare the clock
themselves.

### What the argument was, before it was decided

**The upgrade, recorded and not built: the incoming leader claims it with a
signature.** The outgoing leader cannot sign — but the *incoming* one can. An
admin who nominates rather than hands over turns a write signed by nobody into a
write signed by the person who benefits, and the story "the operator quietly
moved a group to an ally" stops being available: the ally signed for it, in
public, with a nonce. The cost is two steps and a cabal that stays orphaned if
the nominee never claims, which is the safe direction and the status quo anyway.

This is a strictly better design and it is not what was asked for, so it is not
what gets built today. The mechanism fits both: nothing about the immediate
version has to be unwound to add a claim step, because the claim would be an
eleventh signed action against the same gate.

**On the notice:** it says *that* it was reassigned and *when*, never the reason.
The reason is mandatory and goes to `audit_log`, because a reason describes a
person's circumstances — a lost wallet, a suspension — and publishing it would
make the repair a punishment.

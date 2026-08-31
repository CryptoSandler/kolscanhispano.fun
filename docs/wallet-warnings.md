# Wallet warnings, and the hygiene rule behind them

Two things live here: the house rule for any project that asks a wallet to sign, and what
Phantom shows a user of *this* one — which is a narrower set, because this project
deliberately has no money path.

---

## The house rule (all projects)

**1. Every transaction offered for signature has exactly one signer — the user — an
explicit chain, and goes through `signAndSendTransaction`.** A second signer in a payload
the user is about to approve is a payload they cannot reason about. `'solana:mainnet'` is
stated, never inferred from whatever the wallet happens to be set to.

**2. Pre-flight on the server, before the transaction ever reaches the client.** Two checks,
both server-side:

- the payer's balance covers **amount + estimated fee**;
- `simulateTransaction` with `sigVerify: false` against **our own RPC**.

If either fails, **the order does not open Phantom.** The UI says why in one sentence —
*"Te faltan 0,04 SOL para esta operación"* — and every branch has a test. A wallet dialog
that opens only to fail is the worst of both: the user has approved nothing, learned
nothing, and been trained to click through a warning.

**3. A rehearsal with a real wallet before every change to the money path.** Not a
simulation, not a testnet dry run — the actual flow, once, by hand, before it ships.

## What applies to kolscanhispano, and what does not

**Rules 1 and 2 are dormant here, deliberately.** This project never builds or sends a
transaction. Spec §6 makes `/registro` the only page that connects a wallet, and it asks for
a **signature over a message**, never a transfer. `docs/spec-v1.md:659-660` states it as a
testable property: *"`/registro` never builds or sends a transaction. An assertion over the
registration module's import graph and source that no transaction-constructing or
transaction-sending API is reachable."*

So `signAndSendTransaction` — rule 1's mechanism — is precisely the API this project forbids
being importable. Implementing rule 2's pre-flight would mean importing the transaction APIs
in order to simulate them, which is the affordance the spec exists to deny. **The two rules
are recorded here in full so that the day this project does grow a money path, they are the
starting point rather than something to rediscover.**

`src/lib/no-money-path.test.ts` is the local expression of the same instinct: it fails if a
transaction-constructing or transaction-sending API becomes reachable from application code
at all. It is the guard that keeps rules 1 and 2 dormant rather than merely unimplemented.

**What rule 1 *does* apply to here** is the SIWS signature itself: one signer, and the chain
stated explicitly as `solana:mainnet` in the signed message rather than taken from the
wallet's current network. A message signed without a chain is a message replayable against
whichever chain the reader assumes.

---

## The three Phantom warnings, and what each actually means

Users will meet these during onboarding. They are not all the same kind of problem, and the
middle one is routinely misdiagnosed as the first.

### "This app is new" / unfamiliar domain

**Cause:** the domain is young. Phantom warns on domains it has not seen before, and
`kolscanhispano.fun` is new.

**What to do:** wait about a week of real traffic, then submit the domain through the review
form linked from `docs.phantom.com`. There is nothing to fix in the code — this one is time
and paperwork, and submitting on day one tends to achieve nothing.

### "This transaction could be malicious"

**Cause: a failed simulation.** Phantom simulates before it shows the dialog, and this is
what it says when the simulation reverts or the transaction would fail.

**Diagnose the pre-flight before you touch the domain.** The mistake is reading this as a
reputation problem and going to fill in the domain form, when the message is telling you the
transaction is broken: insufficient balance, a stale blockhash, a bad account. **Rule 2
exists to make this warning unreachable** — if the server simulated first, the user never
sees Phantom for a transaction that cannot succeed.

Not applicable to this project today, and it stays that way while
`no-money-path.test.ts` passes.

### "This transaction is only valid on mainnet"

**Cause: the user's wallet is in testnet mode**, not a problem with the site.

**What to do:** say so in the UI, in one sentence, pointing at Phantom's network setting.
Never "fix" it by loosening the chain the application states — rule 1's explicit
`'solana:mainnet'` is what makes this warning appear at all, and it is doing its job.

---

## Rehearsal procedure, before any change to the money path

Run in order. It takes minutes and it is the only step that has ever caught a wallet-level
problem before a user did.

1. **Preview deployment, real wallet, small amount.** Not localhost — the domain is part of
   what Phantom judges.
2. **Read the dialog, do not skim it.** Confirm one signer, the chain, and the amount, and
   confirm they match what the server intended.
3. **Force each pre-flight branch to fail on purpose** — a balance below the amount, then a
   deliberately invalid transaction — and confirm **Phantom never opens** and the sentence
   the user sees is the right one.
4. **Then** approve one real transaction end to end.
5. Record what the wallet showed, with the date, next to the change. A warning that appears
   once and is not written down is a warning somebody rediscovers.

For this project, steps 1 and 2 apply to the **SIWS signature** dialog during onboarding.
Steps 3 and 4 have nothing to exercise, and that is the point.

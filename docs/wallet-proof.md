# Wallet proof: SIWS and SIWE

The adversarial round required by `CLAUDE.md` before a model change, the security
contract it settled on, and the negative tests — all of it written **before any code**,
which is the point of the exercise.

---

## 1. The round

### The strongest case against

**SIWE is YAGNI, and saying otherwise would be dishonest.** `docs/multichain.md` §6 keeps
every EVM chain behind an env flag with its public surface closed until its ingestion
carries real data. No EVM chain is activated. A KOL who registers an EVM wallet today
registers one that produces no trades, appears in no feed and occupies no rank. Building a
secp256k1 verifier now is fitting a lock to a door with no room behind it.

**It adds this repository's first cryptographic runtime dependency, against a written
rule.** `CLAUDE.md`'s ladder says *never add a dependency for what a few lines cover*. For
the Solana half that rule genuinely bites, and the repository has already committed to a
position in writing — `src/lib/no-money-path.test.ts` states that verifying SIWS *"is an
ed25519 check `node:crypto` already does"*. Taking `@noble/curves` for ed25519 contradicts
a claim this repository made about itself.

**It changes a security contract nobody has exercised.** Spec §6 fixes the signed message
text. Adding a `Cadena:` line means the spec's message is no longer the message. That is
free today and permanent later — but "free today" argues for doing it *now*, not for doing
it *at all*.

### The collision with the real code

**None of `/registro` exists.** Verified, not assumed: no `claim` or `claim_wallet` table
in `migrations/`, no route under `src/app/registro`, and the string `nonce` appears nowhere
in `src/`. So this is not "adding SIWS to the registration flow". It is the first piece of a
flow whose persistence layer is also unbuilt, and the round has to be honest that the
verifier will sit unused until the endpoints land.

**We get the replay protection the reference implementation could not have.**
`nftraffle`'s `verifyPayerBinding` documents its own ceiling out loud: the nonce is chosen
by the client, so a captured message-and-signature pair can be replayed inside the validity
window. Spec §6.1 issues the nonce **server-side, bound to the address, with a 5-minute
expiry**. Copying the approach must not copy that ceiling — and the single-use nonce is the
one place this design must be *stricter* than the thing it is modelled on.

**Three things already in the tree fit without work.** `kol_wallet.proof_signature_enc` and
`proof_message_enc` are unused `BYTEA`, so SIWE needs no migration. `canonicalAddress`
(`src/lib/chain.ts`, landed this batch) is exactly the comparison a recovered EVM address
needs — without it, EIP-55 and lowercase spellings of one address compare unequal.
And verification is pure, so the suite's network guard needs no escape hatch.

**One guard has to be re-read rather than assumed.** `no-money-path.test.ts` forbids
transaction-constructing APIs and any `@solana/web3.js` or wallet-adapter dependency.
`@noble/curves` is signature verification only — it constructs nothing and sends nothing —
so it trips neither case. That is a claim to verify against the test, not to assert.

### The honest recommendation

**Build the verifier. Do not build `/registro` in this item.** The message format and the
verification rules *are* the security contract, and the onboarding modal depends on them.
What is genuinely premature is the endpoints and the claim tables, not the verifier.

**Take `@noble/curves` for both chains, not just for secp256k1.** For EVM there is no
choice: Node has no public-key recovery API, and hand-rolling curve arithmetic is the one
thing nobody should do. For Solana `node:crypto` really is enough, but only by wrapping a
raw 32-byte key in a 12-byte SPKI DER prefix — a magic constant standing between a
signature and its acceptance. Since the dependency is being taken anyway, one library and
one mental model beats one library plus a hand-assembled DER header. **The claim in
`no-money-path.test.ts` must then be corrected rather than left to rot**, which is the same
mistake `key_version` was.

**The one question that stays open, and it is the owner's.** Whether a KOL may register an
EVM wallet *before* that chain is activated. Nothing in the verifier depends on the answer —
`chain.ts` already names the chains and SIWE can be added or withheld without touching
SIWS — so it does not block this work. It changes what the modal offers, which is item 3.

---

## 2. The security contract

### What is signed

One message, two renderings of the same fields, because a Solana wallet and an EVM wallet
render text differently but must agree on meaning.

```
kolscanhispano.fun quiere verificar que controlas esta wallet.
Esto es una firma de mensaje. No mueve fondos ni aprueba ninguna transacción.

Wallet: <address>
Cadena: <solana:mainnet | eip155:1 | eip155:56 | eip155:4663>
Acción: <alta de perfil | agregar wallet>
Nonce: <nonce>
Expira: <ISO8601>
```

`Cadena:` is the line spec §6 did not have, and it is the whole reason this is a contract
change rather than a feature. The house rule in `docs/wallet-warnings.md` is that the chain
is **stated, never inferred from whatever the wallet happens to be set to**. On EVM the
chain id is also carried outside the text, but a wallet can be on any network when it signs;
on Solana there is no chain field anywhere, so the text is the *only* place it can live.
Stating it in both keeps one rule instead of two.

CAIP-2 notation (`solana:mainnet`, `eip155:1`) rather than a bare number: `1` means Ethereum
to an EVM wallet and nothing at all to a Solana one, and a reader should not have to know
which namespace a number belongs to.

### The rules

1. **One signer, always the user.** Nothing here has a second signer, because nothing here
   is a transaction. `no-money-path.test.ts` is what keeps that true.
2. **The message is rebuilt on the server, never parsed from the client.** Accepting a
   message string and checking that it "contains" the right nonce would let a caller sign
   one sentence and have it read as another. The only text that can verify is the text this
   server would have asked for.
3. **The nonce is server-issued, bound to the address, single-use, and 5 minutes old at
   most.** Single-use is enforced by *burning* it in the same transaction that accepts the
   signature, not by checking-then-writing — a check followed by a write is two concurrent
   requests away from accepting one nonce twice.
4. **The chain is compared, not read.** The verifier is told which chain it expects and
   refuses a payload naming another, before any curve arithmetic runs.
5. **Every refusal is a named reason**, and no reason ever carries the address, the
   signature or the nonce into a message or a log (`SECURITY.md`).
6. **Addresses compare through `canonicalAddress`**, so EIP-55 and lowercase are one
   address and two base58 addresses differing in case stay two.
7. **The verifier is pure**: no clock, no network, no database. The caller supplies `nowMs`.
   That is what makes every rule above testable in Node.

---

## 3. The negative tests, named before the code

A positive test proves the happy path works. These prove the contract is *load-bearing* —
each one must fail for its own named reason, and each must be shown to fail for that reason
rather than for any other, because a refusal that fires on the wrong branch is a guard that
is not guarding what it claims.

| # | What is presented | Must refuse with |
|---|---|---|
| 1 | A valid signature over a payload naming **another chain** (`eip155:1` presented as `eip155:56`) | `wrong_chain` |
| 2 | The **same message and signature replayed on the other chain family** — a Solana payload presented as EVM, and the reverse | `wrong_chain`, never a curve error |
| 3 | A valid signature carrying **a nonce that was never issued** | `wrong_nonce` |
| 4 | A valid signature carrying **an expired nonce** | `expired` |
| 5 | A valid signature whose **nonce was already spent** | `nonce_used` |
| 6 | Two concurrent verifications of **one nonce** | exactly one succeeds |
| 7 | A valid signature for **another domain** (`otrositio.com`) | `wrong_domain` |
| 8 | A signature made by **another wallet** over the correct message | `address_mismatch` |
| 9 | A valid signature for the **other action** (`alta de perfil` presented as `agregar wallet`) | `wrong_action` |
| 10 | A **tampered message**: correct signature, one field edited after signing | `address_mismatch`, because the rebuilt text no longer matches |
| 11 | A **malformed signature**: wrong length, non-hex, unrecoverable `v` | `malformed_signature` |
| 12 | A signature that is **valid on the digest but not the prefixed digest** — EIP-191 skipped | `address_mismatch` |
| 13 | A refusal on **every branch above** | the message contains no address, signature or nonce |

Tests 2 and 12 are the ones a passing implementation is most likely to skip. Test 2 is the
whole reason `Cadena:` exists. Test 12 catches the classic EIP-191 mistake — hashing the
message instead of `"\x19Ethereum Signed Message:\n" + byteLength + message`, where the
length is a count of **bytes**, not characters.

**The mutation that matters**: delete the `Cadena:` line from the builder and confirm tests
1 and 2 die. A chain field nothing checks is decoration.

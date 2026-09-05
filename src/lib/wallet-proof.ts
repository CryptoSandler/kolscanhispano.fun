/**
 * Proving that whoever is registering controls the wallet they name.
 *
 * The contract, the round that settled it and the negative tests are in
 * `docs/wallet-proof.md`. This file implements that contract and nothing
 * beyond it.
 *
 * **Two chains, one message.** A Solana wallet signs raw bytes with ed25519; an
 * EVM wallet signs an EIP-191 `personal_sign` digest with secp256k1 and the
 * address is *recovered* rather than supplied. The two verifications share
 * nothing mechanically — which is exactly why they must share the text, so
 * there is one definition of what a person agreed to instead of two that have
 * to be kept in agreement.
 *
 * **This module is pure.** No clock, no network, no database; the caller
 * supplies `nowMs`. That is what makes every rule in the contract testable in
 * Node, and it is the same discipline `pnl.ts` follows with its threshold.
 *
 * **It builds and sends nothing.** `src/lib/no-money-path.test.ts` is what
 * keeps that true: verifying a signature over a *message* is the whole of what
 * this project ever asks a wallet for, and `@noble/curves` is verification
 * only — it constructs no transaction and reaches no network.
 */

import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_CHAIN_IDS, canonicalAddress, isEvm, type Chain } from "./chain";

/** The site asking. Bound into the text so a signature taken elsewhere is not valid here. */
export const PROOF_DOMAIN = "kolscanhispano.fun";

/**
 * The longest a proof may stay good for, counted from `nowMs` to the message's
 * own `Expira`.
 *
 * Spec §6.1 gives the nonce a five-minute life. This bounds the *message* by
 * the same figure, and it is a separate check rather than the same one: the
 * nonce's expiry lives in a table, and a client that could name its own
 * `Expira` far in the future would otherwise mint a signature good for ever
 * against a nonce that had not yet been looked up.
 */
export const PROOF_VALIDITY_MS = 5 * 60_000;

/**
 * What a signature is for.
 *
 * Spec §6 defined the first two, whose subject is always the signer's own
 * wallet. The ten that follow are a cabal leader's, added with
 * `docs/round-cabals.md` §4's decision that there is **no KOL session** — every
 * one of them is proved per request, over a nonce this server issued. The last
 * four came with §5, on 2026-09-05: two that name and unname a deputy, and two
 * reads, because a read of somebody else's pending queue is as much a thing to
 * be entitled to as a write.
 *
 * They stay a closed union rather than becoming a free string: the action is
 * compared, and a comparison against something a caller can invent is not a
 * comparison. What varies per request is the {@link ProofFields.subject}.
 */
export const PROOF_ACTIONS = [
  "alta de perfil",
  "agregar wallet",
  "crear cabal",
  "pedir entrar al cabal",
  "aceptar solicitud",
  "rechazar solicitud",
  "expulsar del cabal",
  "transferir el cabal",
  "nombrar co-líder",
  "revocar co-líder",
  // **Two of these are reads**, and they are here for the same reason the writes
  // are: with no KOL session, "show me my queue" has to prove authority exactly
  // as "accept this person" does. `docs/round-cabals.md` §5 decided the queue is
  // for the leader and the co-leaders, and the applicant sees only their own —
  // so both are questions somebody has to be entitled to ask.
  "ver solicitudes",
  "ver mi solicitud",
  // The eleventh, and the one that removed an unsigned write rather than adding
  // a signed one: the admin nominates a new leader for an orphaned cabal, and
  // **the nominee claims it here**. Before this existed the operator handed the
  // cabal over directly, which was the only cabal write nobody signed.
  "reclamar cabal",
  // The fourteenth, and the only one that **removes** a power from the operator.
  // Nothing in the product used to set `kol_wallet.status = 'withdrawn'`, so the
  // orphan condition the reassignment path repairs was one the operator could
  // manufacture by hand. Now withdrawing is signed, and signed by the wallet
  // being withdrawn — see `migrations/023`.
  "retirar wallet",
] as const;

export type ProofAction = (typeof PROOF_ACTIONS)[number];

export type ProofFields = {
  domain: string;
  /** As the wallet spells it. Compared through {@link canonicalAddress}, never raw. */
  address: string;
  chain: Chain;
  action: ProofAction;
  /**
   * **What the action is about**, when the action alone does not say.
   *
   * `aceptar solicitud` names a verb and no object: the same signature would
   * satisfy the verifier for every pending request in a cabal. The subject is
   * bound to the nonce server-side (`migrations/017`) so a proof cannot be
   * redirected, and it is rendered into the message so the person reading their
   * wallet prompt can see **whom** they are admitting.
   *
   * A KOL's `@handle` or a cabal's tag — never an address, on any surface,
   * and never a database id, which would tell the signer nothing.
   *
   * `undefined` for the two `/registro` actions: their subject is the wallet
   * doing the signing, and it is already on the line above.
   */
  subject?: string;
  /** Server-issued, single-use. Hex, 16–64 characters. */
  nonce: string;
  /** ISO 8601, absolute. */
  expiresAt: string;
};

/**
 * CAIP-2, not a bare chain id.
 *
 * `1` means Ethereum to an EVM wallet and nothing at all to a Solana one, and
 * a person reading a signing prompt should not have to know which namespace a
 * number belongs to. Solana has no numeric id anywhere, so a scheme that could
 * express only EVM would have to leave the chain out of exactly the case where
 * the text is the *only* place it can live.
 */
export function caip2(chain: Chain): string {
  return isEvm(chain) ? `eip155:${EVM_CHAIN_IDS[chain]}` : "solana:mainnet";
}

/**
 * The exact text a wallet is asked to sign, in neutral Spanish because a person
 * reads it.
 *
 * Spec §6's message with one line added: `Cadena:`. `docs/wallet-warnings.md`'s
 * house rule is that the chain is **stated, never inferred from whatever the
 * wallet happens to be set to** — and on Solana there is no chain field
 * anywhere else, so without this line a signature for one network is a
 * signature for all of them.
 *
 * The first two lines are plain sentences on purpose. A signing prompt that is
 * only fields is one people click through, and the sentence is what makes "I
 * did not agree to that" a checkable claim.
 */
export function proofMessage(fields: ProofFields): string {
  return [
    `${fields.domain} quiere verificar que controlas esta wallet.`,
    "Esto es una firma de mensaje. No mueve fondos ni aprueba ninguna transacción.",
    "",
    `Wallet: ${fields.address}`,
    `Cadena: ${caip2(fields.chain)}`,
    `Acción: ${fields.action}`,
    // Only when there is one, so the two `/registro` messages are byte-for-byte
    // what they were before this line existed: every signature already issued
    // against them still verifies.
    ...(fields.subject === undefined ? [] : [`Sobre: ${fields.subject}`]),
    `Nonce: ${fields.nonce}`,
    `Expira: ${fields.expiresAt}`,
  ].join("\n");
}

/**
 * The EIP-191 `personal_sign` digest:
 * `keccak256("\x19Ethereum Signed Message:\n" + byteLength + message)`.
 *
 * The length is a count of **bytes, not characters**. This message contains
 * `Acción` and `transacción`, so it is not ASCII and the two readings differ —
 * a verifier that used `message.length` would reject every real signature a
 * wallet produces, and one that hashed the message with no prefix at all would
 * accept a signature the wallet never showed anybody. Both are pinned as
 * negative tests.
 */
export function personalSignDigest(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix, 0);
  joined.set(body, prefix.length);
  return keccak_256(joined);
}

/** An address from an uncompressed public key: the low 20 bytes of its keccak. */
export function addressFromPublicKey(uncompressed: Uint8Array): string {
  // Drop the 0x04 prefix; the hash is over the 64 coordinate bytes.
  const hashed = keccak_256(uncompressed.subarray(1));
  return `0x${Buffer.from(hashed.subarray(12)).toString("hex")}`;
}

export type ProofRefusal =
  | "bad_message"
  | "malformed_signature"
  | "wrong_domain"
  | "wrong_chain"
  | "wrong_action"
  | "wrong_nonce"
  | "expired"
  | "address_mismatch";

export type ProofResult =
  | { ok: true; address: string; chain: Chain }
  | { ok: false; reason: ProofRefusal };

const NONCE = /^[0-9a-f]{16,64}$/;
/** 64 bytes of `r||s` plus the recovery byte, hex, `0x`-prefixed. */
const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * Whether `signature` is a signature of exactly the message these fields
 * produce, made by `fields.address`, on `expected.chain`, for `expected.nonce`.
 *
 * **The message is rebuilt here and never parsed from the client.** Accepting a
 * message string and checking that it "contains" the right nonce would let a
 * caller sign one sentence and have it read as another; rebuilding means the
 * only text that can verify is the text this server would have asked for.
 *
 * **Everything cheap is checked before any curve arithmetic**, so a payload
 * naming the wrong chain is refused as `wrong_chain` rather than as a signature
 * failure. A guard that fires on the wrong branch is not guarding what it
 * claims, and the negative tests assert the reason and not merely the refusal.
 *
 * **What this does not do: it does not spend the nonce.** Single use is a
 * property of a row, not of a pure function — see {@link consumeNonce} in
 * `wallet-proof-store.ts`, which burns it in the same statement that claims it.
 * Splitting them is deliberate: this half can be exhaustively tested with no
 * database, and the half that needs one has exactly one job.
 */
export function verifyProof(input: {
  signature: string;
  fields: ProofFields;
  expected: { domain: string; chain: Chain; action: ProofAction; nonce: string };
  nowMs: number;
}): ProofResult {
  const { fields, expected } = input;

  if (typeof fields.nonce !== "string" || !NONCE.test(fields.nonce)) {
    return { ok: false, reason: "bad_message" };
  }
  if (fields.domain !== expected.domain) return { ok: false, reason: "wrong_domain" };
  if (fields.chain !== expected.chain) return { ok: false, reason: "wrong_chain" };
  if (fields.action !== expected.action) return { ok: false, reason: "wrong_action" };
  if (fields.nonce !== expected.nonce) return { ok: false, reason: "wrong_nonce" };

  const expires = Date.parse(fields.expiresAt);
  if (!Number.isFinite(expires)) return { ok: false, reason: "bad_message" };
  // Both directions. Already expired is the obvious one; further ahead than the
  // window is the one that matters, because a client naming its own `Expira`
  // could otherwise mint a signature that never goes stale.
  if (expires <= input.nowMs) return { ok: false, reason: "expired" };
  if (expires - input.nowMs > PROOF_VALIDITY_MS) return { ok: false, reason: "expired" };

  // The address must be well-formed *for the chain it claims* before anything
  // is hashed. This is also what makes a Solana payload presented as EVM fail
  // as a shape rather than as a curve error.
  let canonical: string;
  try {
    canonical = canonicalAddress(fields.address, fields.chain);
  } catch {
    return { ok: false, reason: "bad_message" };
  }

  const message = proofMessage(fields);
  return isEvm(fields.chain)
    ? verifyEvm(input.signature, message, canonical, fields.chain)
    : verifySolana(input.signature, message, canonical, fields.chain);
}

function verifyEvm(
  signature: string,
  message: string,
  canonical: string,
  chain: Chain,
): ProofResult {
  const raw = signature.trim();
  if (!EVM_SIGNATURE.test(raw)) return { ok: false, reason: "malformed_signature" };

  const bytes = Buffer.from(raw.slice(2), "hex");
  // The last byte is `v`: 27/28 in the original scheme, 0/1 as some wallets
  // emit it. Anything else is not a recovery id.
  const v = bytes[64];
  const recovery = v === 27 || v === 28 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return { ok: false, reason: "malformed_signature" };

  let recovered: string;
  try {
    const digest = personalSignDigest(message);
    const sig = secp256k1.Signature.fromBytes(
      Uint8Array.from(bytes.subarray(0, 64)),
      "compact",
    ).addRecoveryBit(recovery);
    recovered = addressFromPublicKey(sig.recoverPublicKey(digest).toBytes(false));
  } catch {
    return { ok: false, reason: "malformed_signature" };
  }

  // Through canonicalAddress on both sides: EIP-55 and lowercase are one
  // address, and refusing on case would reject real wallets.
  if (canonicalAddress(recovered, chain) !== canonical) {
    return { ok: false, reason: "address_mismatch" };
  }
  return { ok: true, address: canonical, chain };
}

function verifySolana(
  signature: string,
  message: string,
  canonical: string,
  chain: Chain,
): ProofResult {
  // A Solana wallet signs the raw UTF-8 bytes: no prefix, no hash. There is no
  // recovery either, so the address *is* the public key rather than something
  // derived from the signature -- which is why this half compares nothing at
  // the end. Verifying against the claimed key is the check.
  let sig: Uint8Array;
  let key: Uint8Array;
  try {
    sig = bs58.decode(signature.trim());
    key = bs58.decode(canonical);
  } catch {
    return { ok: false, reason: "malformed_signature" };
  }
  if (sig.length !== 64) return { ok: false, reason: "malformed_signature" };
  if (key.length !== 32) return { ok: false, reason: "bad_message" };

  let valid: boolean;
  try {
    valid = ed25519.verify(sig, new TextEncoder().encode(message), key);
  } catch {
    // A malformed point or a non-canonical scalar throws rather than returning
    // false, and that is a bad signature, not a crash.
    return { ok: false, reason: "malformed_signature" };
  }
  return valid ? { ok: true, address: canonical, chain } : { ok: false, reason: "address_mismatch" };
}

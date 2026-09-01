/**
 * Issuing and burning the nonces that make a wallet proof single-use.
 *
 * The pure half of the contract lives in `wallet-proof.ts` and can be tested
 * with no database. This half has exactly one job, and it is the job that
 * cannot be done purely: making sure a nonce is accepted **once**.
 *
 * See `docs/wallet-proof.md` §2 rule 3 for why this exists at all.
 */

import { randomBytes } from "node:crypto";
import type { Chain } from "./chain";
import { blindIndex } from "./crypto";
import { query } from "./db";
import { PROOF_VALIDITY_MS, type ProofAction } from "./wallet-proof";

export type IssuedNonce = { nonce: string; expiresAt: string };

/**
 * A fresh nonce for one wallet and one action.
 *
 * 32 hex characters — 16 bytes of `randomBytes`, which is 128 bits and not a
 * number anyone guesses. The address is stored only as its blind index, so
 * this table never holds an address in plaintext (`SECURITY.md`).
 *
 * `expiresAt` is returned as an ISO string because it goes straight into the
 * signed message, and the message and the row must name the same instant. The
 * caller does not get to choose it: a client-chosen expiry is how a signature
 * becomes good for ever, which `verifyProof` also refuses independently.
 */
export async function issueNonce(
  address: string,
  chain: Chain,
  action: ProofAction,
): Promise<IssuedNonce> {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + PROOF_VALIDITY_MS).toISOString();
  await query(
    `INSERT INTO wallet_proof_nonce (nonce, address_hmac, chain, action, expires_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz)`,
    [nonce, blindIndex(address, "address"), chain, action, expiresAt],
  );
  return { nonce, expiresAt };
}

export type NonceClaim =
  | { ok: true; expiresAt: string }
  | { ok: false; reason: "wrong_nonce" | "expired" | "nonce_used" };

/**
 * Claims a nonce and burns it in the same statement.
 *
 * **One `UPDATE`, not a `SELECT` then an `UPDATE`.** A read followed by a write
 * is two concurrent requests away from accepting one nonce twice: both read it
 * unused, both proceed, and the second proof is admitted on a nonce the first
 * already spent. `UPDATE ... WHERE used_at IS NULL RETURNING` takes the row
 * lock and the decision together, so of two racing callers exactly one gets a
 * row back and the other gets none. That is asserted concurrently in the tests
 * rather than reasoned about here.
 *
 * The refusal is then diagnosed with a second, read-only query — reached only
 * on the failure path, so it costs nothing when a proof succeeds and it lets a
 * person debugging a failed registration tell "never issued" from "already
 * used" from "too late", which a bare `false` cannot.
 *
 * Bound to the address and the chain as well as the nonce: a nonce issued for
 * one wallet must not admit a proof from another, even a valid one.
 */
export async function consumeNonce(
  nonce: string,
  address: string,
  chain: Chain,
  action: ProofAction,
): Promise<NonceClaim> {
  const hmac = blindIndex(address, "address");
  const claimed = await query<{ expires_at: Date }>(
    `UPDATE wallet_proof_nonce
        SET used_at = now()
      WHERE nonce = $1 AND address_hmac = $2 AND chain = $3 AND action = $4
        AND used_at IS NULL AND expires_at > now()
      RETURNING expires_at`,
    [nonce, hmac, chain, action],
  );
  if (claimed[0]) return { ok: true, expiresAt: claimed[0].expires_at.toISOString() };

  const existing = await query<{ used_at: Date | null; expired: boolean }>(
    `SELECT used_at, expires_at <= now() AS expired
       FROM wallet_proof_nonce
      WHERE nonce = $1 AND address_hmac = $2 AND chain = $3 AND action = $4`,
    [nonce, hmac, chain, action],
  );
  // No row at all: never issued, issued to another wallet, or another action.
  // All three are one answer on purpose -- telling them apart would confirm to
  // a caller that some *other* wallet holds a given nonce.
  if (!existing[0]) return { ok: false, reason: "wrong_nonce" };
  if (existing[0].used_at !== null) return { ok: false, reason: "nonce_used" };
  return { ok: false, reason: "expired" };
}

/**
 * Removes nonces that can no longer authorise anything.
 *
 * `rate_limit` is the precedent: a table an unauthenticated caller can add rows
 * to needs something that removes them. A spent or expired nonce has no further
 * use — the proof it authorised is already recorded — so this keeps only the
 * live window plus a margin for a clock that disagrees.
 */
export async function pruneNonces(): Promise<number> {
  const removed = await query<{ nonce: string }>(
    `DELETE FROM wallet_proof_nonce
      WHERE expires_at < now() - interval '1 hour'
      RETURNING nonce`,
  );
  return removed.length;
}

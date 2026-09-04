import { aadFor, blindIndex, decrypt, encrypt } from "./crypto";
import { query, type TxQuery } from "./db";
import { PROOF_DOMAIN, proofMessage, verifyProof, type ProofAction } from "./wallet-proof";
import type { Chain } from "./chain";

/**
 * The signature that authorised an audit entry.
 *
 * `migrations/019` has the reasoning. The short version: the append-only
 * trigger and the hash chain are tripwires an operator can defeat, and a
 * signature is not — it was produced by a KOL's wallet over a single-use nonce,
 * so it can be neither forged from the database nor pointed at another action.
 *
 * This module is the only writer and the only reader. Nothing in a request path
 * calls it: signatures are written when an action is accepted and read when
 * somebody is checking whether an entry is genuine.
 */

export type StoredSignature = {
  auditId: string;
  nonce: string;
  chain: Chain;
  address: string;
  signature: string;
  expiresAt: string;
};

/**
 * Records the signature beside the entry it authorised, in the same
 * transaction as both. Three writes that must not come apart: a signature with
 * no entry proves nothing, and an entry whose signature failed to store is one
 * the account cannot defend later.
 */
export async function storeSignature(tx: TxQuery, s: StoredSignature): Promise<void> {
  await tx(
    `INSERT INTO audit_signature (audit_id, nonce, chain, address_hmac, address_enc,
                                  signature, expires_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [
      s.auditId,
      s.nonce,
      s.chain,
      blindIndex(s.address, "address"),
      // The same AAD shape `kol_wallet` uses, bound to this row: a ciphertext
      // lifted into another row does not decrypt.
      encrypt(s.address, aadFor("audit_signature", "address", s.auditId)),
      s.signature,
      s.expiresAt,
    ],
  );
}

export type SignatureCheck =
  | {
      ok: true;
      /** Rebuilt from the entry, not read from the signature row. */
      actor: string;
      action: string;
      nonce: string;
    }
  | { ok: false; reason: "no_signature" | "no_entry" | "bad_signature" | "wrong_signer" };

/**
 * Checks that the stored signature really authorises the entry it sits beside.
 *
 * **The message is rebuilt from the audit entry**, not from the signature row —
 * which is the whole point of the check. A verifier that rebuilt the text from
 * fields stored next to the signature would only prove the signature matches
 * itself; rebuilding it from `audit_log` proves the wallet signed *this actor
 * doing this action under this nonce*. If somebody edits the entry, the text
 * changes, and the signature stops verifying.
 *
 * `wrong_signer` is separate from `bad_signature`: a signature that verifies
 * against a different wallet than the KOL who is recorded as the actor is a
 * different failure — a genuine signature moved onto somebody else's entry —
 * and it is worth being able to tell them apart when reading an audit.
 */
export async function checkSignature(auditId: string): Promise<SignatureCheck> {
  const [entry] = await query<{
    actor: string;
    action: string;
    subject: string | null;
    nonce: string | null;
  }>("SELECT actor, action, subject, nonce FROM audit_log WHERE id = $1::uuid", [auditId]);
  if (!entry) return { ok: false, reason: "no_entry" };

  const [row] = await query<{
    nonce: string;
    chain: string;
    address_hmac: Buffer;
    address_enc: Buffer;
    signature: string;
    expires_at: Date;
  }>(
    `SELECT nonce, chain, address_hmac, address_enc, signature, expires_at
       FROM audit_signature WHERE audit_id = $1::uuid`,
    [auditId],
  );
  if (!row) return { ok: false, reason: "no_signature" };

  const address = decrypt(row.address_enc, aadFor("audit_signature", "address", auditId));

  // The wallet that signed must be the wallet this row says signed. Compared
  // through the blind index so the check never needs the address in clear on
  // both sides at once.
  if (!blindIndex(address, "address").equals(row.address_hmac)) {
    return { ok: false, reason: "wrong_signer" };
  }

  const fields = {
    domain: PROOF_DOMAIN,
    address,
    chain: row.chain as Chain,
    action: entry.action as ProofAction,
    subject: entry.subject ?? undefined,
    nonce: entry.nonce ?? "",
    expiresAt: row.expires_at.toISOString(),
  };

  const result = verifyProof({
    signature: row.signature,
    fields,
    expected: {
      domain: PROOF_DOMAIN,
      chain: fields.chain,
      action: fields.action,
      nonce: fields.nonce,
    },
    // The proof was checked for freshness when it was accepted; this is an
    // audit of what was signed, long after. Pinning `nowMs` to the moment the
    // message says it expired keeps `verifyProof` from failing an entry for
    // being old, which is not what is being asked here.
    nowMs: row.expires_at.getTime() - 1,
  });
  if (!result.ok) return { ok: false, reason: "bad_signature" };

  // Rebuilt from the entry: what the signature actually attests to.
  return { ok: true, actor: entry.actor, action: entry.action, nonce: fields.nonce };
}

/** The exact text a stored signature covers, for a person auditing by hand. */
export function signedTextFor(fields: Parameters<typeof proofMessage>[0]): string {
  return proofMessage(fields);
}

import { appendAudit } from "./audit";
import { storeSignature } from "./audit-signature";
import { blindIndex } from "./crypto";
import { withTransaction, type TxQuery } from "./db";
import { consumeNonce } from "./wallet-proof-store";
import { PROOF_DOMAIN, verifyProof, type ProofAction, type ProofFields } from "./wallet-proof";
import type { Chain } from "./chain";

/**
 * The six things a cabal leader can do, and the one gate all of them pass.
 *
 * `docs/round-cabals.md` §4: **no KOL session.** Authority is proved per
 * request over a nonce this server issued, exactly as `/registro` does — so
 * there is no cookie to steal, no CSRF surface and no logout to get wrong. The
 * whole class is absent rather than defended.
 *
 * ## The order of the gate, which is the security
 *
 * Every action runs the same five steps, in this order and inside one
 * transaction:
 *
 * 1. **Verify the signature** — pure, no database. A bad proof costs one
 *    `secp256k1`/`ed25519` check and never touches a row.
 * 2. **Burn the nonce**, bound to the subject. `consumeNonce` is an `UPDATE …
 *    WHERE used_at IS NULL` returning a row, so two concurrent requests cannot
 *    both spend it — the check and the write are one statement, which is what
 *    `docs/wallet-proof.md` §2.3 requires.
 * 3. **Resolve the signer to a KOL**, through the wallet's blind index. A
 *    signature proves a wallet; only this step turns it into a person.
 * 4. **Check the rule** — is this KOL the leader, is that KOL a member, does the
 *    tag exist. Last, because it is the only step that needs the state.
 * 5. **Do it, and append the audit entry with its signature**, in the same
 *    transaction. An action with no entry, or an entry for an action that
 *    rolled back, are both worse than either failing.
 *
 * **The nonce is burnt before the rule is checked**, and that is deliberate: a
 * proof that fails the rule is still spent. Otherwise a caller could probe the
 * state — "is @ana in this cabal?" — by replaying one signature against
 * different subjects until one is accepted, and each failure would cost them
 * nothing.
 *
 * ## Every refusal is one word, and the words are few
 *
 * `SECURITY.md`: a refusal never carries an address, a signature or a nonce.
 * And the four ways a proof can be wrong — never issued, wrong wallet, wrong
 * action, wrong subject — all answer `bad_proof`, because telling them apart
 * lets a caller map who holds what.
 */

export type ActionRefusal =
  | "bad_proof"
  | "unknown_wallet"
  | "not_leader"
  | "not_found"
  | "already_in_cabal"
  | "not_a_member"
  | "tag_taken"
  | "bad_input";

export type ActionResult<T> = { ok: true; value: T } | { ok: false; reason: ActionRefusal };

export type SignedRequest = {
  address: string;
  chain: Chain;
  signature: string;
  nonce: string;
  expiresAt: string;
  /** What the action is about, as it was signed. See `migrations/017`. */
  subject?: string;
};

/** The KOL a proof resolves to. */
export type Signer = { kolId: string; handle: string };

/**
 * Steps 1 to 3, shared by all six.
 *
 * Returns the signer and burns the nonce, or a refusal. **It does not know what
 * the action is about** beyond the subject it was handed — the rules live with
 * each action, because each one has a different rule.
 */
async function authorise(
  tx: TxQuery,
  action: ProofAction,
  request: SignedRequest,
  nowMs: number,
): Promise<ActionResult<Signer>> {
  const fields: ProofFields = {
    domain: PROOF_DOMAIN,
    address: request.address,
    chain: request.chain,
    action,
    subject: request.subject,
    nonce: request.nonce,
    expiresAt: request.expiresAt,
  };

  const proof = verifyProof({
    signature: request.signature,
    fields,
    expected: { domain: PROOF_DOMAIN, chain: request.chain, action, nonce: request.nonce },
    nowMs,
  });
  if (!proof.ok) return { ok: false, reason: "bad_proof" };

  const claim = await consumeNonce(
    request.nonce,
    proof.address,
    request.chain,
    action,
    request.subject,
  );
  if (!claim.ok) return { ok: false, reason: "bad_proof" };

  // A wallet proves control; the roster says whose it is. `status = 'active'`
  // because a wallet a KOL removed must stop authorising anything, and
  // `kol.status = 'approved'` because a suspended KOL is not acting on anything
  // (spec §9, the same rule the ranking applies).
  const [signer] = await tx<{ kol_id: string; x_handle: string }>(
    `SELECT k.id AS kol_id, k.x_handle
       FROM kol_wallet w
       JOIN kol k ON k.id = w.kol_id
      WHERE w.address_hmac = $1 AND w.status = 'active' AND k.status = 'approved'
      LIMIT 1`,
    [blindIndex(proof.address, "address")],
  );
  if (!signer) return { ok: false, reason: "unknown_wallet" };

  return { ok: true, value: { kolId: signer.kol_id, handle: signer.x_handle } };
}

/** Step 5: the entry and the signature that authorised it, in one transaction. */
async function record(
  tx: TxQuery,
  signer: Signer,
  action: ProofAction,
  request: SignedRequest,
  detail: { targetType: string; targetId: string; before?: unknown; after?: unknown },
): Promise<void> {
  const { id } = await appendAudit(tx, {
    actor: `@${signer.handle}`,
    action,
    subject: request.subject,
    targetType: detail.targetType,
    targetId: detail.targetId,
    before: detail.before,
    after: detail.after,
    nonce: request.nonce,
  });

  await storeSignature(tx, {
    auditId: id,
    nonce: request.nonce,
    chain: request.chain,
    address: request.address,
    signature: request.signature,
    expiresAt: request.expiresAt,
  });
}

const TAG = /^[A-Z]{3,4}$/;
const COLORS = new Set(["a", "b", "c", "d"]);

/**
 * A KOL creates a cabal and becomes its leader.
 *
 * The tag is claimed by inserting it: `cabal_tag_held` is a unique index over
 * the cabals that still hold one, so two requests racing for the same freed tag
 * are decided by the database and not by a read-then-write
 * (`migrations/016`).
 */
export async function createCabal(
  request: SignedRequest,
  input: { tag: string; name: string; color: string; xHandle?: string },
  nowMs = Date.now(),
): Promise<ActionResult<{ tag: string }>> {
  if (!TAG.test(input.tag) || !COLORS.has(input.color) || input.name.trim().length === 0) {
    return { ok: false, reason: "bad_input" };
  }

  return withTransaction(async (tx) => {
    const auth = await authorise(tx, "crear cabal", request, nowMs);
    if (!auth.ok) return auth;
    const signer = auth.value;

    // One cabal per KOL is `kol.cabal_id`'s shape, so leading one means being in
    // one: a KOL already in a cabal cannot create another.
    const [current] = await tx<{ cabal_id: string | null }>(
      "SELECT cabal_id FROM kol WHERE id = $1::uuid",
      [signer.kolId],
    );
    if (current?.cabal_id) return { ok: false, reason: "already_in_cabal" as const };

    const id = crypto.randomUUID();
    try {
      await tx(
        `INSERT INTO cabal (id, tag, name, color, x_handle, leader_kol_id, created_by)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, 'leader')`,
        [id, input.tag, input.name.trim(), input.color, input.xHandle ?? null, signer.kolId],
      );
    } catch {
      // The unique index decided it. Nothing else in this statement can fail on
      // a constraint, so the reason is not a guess.
      return { ok: false, reason: "tag_taken" as const };
    }
    await tx("UPDATE kol SET cabal_id = $1::uuid WHERE id = $2::uuid", [id, signer.kolId]);

    await record(tx, signer, "crear cabal", request, {
      targetType: "cabal",
      targetId: id,
      after: { tag: input.tag, name: input.name.trim(), color: input.color },
    });
    return { ok: true as const, value: { tag: input.tag } };
  });
}

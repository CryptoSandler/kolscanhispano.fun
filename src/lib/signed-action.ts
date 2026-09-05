import { appendAudit } from "./audit";
import { storeSignature } from "./audit-signature";
import { blindIndex } from "./crypto";
import { query, type TxQuery } from "./db";
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
 * Every action runs the same five steps, in this order:
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
 * 5. **Do it, and append the audit entry with its signature**, in one
 *    transaction. An action with no entry, or an entry for an action that
 *    rolled back, are both worse than either failing.
 *
 * **Steps 1 to 3 happen before that transaction opens, and steps 4 and 5 inside
 * it.** Two reasons, and they agree.
 *
 * The first is mechanical: `db.ts` runs the pool at `max: 1`, so a module-level
 * {@link query} issued from inside `withTransaction` waits for the one client
 * the transaction is already holding, and hangs until the connection timeout.
 * Burning the nonce is such a query.
 *
 * The second is the one worth keeping. Because the burn commits on its own
 * connection, **a nonce that reached the gate is spent whatever happens next** —
 * the rule refused it, or the process died between burning and writing. The
 * caller asks for another nonce and signs again, which costs one round trip;
 * the alternative is a signature that stays replayable after a failure nobody
 * has diagnosed yet. `DECISIONES.md` carries this, and a test kills the process
 * between the two halves to pin it.
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

export {
  CABAL_ACTIONS,
  isCabalAction,
  subjectFor,
  subjectForHandle,
  subjectForTag,
  type CabalAction,
} from "./cabal-subject";

/**
 * Every word a signed action can refuse with.
 *
 * **A list, not a bare union.** `action-contract.test.ts` checks its table of
 * action x precondition x refusal against this, and a table that agreed only
 * with a type would agree with something nobody kept up to date. Deriving the
 * type from the list is the same trick `PROOF_ACTIONS` uses, for the same reason.
 *
 * `SECURITY.md`: a refusal never carries an address, a signature or a nonce, and
 * the four ways a proof can be wrong all answer `bad_proof` — telling them apart
 * lets a caller map who holds what.
 */
export const ACTION_REFUSALS = [
  /** The proof is not good: never issued, wrong wallet, wrong action, wrong subject. */
  "bad_proof",
  /** A valid signature from a wallet no approved KOL holds. */
  "unknown_wallet",
  /** The signer does not lead the cabal this action is about. */
  "not_leader",
  /** No cabal with that tag, or no pending request from that KOL. */
  "not_found",
  /** The KOL this is about already belongs to a cabal. */
  "already_in_cabal",
  /** The KOL this is about is not in the signer's cabal. */
  "not_a_member",
  /** Somebody else holds the tag. Decided by `cabal_tag_held`, not by a read. */
  "tag_taken",
  /** A live request from this KOL to this cabal is already queued. */
  "already_requested",
  /** That KOL is already a deputy of this cabal. */
  "already_co_leader",
  /** Both co-leader slots are taken. `migrations/020` makes two a constraint. */
  "no_slot",
  /** That KOL is not a deputy, so there is nothing to revoke. */
  "not_a_co_leader",
  /** The nomination's seven days ran out. Nothing moved; the admin nominates again. */
  "expired",
  /**
   * The cabal is no longer orphaned — the old leader registered a wallet, or a
   * deputy appeared, in the days between the nomination and the claim. A repair
   * applied to something that is no longer broken is a seizure.
   */
  "not_orphaned",
  /**
   * The leader cannot be expelled from their own cabal. Separate from
   * `not_a_member` because it is not a fact about membership, and because a
   * cabal's leader is public — this reveals nothing a page does not.
   */
  "cannot_expel_leader",
  /** Malformed input, or a subject the signature does not cover. */
  "bad_input",
] as const;

export type ActionRefusal = (typeof ACTION_REFUSALS)[number];


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

/**
 * The KOL a proof resolves to, and the wallet it resolved *through*.
 *
 * `walletId` is here because `retirar wallet` acts on exactly that row — the
 * wallet that signed is the wallet being withdrawn — and a second lookup by
 * address would be a second place for "which wallet was this" to be answered
 * differently.
 */
export type Signer = { kolId: string; handle: string; walletId: string };

/**
 * Steps 1 to 3, shared by all six, and **outside the caller's transaction**.
 *
 * Returns the signer and burns the nonce, or a refusal. **It does not know what
 * the action is about** beyond the subject it was handed — the rules live with
 * each action, because each one has a different rule.
 */
export async function authorise(
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
  const [signer] = await query<{ kol_id: string; x_handle: string; wallet_id: string }>(
    `SELECT k.id AS kol_id, k.x_handle, w.id AS wallet_id
       FROM kol_wallet w
       JOIN kol k ON k.id = w.kol_id
      WHERE w.address_hmac = $1 AND w.status = 'active' AND k.status = 'approved'
      LIMIT 1`,
    [blindIndex(proof.address, "address")],
  );
  if (!signer) return { ok: false, reason: "unknown_wallet" };

  return {
    ok: true,
    value: { kolId: signer.kol_id, handle: signer.x_handle, walletId: signer.wallet_id },
  };
}

/** Step 5: the entry and the signature that authorised it, in one transaction. */
export async function record(
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

import { withTransaction } from "./db";
import { authorise, record, type ActionResult, type SignedRequest } from "./signed-action";

/**
 * What a KOL can do to their own wallets, signed.
 *
 * One action so far, and it exists to **take a power away from the operator**
 * rather than to give one to a KOL — `migrations/023` has the full argument.
 * The short version: `kol_wallet.status = 'withdrawn'` is the orphan condition
 * the whole cabal-reassignment path repairs, and until this existed it was a
 * value only the operator could write. That made the state they repair one they
 * could manufacture.
 */

/**
 * A KOL withdraws the wallet they are signing with.
 *
 * **The wallet that signs is the wallet withdrawn.** There is no subject and no
 * field naming a target, so the proof cannot be aimed at somebody else's wallet
 * even in principle — the `Wallet:` line of the signed message already says
 * which one, and the gate resolves it through the blind index.
 *
 * The effects are the ones spec §9 already gives a withdrawn wallet: it stops
 * being indexed, it stops counting, and — the part this action is really about —
 * **it stops authorising anything**, because `authorise` only resolves a signer
 * through a wallet whose status is `active`.
 *
 * ## The last wallet can be withdrawn, and that is a decision
 *
 * A KOL who withdraws their only wallet can no longer sign, so they can do
 * nothing further and any cabal they lead becomes an orphan. Refusing the last
 * one would prevent that — and would also mean **a compromised sole wallet
 * cannot be revoked**, which is the case this action exists for. A key you
 * cannot revoke is worse than a group that needs a nomination to repair, and the
 * nomination path is built and tested. So it is allowed, and it is written down
 * here rather than discovered.
 */
export async function withdrawWallet(
  request: SignedRequest,
  nowMs = Date.now(),
): Promise<ActionResult<{ handle: string; remaining: number }>> {
  // No subject: this action is about the signer's own wallet, and a request
  // carrying one would not match the nonce that was issued without one.
  if (request.subject !== undefined) return { ok: false, reason: "bad_input" };

  const auth = await authorise("retirar wallet", request, nowMs);
  if (!auth.ok) return auth;
  const signer = auth.value;

  return withTransaction(async (tx) => {
    // `status = 'active'` again, though the gate already required it: between
    // resolving the signer and this write, another request could have withdrawn
    // the same row. Zero rows back means it is already withdrawn, and the answer
    // is the same one the gate gives for a wallet that cannot authorise.
    const withdrawn = await tx<{ id: string }>(
      `UPDATE kol_wallet SET status = 'withdrawn', withdrawn_at = now()
        WHERE id = $1::uuid AND status = 'active'
        RETURNING id`,
      [signer.walletId],
    );
    if (withdrawn.length === 0) return { ok: false, reason: "unknown_wallet" as const };

    const [left] = await tx<{ remaining: string }>(
      `SELECT count(*)::text AS remaining FROM kol_wallet
        WHERE kol_id = $1::uuid AND status = 'active'`,
      [signer.kolId],
    );

    await record(tx, signer, "retirar wallet", request, {
      targetType: "kol_wallet",
      // The row's id, never the address: `SECURITY.md` keeps addresses out of
      // every table that gets read, and `audit_log` is read by the admin screen.
      targetId: signer.walletId,
      before: { status: "active" },
      after: { status: "withdrawn", remainingActive: Number(left.remaining) },
    });

    return {
      ok: true as const,
      value: { handle: signer.handle, remaining: Number(left.remaining) },
    };
  });
}

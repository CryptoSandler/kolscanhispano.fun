import { appendAudit } from "./audit";
import { withTransaction } from "./db";
import { ORPHAN_PREDICATE } from "./orphan-cabals";

/**
 * The operator nominates a new leader for an orphaned cabal. It decides nothing.
 *
 * `docs/round-reasignacion.md` §3 proposed this and left it at the door; the
 * owner opened it on 2026-09-05, and **the direct handover was deleted rather
 * than kept beside it.** There is no longer any way for the operator to move a
 * cabal on their own.
 *
 * ## What a nomination is, and what it is not
 *
 * It is a *standing offer to one named KOL*, good for seven days. It writes no
 * leader. The cabal stays orphaned, keeps its members, keeps its tag, keeps its
 * place in the ranking, and shows nothing publicly — because until somebody
 * signs, nothing has happened. An unclaimed nomination leaves the world exactly
 * as it found it, which is the safe direction for a mechanism whose whole
 * purpose is to repair a broken state.
 *
 * The cabal changes hands in {@link claimCabal}, against the same gate as every
 * other cabal action, when **the beneficiary proves a wallet**. That is the
 * point of the redesign: the outgoing leader cannot sign, but the incoming one
 * can, so "the operator quietly moved a group to an ally" stops being available
 * — the ally signs for it, over a nonce, in public.
 *
 * ## The two rules that survive from the direct version
 *
 * **Only an orphan can be nominated over**, checked against
 * {@link ORPHAN_PREDICATE} — the same SQL the admin screen lists orphans with,
 * not a second copy. And **the reason is mandatory and never published**: it
 * describes somebody's circumstances, and a public reason turns a repair into a
 * punishment.
 *
 * Neither closes the hole the round named: nothing in the product sets
 * `kol_wallet.status = 'withdrawn'`, so an operator can still manufacture an
 * orphan. What the claim adds is that manufacturing it is no longer enough —
 * they also need a KOL willing to sign for the result.
 */

/** Seven days. `migrations/022` argues the number; this is where it is applied. */
export const NOMINATION_DAYS = 7;

export type NominateRefusal =
  | "not_found"
  | "not_orphaned"
  | "reason_required"
  | "not_confirmed"
  | "unknown_kol"
  | "cannot_lead"
  | "already_in_cabal"
  /** A live nomination is outstanding. Two would be two people racing to sign. */
  | "already_nominated";

export type NominateResult =
  | { ok: true; tag: string | null; handle: string; expiresAt: string }
  | { ok: false; reason: NominateRefusal };

const MIN_REASON = 10;

export async function nominateCabal(input: {
  cabalId: string;
  handle: string;
  reason: string;
  confirmed: boolean;
  ipHash?: Buffer | null;
}): Promise<NominateResult> {
  if (!input.confirmed) return { ok: false, reason: "not_confirmed" };
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON) return { ok: false, reason: "reason_required" };
  const handle = input.handle.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { ok: false, reason: "unknown_kol" };

  return withTransaction(async (tx) => {
    const [cabal] = await tx<{
      id: string;
      tag: string | null;
      leader_handle: string | null;
      orphaned: boolean;
    }>(
      `SELECT c.id, c.tag, k.x_handle AS leader_handle, (${ORPHAN_PREDICATE}) AS orphaned
         FROM cabal c
         LEFT JOIN kol k ON k.id = c.leader_kol_id
        WHERE c.id = $1::uuid
          FOR UPDATE OF c`,
      [input.cabalId],
    );
    if (!cabal) return { ok: false, reason: "not_found" as const };
    if (!cabal.orphaned) return { ok: false, reason: "not_orphaned" as const };

    const [heir] = await tx<{ id: string; x_handle: string; cabal_id: string | null }>(
      `SELECT id, x_handle, cabal_id FROM kol
        WHERE x_handle = $1::citext AND status = 'approved'`,
      [handle],
    );
    if (!heir) return { ok: false, reason: "unknown_kol" as const };

    // A nominee with no active wallet could never claim it: there would be no
    // signature to make. Refusing here rather than letting them find out is the
    // difference between a refusal and a dead end.
    const [wallet] = await tx(
      "SELECT 1 AS one FROM kol_wallet WHERE kol_id = $1::uuid AND status = 'active'",
      [heir.id],
    );
    if (!wallet) return { ok: false, reason: "cannot_lead" as const };

    if (heir.cabal_id !== null && heir.cabal_id !== cabal.id) {
      return { ok: false, reason: "already_in_cabal" as const };
    }

    // An expired nomination is cancelled here rather than by a cron, because
    // this is the only path that needs the slot free and the clock cannot live
    // in the index (`migrations/016`, `migrations/022`).
    await tx(
      `UPDATE cabal_nomination SET status = 'cancelled'
        WHERE cabal_id = $1::uuid AND status = 'pending' AND expires_at <= now()`,
      [cabal.id],
    );

    const expiresAt = new Date(Date.now() + NOMINATION_DAYS * 86_400_000).toISOString();
    try {
      await tx(
        `INSERT INTO cabal_nomination (id, cabal_id, kol_id, reason, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)`,
        [crypto.randomUUID(), cabal.id, heir.id, reason, expiresAt],
      );
    } catch (error) {
      // `cabal_nomination_one_pending`. Somebody is already holding an offer on
      // this cabal, and two would be a race neither of them knew about.
      if ((error as { code?: string }).code !== "23505") throw error;
      return { ok: false, reason: "already_nominated" as const };
    }

    await appendAudit(tx, {
      actor: "admin",
      action: "cabal.nominate",
      subject: cabal.tag ?? cabal.id,
      targetType: "cabal",
      targetId: cabal.id,
      before: { leader: cabal.leader_handle === null ? null : `@${cabal.leader_handle}` },
      // The nomination, not a change of leader: `after` says who was offered it,
      // and the entry for the cabal actually changing hands is written by the
      // claim, with a signature beside it.
      after: { nominated: `@${heir.x_handle}`, reason, expiresAt },
      ipHash: input.ipHash ?? null,
    });

    return { ok: true as const, tag: cabal.tag, handle: heir.x_handle, expiresAt };
  });
}

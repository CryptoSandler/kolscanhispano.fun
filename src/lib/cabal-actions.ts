import { withTransaction, type TxQuery } from "./db";
import type { ProofAction } from "./wallet-proof";
import { ORPHAN_PREDICATE } from "./orphan-cabals";
import { COLORS, TAG, handleFromSubject } from "./cabal-subject";
import {
  authorise,
  record,
  type ActionResult,
  type SignedRequest,
} from "./signed-action";

/**
 * The eleven things a KOL can do to a cabal, each one signed.
 *
 * **The gate they all pass moved to `signed-action.ts`** when a fourteenth
 * action appeared that is not about cabals at all — `retirar wallet`. The order
 * of its five steps is the security and the reasoning lives there; this file is
 * now only the rules, which is what differs per action.
 */
export {
  CABAL_ACTIONS,
  isCabalAction,
  subjectFor,
  subjectForHandle,
  subjectForTag,
  type CabalAction,
} from "./cabal-subject";
export { ACTION_REFUSALS } from "./signed-action";
export type { ActionRefusal, ActionResult, SignedRequest, Signer } from "./signed-action";

/** `23505`: a unique index refused the row. Anything else is not ours to reinterpret. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}

type Cabal = {
  id: string;
  tag: string | null;
  name: string;
  leader_kol_id: string | null;
};

/**
 * The cabal the signer may act on, locked for the rest of the transaction.
 *
 * `FOR UPDATE` because two of these actions read the cabal and then write it —
 * a transfer and an expulsion of the co-leader both do — and two leaders' rows
 * racing would otherwise interleave into a state neither of them asked for. The
 * row lock is taken **before** {@link appendAudit}'s advisory lock in every
 * path, so the two can never be acquired in opposite orders.
 *
 * `role: "leader"` restricts it to the leader alone, which is what a transfer
 * needs: handing the cabal on is the one thing a co-leader may not do, because
 * it would let a deputy take the group from the person who appointed them.
 */
async function ledCabal(
  tx: TxQuery,
  kolId: string,
  role: "leader" | "either",
): Promise<Cabal | null> {
  // The deputies moved to their own table in `migrations/020`, because the cap
  // is two and two does not fit in a column. `EXISTS` rather than a join so the
  // row is still exactly one cabal and `FOR UPDATE` still locks exactly it.
  const deputy = `OR EXISTS (SELECT 1 FROM cabal_co_leader cl
                              WHERE cl.cabal_id = cabal.id AND cl.kol_id = $1::uuid)`;
  const [cabal] = await tx<Cabal>(
    `SELECT id, tag, name, leader_kol_id
       FROM cabal
      WHERE dissolved_at IS NULL
        AND (leader_kol_id = $1::uuid ${role === "either" ? deputy : ""})
      FOR UPDATE`,
    [kolId],
  );
  return cabal ?? null;
}

/** Is this KOL a deputy of this cabal? */
async function isCoLeader(tx: TxQuery, cabalId: string, kolId: string): Promise<boolean> {
  const [row] = await tx(
    "SELECT 1 AS one FROM cabal_co_leader WHERE cabal_id = $1::uuid AND kol_id = $2::uuid",
    [cabalId, kolId],
  );
  return row !== undefined;
}

type Member = { id: string; handle: string; cabal_id: string | null };

/** The approved KOL a subject names. Suspended and pending KOLs are not targets. */
async function kolByHandle(tx: TxQuery, handle: string): Promise<Member | null> {
  const [kol] = await tx<{ id: string; x_handle: string; cabal_id: string | null }>(
    `SELECT id, x_handle, cabal_id FROM kol WHERE x_handle = $1 AND status = 'approved'`,
    [handle],
  );
  return kol ? { id: kol.id, handle: kol.x_handle, cabal_id: kol.cabal_id } : null;
}

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
  input: { name: string; color: string; xHandle?: string },
  nowMs = Date.now(),
): Promise<ActionResult<{ tag: string }>> {
  // The tag **is** the subject: it is what the signer read in their wallet and
  // what the nonce is bound to. Taking it from a second field beside the proof
  // would let a caller sign for one tag and claim another, which is the exact
  // redirection `migrations/017` exists to close.
  const tag = request.subject ?? "";
  if (!TAG.test(tag) || !COLORS.has(input.color) || input.name.trim().length === 0) {
    return { ok: false, reason: "bad_input" };
  }

  const auth = await authorise("crear cabal", request, nowMs);
  if (!auth.ok) return auth;
  const signer = auth.value;

  return withTransaction(async (tx) => {

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
        [id, tag, input.name.trim(), input.color, input.xHandle ?? null, signer.kolId],
      );
    } catch (error) {
      // Only a unique violation is `tag_taken`. A catch-all here would report a
      // dropped connection as somebody else holding the tag, and the caller
      // would retry with a different tag for ever.
      if (!isUniqueViolation(error)) throw error;
      return { ok: false, reason: "tag_taken" as const };
    }
    await tx("UPDATE kol SET cabal_id = $1::uuid WHERE id = $2::uuid", [id, signer.kolId]);

    await record(tx, signer, "crear cabal", request, {
      targetType: "cabal",
      targetId: id,
      after: { tag, name: input.name.trim(), color: input.color },
    });
    return { ok: true as const, value: { tag } };
  });
}

/**
 * A KOL asks to join a cabal. The subject is the cabal's tag.
 *
 * This writes no membership: `cabal_request` is only the asking, and
 * `kol.cabal_id` changes when a leader accepts (`migrations/016`).
 */
export async function requestJoin(
  request: SignedRequest,
  nowMs = Date.now(),
): Promise<ActionResult<{ tag: string }>> {
  const tag = request.subject ?? "";
  if (!TAG.test(tag)) return { ok: false, reason: "bad_input" };

  const auth = await authorise("pedir entrar al cabal", request, nowMs);
  if (!auth.ok) return auth;
  const signer = auth.value;

  return withTransaction(async (tx) => {

    const [current] = await tx<{ cabal_id: string | null }>(
      "SELECT cabal_id FROM kol WHERE id = $1::uuid",
      [signer.kolId],
    );
    if (current?.cabal_id) return { ok: false, reason: "already_in_cabal" as const };

    const [cabal] = await tx<{ id: string }>(
      "SELECT id FROM cabal WHERE tag = $1 AND dissolved_at IS NULL",
      [tag],
    );
    if (!cabal) return { ok: false, reason: "not_found" as const };

    try {
      await tx(
        "INSERT INTO cabal_request (id, cabal_id, kol_id) VALUES ($1::uuid, $2::uuid, $3::uuid)",
        [crypto.randomUUID(), cabal.id, signer.kolId],
      );
    } catch (error) {
      // `cabal_request_one_pending`. A KOL may ask again after a rejection, so
      // this is only ever a second *live* ask.
      if (!isUniqueViolation(error)) throw error;
      return { ok: false, reason: "already_requested" as const };
    }

    await record(tx, signer, "pedir entrar al cabal", request, {
      targetType: "cabal",
      targetId: cabal.id,
      after: { status: "pending" },
    });
    return { ok: true as const, value: { tag } };
  });
}

/**
 * A leader or co-leader answers a pending request. The subject is the
 * applicant's `@handle`.
 *
 * One function for both answers because the gate, the lookup and the refusals
 * are identical and only the write differs — two copies would be two places for
 * "is this really my cabal's request" to drift.
 */
async function decideRequest(
  action: Extract<ProofAction, "aceptar solicitud" | "rechazar solicitud">,
  status: "accepted" | "rejected",
  request: SignedRequest,
  nowMs: number,
): Promise<ActionResult<{ handle: string }>> {
  const handle = handleFromSubject(request.subject);
  if (handle === null) return { ok: false, reason: "bad_input" };

  const auth = await authorise(action, request, nowMs);
  if (!auth.ok) return auth;
  const signer = auth.value;

  return withTransaction(async (tx) => {

    const cabal = await ledCabal(tx, signer.kolId, "either");
    if (!cabal) return { ok: false, reason: "not_leader" as const };

    const applicant = await kolByHandle(tx, handle);
    // A handle nobody holds and a handle with no pending request are one
    // answer: a leader learns nothing about KOLs who never asked.
    if (!applicant) return { ok: false, reason: "not_found" as const };

    const [pending] = await tx<{ id: string }>(
      `SELECT id FROM cabal_request
        WHERE cabal_id = $1::uuid AND kol_id = $2::uuid AND status = 'pending'
        FOR UPDATE`,
      [cabal.id, applicant.id],
    );
    if (!pending) return { ok: false, reason: "not_found" as const };

    // Re-read rather than trust the request row: the applicant may have joined
    // somewhere else while this one sat in the queue, and accepting would
    // silently move them.
    if (status === "accepted" && applicant.cabal_id) {
      return { ok: false, reason: "already_in_cabal" as const };
    }

    await tx(
      `UPDATE cabal_request
          SET status = $1, decided_at = now(), decided_by_kol_id = $2::uuid
        WHERE id = $3::uuid`,
      [status, signer.kolId, pending.id],
    );
    if (status === "accepted") {
      await tx("UPDATE kol SET cabal_id = $1::uuid WHERE id = $2::uuid", [cabal.id, applicant.id]);
    }

    await record(tx, signer, action, request, {
      targetType: "cabal_request",
      targetId: pending.id,
      before: { status: "pending", cabal: cabal.tag },
      after: { status, cabal: cabal.tag },
    });
    return { ok: true as const, value: { handle: applicant.handle } };
  });
}

export function acceptRequest(request: SignedRequest, nowMs = Date.now()) {
  return decideRequest("aceptar solicitud", "accepted", request, nowMs);
}

export function rejectRequest(request: SignedRequest, nowMs = Date.now()) {
  return decideRequest("rechazar solicitud", "rejected", request, nowMs);
}

/**
 * A leader or co-leader removes a member. The subject is the member's `@handle`.
 *
 * Two things it refuses on purpose: **the leader**, who cannot be expelled from
 * their own cabal by a deputy or by themselves, and **the signer**, because
 * leaving is a different act from being removed and the audit trail should not
 * record one as the other. Leaving is not in this batch.
 */
export async function expel(
  request: SignedRequest,
  nowMs = Date.now(),
): Promise<ActionResult<{ handle: string }>> {
  const handle = handleFromSubject(request.subject);
  if (handle === null) return { ok: false, reason: "bad_input" };

  const auth = await authorise("expulsar del cabal", request, nowMs);
  if (!auth.ok) return auth;
  const signer = auth.value;

  return withTransaction(async (tx) => {

    const cabal = await ledCabal(tx, signer.kolId, "either");
    if (!cabal) return { ok: false, reason: "not_leader" as const };

    const member = await kolByHandle(tx, handle);
    if (!member) return { ok: false, reason: "not_found" as const };
    if (member.cabal_id !== cabal.id) return { ok: false, reason: "not_a_member" as const };
    if (member.id === cabal.leader_kol_id) {
      return { ok: false, reason: "cannot_expel_leader" as const };
    }
    if (member.id === signer.kolId) return { ok: false, reason: "bad_input" as const };

    const wasCoLeader = await isCoLeader(tx, cabal.id, member.id);
    await tx("UPDATE kol SET cabal_id = NULL WHERE id = $1::uuid", [member.id]);
    // A deputy who is no longer a member cannot stay a deputy: the row would
    // point at somebody outside the group, and the slot would stay occupied by
    // them. Deleting frees the slot, which is the whole of the cap.
    if (wasCoLeader) {
      await tx("DELETE FROM cabal_co_leader WHERE cabal_id = $1::uuid AND kol_id = $2::uuid", [
        cabal.id,
        member.id,
      ]);
    }

    await record(tx, signer, "expulsar del cabal", request, {
      targetType: "kol",
      targetId: member.id,
      before: { cabal: cabal.tag, coLeader: wasCoLeader },
      after: { cabal: null },
    });
    return { ok: true as const, value: { handle: member.handle } };
  });
}

/**
 * The leader hands the cabal to another member. The subject is the new leader's
 * `@handle`.
 *
 * **Signed by the leader, and only by the leader.** `docs/round-cabals.md` §4
 * settles the other direction — a leader who has lost their wallet cannot sign
 * anything, so that case is the admin reassigning to the co-leader with a
 * reason in `audit_log`, and a cabal with no co-leader is orphaned. A co-leader
 * who could promote themselves here would make that decision meaningless: there
 * is nothing in the database that distinguishes "the leader is gone" from "the
 * deputy would like the group".
 *
 * The old leader stays a member. Losing the title is not losing the cabal.
 */
export async function transfer(
  request: SignedRequest,
  nowMs = Date.now(),
): Promise<ActionResult<{ handle: string }>> {
  const handle = handleFromSubject(request.subject);
  if (handle === null) return { ok: false, reason: "bad_input" };

  const auth = await authorise("transferir el cabal", request, nowMs);
  if (!auth.ok) return auth;
  const signer = auth.value;

  return withTransaction(async (tx) => {

    const cabal = await ledCabal(tx, signer.kolId, "leader");
    if (!cabal) return { ok: false, reason: "not_leader" as const };

    const heir = await kolByHandle(tx, handle);
    if (!heir) return { ok: false, reason: "not_found" as const };
    if (heir.cabal_id !== cabal.id) return { ok: false, reason: "not_a_member" as const };
    if (heir.id === signer.kolId) return { ok: false, reason: "bad_input" as const };

    // If the heir was a deputy, that seat empties **before** the leader changes:
    // `cabal_co_leader_distinct_trg` refuses a deputy who is also the leader,
    // and it is right to — the deputy of oneself is not a second person. Doing
    // it in the other order would leave a row the trigger would reject on its
    // next touch, which is a constraint violation waiting for an unrelated write.
    await tx("DELETE FROM cabal_co_leader WHERE cabal_id = $1::uuid AND kol_id = $2::uuid", [
      cabal.id,
      heir.id,
    ]);
    await tx("UPDATE cabal SET leader_kol_id = $1::uuid WHERE id = $2::uuid", [heir.id, cabal.id]);

    await record(tx, signer, "transferir el cabal", request, {
      targetType: "cabal",
      targetId: cabal.id,
      before: { leader: `@${signer.handle}` },
      after: { leader: `@${heir.handle}` },
    });
    return { ok: true as const, value: { handle: heir.handle } };
  });
}

/**
 * The leader names a deputy. The subject is the new deputy's `@handle`.
 *
 * `docs/round-cabals.md` §5, decided 2026-09-05: **the leader appoints, and the
 * cap is two.** Only the leader — a deputy who could name deputies would make
 * the cap a formality, since two of them could keep naming each other's
 * replacements, and it would make "who delegated this authority" unanswerable.
 *
 * **The slot is claimed by inserting it.** `cabal_co_leader_slot` is a unique
 * index over `(cabal_id, slot)`, so a third appointment has nowhere to go and
 * the database is what says so. Counting rows here and refusing at two is a
 * read-then-write, and two appointments arriving together both read one.
 */
export async function appointCoLeader(
  request: SignedRequest,
  nowMs = Date.now(),
): Promise<ActionResult<{ handle: string; slot: number }>> {
  const handle = handleFromSubject(request.subject);
  if (handle === null) return { ok: false, reason: "bad_input" };

  const auth = await authorise("nombrar co-líder", request, nowMs);
  if (!auth.ok) return auth;
  const signer = auth.value;

  return withTransaction(async (tx) => {
    const cabal = await ledCabal(tx, signer.kolId, "leader");
    if (!cabal) return { ok: false, reason: "not_leader" as const };

    const deputy = await kolByHandle(tx, handle);
    if (!deputy) return { ok: false, reason: "not_found" as const };
    if (deputy.cabal_id !== cabal.id) return { ok: false, reason: "not_a_member" as const };
    // The leader is not their own deputy. The trigger says so too; this says it
    // with a word the caller can act on instead of a constraint violation.
    if (deputy.id === signer.kolId) return { ok: false, reason: "bad_input" as const };
    if (await isCoLeader(tx, cabal.id, deputy.id)) {
      return { ok: false, reason: "already_co_leader" as const };
    }

    // The lowest free slot, so a revoke followed by an appointment reuses the
    // seat rather than leaving a hole that makes the cap read as one.
    const taken = await tx<{ slot: number }>(
      "SELECT slot FROM cabal_co_leader WHERE cabal_id = $1::uuid",
      [cabal.id],
    );
    const slot = [1, 2].find((n) => !taken.some((row) => row.slot === n));
    if (slot === undefined) return { ok: false, reason: "no_slot" as const };

    try {
      await tx(
        `INSERT INTO cabal_co_leader (cabal_id, kol_id, slot, named_by_kol_id)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid)`,
        [cabal.id, deputy.id, slot, signer.kolId],
      );
    } catch (error) {
      // The slot index decided a race this transaction could not see, or the
      // KOL is already a deputy somewhere. Both are the same answer to a caller.
      if (!isUniqueViolation(error)) throw error;
      return { ok: false, reason: "no_slot" as const };
    }

    await record(tx, signer, "nombrar co-líder", request, {
      targetType: "kol",
      targetId: deputy.id,
      after: { cabal: cabal.tag, slot },
    });
    return { ok: true as const, value: { handle: deputy.handle, slot } };
  });
}

/**
 * The leader unnames a deputy. The subject is the deputy's `@handle`.
 *
 * They stay a member: losing the delegation is not losing the cabal, which is
 * the same distinction {@link transfer} draws for the leader.
 */
export async function revokeCoLeader(
  request: SignedRequest,
  nowMs = Date.now(),
): Promise<ActionResult<{ handle: string }>> {
  const handle = handleFromSubject(request.subject);
  if (handle === null) return { ok: false, reason: "bad_input" };

  const auth = await authorise("revocar co-líder", request, nowMs);
  if (!auth.ok) return auth;
  const signer = auth.value;

  return withTransaction(async (tx) => {
    const cabal = await ledCabal(tx, signer.kolId, "leader");
    if (!cabal) return { ok: false, reason: "not_leader" as const };

    const deputy = await kolByHandle(tx, handle);
    if (!deputy) return { ok: false, reason: "not_found" as const };

    const removed = await tx<{ slot: number }>(
      `DELETE FROM cabal_co_leader
        WHERE cabal_id = $1::uuid AND kol_id = $2::uuid
        RETURNING slot`,
      [cabal.id, deputy.id],
    );
    if (removed.length === 0) return { ok: false, reason: "not_a_co_leader" as const };

    await record(tx, signer, "revocar co-líder", request, {
      targetType: "kol",
      targetId: deputy.id,
      before: { cabal: cabal.tag, slot: removed[0].slot },
      after: { cabal: cabal.tag, slot: null },
    });
    return { ok: true as const, value: { handle: deputy.handle } };
  });
}

/** One row of a cabal's pending queue, as the leader's panel shows it. */
export type PendingRequest = { handle: string; requestedAt: string };

/**
 * The pending queue, for the leader and the deputies and nobody else.
 *
 * `docs/round-cabals.md` §5: **never public.** Showing who asked to join
 * publishes a rejection — a KOL who was turned down would be visible to anyone
 * who looked — and that cannot be taken back. So this is a signed read, proved
 * exactly as a write is, and it answers `not_leader` to everybody else.
 *
 * **It costs a wallet prompt per panel load**, and that is the price of
 * §4's *no KOL session*, not an accident of this handler: there is nothing that
 * remembers a leader is a leader between two requests.
 *
 * The audit entry is written for a read, deliberately. Reading who asked to join
 * a group is the kind of access an account should be able to show later, and the
 * nonce was burnt either way — an action with no entry would be the only spent
 * proof in the system with nothing to point at.
 */
export async function readRequests(
  request: SignedRequest,
  nowMs = Date.now(),
): Promise<ActionResult<{ tag: string | null; pending: PendingRequest[] }>> {
  const tag = request.subject ?? "";
  if (!TAG.test(tag)) return { ok: false, reason: "bad_input" };

  const auth = await authorise("ver solicitudes", request, nowMs);
  if (!auth.ok) return auth;
  const signer = auth.value;

  return withTransaction(async (tx) => {
    const cabal = await ledCabal(tx, signer.kolId, "either");
    // Bound to the cabal the signer actually leads, not to the tag they typed:
    // the subject is what they signed, so a leader asking about somebody else's
    // cabal is refused rather than answered about their own.
    if (!cabal || cabal.tag !== tag) return { ok: false, reason: "not_leader" as const };

    const pending = await tx<{ x_handle: string; requested_at: Date }>(
      `SELECT k.x_handle, r.requested_at
         FROM cabal_request r
         JOIN kol k ON k.id = r.kol_id
        WHERE r.cabal_id = $1::uuid AND r.status = 'pending'
        ORDER BY r.requested_at ASC`,
      [cabal.id],
    );

    await record(tx, signer, "ver solicitudes", request, {
      targetType: "cabal",
      targetId: cabal.id,
      // The count, never the handles: an audit entry that listed who had asked
      // would republish inside `audit_log` the thing this read exists to keep
      // narrow.
      after: { pending: pending.length },
    });
    return {
      ok: true as const,
      value: {
        tag: cabal.tag,
        pending: pending.map((row) => ({
          handle: row.x_handle,
          requestedAt: row.requested_at.toISOString(),
        })),
      },
    };
  });
}

/**
 * An applicant's own request, and only their own. The subject is the cabal's tag.
 *
 * `docs/round-cabals.md` §5: the applicant sees the status of theirs. Not the
 * queue, not their position in it, not who else asked — those are the leader's
 * to see, and a position in a queue is a fact about the other people in it.
 *
 * `not_found` for a cabal that does not exist and for one this KOL never asked,
 * because telling them apart would let anybody enumerate cabals.
 */
export async function readOwnRequest(
  request: SignedRequest,
  nowMs = Date.now(),
): Promise<ActionResult<{ tag: string; status: string; decidedAt: string | null }>> {
  const tag = request.subject ?? "";
  if (!TAG.test(tag)) return { ok: false, reason: "bad_input" };

  const auth = await authorise("ver mi solicitud", request, nowMs);
  if (!auth.ok) return auth;
  const signer = auth.value;

  return withTransaction(async (tx) => {
    // The most recent, because a rejection may be followed by a fresh ask
    // (`cabal_request_one_pending` only constrains the live one).
    const [own] = await tx<{ status: string; decided_at: Date | null }>(
      `SELECT r.status, r.decided_at
         FROM cabal_request r
         JOIN cabal c ON c.id = r.cabal_id
        WHERE c.tag = $1 AND r.kol_id = $2::uuid
        ORDER BY r.requested_at DESC
        LIMIT 1`,
      [tag, signer.kolId],
    );
    if (!own) return { ok: false, reason: "not_found" as const };

    // No audit entry. This reads one row the signer wrote about themselves, and
    // an account of "@ana asked whether @ana was accepted" is noise that makes
    // the entries that matter harder to find.
    return {
      ok: true as const,
      value: {
        tag,
        status: own.status,
        decidedAt: own.decided_at ? own.decided_at.toISOString() : null,
      },
    };
  });
}

/**
 * The nominee claims an orphaned cabal. The subject is the cabal's tag.
 *
 * **This is the act that removed an unsigned write from the system.** Until
 * 2026-09-05 the operator handed an orphaned cabal to its new leader directly,
 * and it was the only cabal mutation nobody signed — `docs/round-reasignacion.md`
 * §1 has the argument against it, and §3 proposed this instead. The outgoing
 * leader still cannot sign; the incoming one can, and now must.
 *
 * `nominateCabal` writes a standing offer and changes nothing else. Everything
 * that actually moves — the leader, the membership, the public notice — happens
 * here, behind the same gate as every other cabal action: verify, burn the
 * nonce, resolve the wallet to a KOL, check the rule, act and record. The audit
 * entry gets a **signature beside it**, which the direct version could never
 * have had.
 *
 * ## The rule, and why it is re-checked
 *
 * The cabal must **still be orphaned at the moment of the claim**, not merely
 * when the admin nominated. Seven days is long enough for the original leader to
 * register a new wallet, or for a deputy to appear — and if either happened, the
 * repair is not needed and must not be applied over a cabal that healed itself.
 */
export async function claimCabal(
  request: SignedRequest,
  nowMs = Date.now(),
): Promise<ActionResult<{ tag: string; reassignedAt: string }>> {
  const tag = request.subject ?? "";
  if (!TAG.test(tag)) return { ok: false, reason: "bad_input" };

  const auth = await authorise("reclamar cabal", request, nowMs);
  if (!auth.ok) return auth;
  const signer = auth.value;

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
        WHERE c.tag = $1
          FOR UPDATE OF c`,
      [tag],
    );
    if (!cabal) return { ok: false, reason: "not_found" as const };

    // The offer, and it has to be this signer's: a nomination naming somebody
    // else is not one this KOL can act on, and it answers the same as no
    // nomination at all so that nobody can probe who was offered a cabal.
    const [nomination] = await tx<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM cabal_nomination
        WHERE cabal_id = $1::uuid AND kol_id = $2::uuid AND status = 'pending'
        FOR UPDATE`,
      [cabal.id, signer.kolId],
    );
    // A second claim lands here: the first one set `status = 'claimed'`, so
    // there is no pending row left and this is `not_found`, not a double write.
    if (!nomination) return { ok: false, reason: "not_found" as const };
    if (nomination.expires_at.getTime() <= nowMs) {
      // Cancelled on the way out, so the slot frees for a fresh nomination
      // without waiting for the admin to nominate over it.
      await tx("UPDATE cabal_nomination SET status = 'cancelled' WHERE id = $1::uuid", [
        nomination.id,
      ]);
      return { ok: false, reason: "expired" as const };
    }

    // Seven days is long enough for the cabal to have healed itself — the old
    // leader registering a wallet, or a deputy appearing. A repair applied to
    // something that is no longer broken is just a seizure.
    if (!cabal.orphaned) return { ok: false, reason: "not_orphaned" as const };

    const [current] = await tx<{ cabal_id: string | null }>(
      "SELECT cabal_id FROM kol WHERE id = $1::uuid",
      [signer.kolId],
    );
    if (current?.cabal_id !== null && current?.cabal_id !== cabal.id) {
      return { ok: false, reason: "already_in_cabal" as const };
    }

    // If they sat in a deputy slot it goes first: the trigger refuses a deputy
    // who is also the leader. (A cabal with a deputy is not an orphan, so this
    // can only be reached if the row appeared after the orphan test — the lock
    // makes that impossible, and the delete costs nothing to keep correct.)
    await tx("DELETE FROM cabal_co_leader WHERE cabal_id = $1::uuid AND kol_id = $2::uuid", [
      cabal.id,
      signer.kolId,
    ]);

    const [updated] = await tx<{ reassigned_at: Date }>(
      `UPDATE cabal
          SET leader_kol_id = $1::uuid,
              reassigned_to_kol_id = $1::uuid,
              reassigned_at = now()
        WHERE id = $2::uuid
        RETURNING reassigned_at`,
      [signer.kolId, cabal.id],
    );
    await tx("UPDATE kol SET cabal_id = $1::uuid WHERE id = $2::uuid", [cabal.id, signer.kolId]);
    await tx(
      "UPDATE cabal_nomination SET status = 'claimed', claimed_at = now() WHERE id = $1::uuid",
      [nomination.id],
    );

    // Through `record`, so this one carries a signature: the whole reason the
    // redesign happened.
    await record(tx, signer, "reclamar cabal", request, {
      targetType: "cabal",
      targetId: cabal.id,
      before: { leader: cabal.leader_handle === null ? null : `@${cabal.leader_handle}` },
      after: { leader: `@${signer.handle}` },
    });

    return {
      ok: true as const,
      value: { tag, reassignedAt: updated.reassigned_at.toISOString() },
    };
  });
}

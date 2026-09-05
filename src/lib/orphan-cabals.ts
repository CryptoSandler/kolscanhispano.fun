import { query } from "./db";

/**
 * Cabals nobody can act on: the leader cannot sign and there is no deputy.
 *
 * `docs/round-cabals.md` §4 made `cabal.leader_kol_id` nullable **on purpose** —
 * that is the orphan state, and §5.1 (2026-09-05) closed how it gets out of it:
 * **only by an admin reassignment, recorded in `audit_log`.** No timer, no
 * self-promotion. `transfer` refuses a deputy for the reason that decision
 * rests on — nothing in the database tells "the leader is gone" from "the deputy
 * would like the group".
 *
 * Which leaves one obligation: **an orphan has to be visible without anybody
 * going looking for it.** A state that only resolves by hand, and that nothing
 * surfaces, is a state that resolves when somebody complains.
 *
 * ## Three ways to be orphaned, and they are not the same fact
 *
 * A leader is unable to act if any of these holds, and the reason is reported
 * rather than flattened, because what the admin should do differs:
 *
 * - **`sin líder`** — `leader_kol_id IS NULL`. Already reassigned away, or
 *   seeded by the operator before leaders existed.
 * - **`líder sin wallet activa`** — every wallet withdrawn. This is the case §4
 *   was actually about: they cannot produce a signature, so no action of theirs
 *   can pass the gate.
 * - **`líder no aprobado`** — suspended or reverted to pending. The gate refuses
 *   them too (`authorise` requires `kol.status = 'approved'`), so the cabal is
 *   just as stuck, but the fix is probably a status and not a new leader.
 *
 * A dissolved cabal is not an orphan: it is finished, and its tag is on the
 * thirty-day clock in `release-cabal-tags.ts`.
 */
/**
 * **The one definition of "orphaned", as SQL.**
 *
 * Read by the list below and by `reassign-cabal.ts`, which refuses to touch a
 * cabal that does not satisfy it. Two copies of this predicate would be two
 * definitions, and the day they disagreed the admin would be able to reassign
 * something the screen never called an orphan — which is exactly the power the
 * round argued must not exist.
 *
 * `c` is the `cabal` alias and `k` the `kol` alias of its leader.
 */
export const ORPHAN_PREDICATE = `
  c.dissolved_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM cabal_co_leader cl WHERE cl.cabal_id = c.id)
  AND (
    c.leader_kol_id IS NULL
    OR k.status <> 'approved'
    OR NOT EXISTS (
      SELECT 1 FROM kol_wallet w WHERE w.kol_id = k.id AND w.status = 'active'
    )
  )`;

export type OrphanCabal = {
  id: string;
  tag: string | null;
  name: string;
  /** The leader who cannot act, when there is one at all. */
  leaderHandle: string | null;
  reason: "sin líder" | "líder sin wallet activa" | "líder no aprobado";
  /** How many KOLs are in it — the stakes of leaving it stuck. */
  members: number;
};

export async function readOrphanCabals(): Promise<OrphanCabal[]> {
  const rows = await query<{
    id: string;
    tag: string | null;
    name: string;
    leader_handle: string | null;
    reason: OrphanCabal["reason"];
    members: string;
  }>(
    `SELECT c.id,
            c.tag,
            c.name,
            k.x_handle AS leader_handle,
            CASE
              WHEN c.leader_kol_id IS NULL   THEN 'sin líder'
              WHEN k.status <> 'approved'    THEN 'líder no aprobado'
              ELSE 'líder sin wallet activa'
            END AS reason,
            (SELECT count(*) FROM kol m WHERE m.cabal_id = c.id) AS members
       FROM cabal c
       LEFT JOIN kol k ON k.id = c.leader_kol_id
      WHERE ${ORPHAN_PREDICATE}
      ORDER BY c.tag NULLS LAST, c.name`,
  );

  return rows.map((row) => ({
    id: row.id,
    tag: row.tag,
    name: row.name,
    leaderHandle: row.leader_handle,
    reason: row.reason,
    members: Number(row.members),
  }));
}

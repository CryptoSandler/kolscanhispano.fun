import { isAdmin } from "@/lib/admin";
import { readOrphanCabals } from "@/lib/orphan-cabals";

export const runtime = "nodejs";

/**
 * `GET /api/admin/cabal` — the cabals nobody can act on.
 *
 * `docs/round-cabals.md` §5.1 closed the orphan question on 2026-09-05: an
 * orphan is resolved **only** by an admin reassignment with an `audit_log`
 * entry — no timer, no self-promotion. A state that resolves only by hand and
 * that nothing surfaces is a state that resolves when somebody complains, so
 * this is the surfacing.
 *
 * **Read-only, and the list is the whole of it.** `docs/padron.md` §4 still says
 * `/admin` does not edit cabals, and that stays true: reassigning is not built,
 * so no button pretends it is (`DESIGN.md`'s last Don't). What this changes is
 * that the state is visible instead of being something to go looking for.
 *
 * No address on the wire — a handle, a tag and a count.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAdmin(request.headers.get("authorization"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json({ orphans: await readOrphanCabals() });
}

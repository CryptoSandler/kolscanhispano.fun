import { isAdmin } from "@/lib/admin";
import { clientIp, ipHash, rateLimited } from "@/lib/rate-limit";
import { nominateCabal } from "@/lib/nominate-cabal";

export const runtime = "nodejs";

/**
 * `POST /api/admin/cabal/reassign` — the operator hands an orphaned cabal on.
 *
 * `docs/round-reasignacion.md` is the round; §3 is what it concluded. The whole
 * of the argument is in one precondition, and it lives in `nominate-cabal.ts`
 * rather than here: **a cabal that is not orphaned cannot be reassigned**,
 * checked against the same SQL the admin screen lists orphans with.
 *
 * This route adds the two things that are a route's business — the admin gate
 * and the shape of the request — and nothing else. The confirmation and the
 * reason are validated in the handler rather than here: a caller reaching this
 * with `curl` gets the same refusals as the screen, because a rule enforced only
 * in a form is not enforced.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isAdmin(request.headers.get("authorization"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Rate-limited even behind the token: it is the one write that moves a group
  // between people, and a loop against it is worth bounding whoever holds the
  // token.
  const limited = await rateLimited(request, "cabal-action");
  if (limited) return limited;

  let body: { cabalId?: unknown; handle?: unknown; reason?: unknown; confirmed?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  if (typeof body.cabalId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.cabalId)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (typeof body.handle !== "string" || typeof body.reason !== "string") {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await nominateCabal({
    cabalId: body.cabalId,
    handle: body.handle,
    reason: body.reason,
    confirmed: body.confirmed === true,
    // The same keyed digest `rate_limit` uses, never an address: spec §8 makes
    // an IP personal data.
    ipHash: ipHash(clientIp(request)),
  });

  if (result.ok) return Response.json(result, { status: 200 });
  const status =
    result.reason === "not_found" ? 404 : result.reason === "not_orphaned" ? 409 : 400;
  return Response.json({ error: result.reason }, { status });
}

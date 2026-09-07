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
  /*
    **El límite va antes del token, y con bucket propio.**

    Dos correcciones del 2026-09-07, las dos encontradas por
    `admin-limits.test.ts`:

    - Usaba `cabal-action`, que es el bucket **público** del panel de cabales.
      Compartirlo significa que quien barra la ruta pública deja sin cupo al
      admin — la forma más silenciosa de negarle el servicio a la persona que
      administra el sitio.
    - Corría después de `isAdmin`, así que un 401 no costaba nada y se podía
      intentar adivinar el token todo el día. En una ruta pública ese orden es
      el correcto; acá lo que hay que encarecer **es** el 401.
  */
  const limited = await rateLimited(request, "admin-write");
  if (limited) return limited;

  if (!isAdmin(request.headers.get("authorization"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

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

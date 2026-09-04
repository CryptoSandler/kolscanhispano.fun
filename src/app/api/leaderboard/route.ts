import { parseFiat, readLeaderboard } from "@/lib/leaderboard";
import { rateLimited } from "@/lib/rate-limit";
import { resolveWindow } from "@/lib/windows";

export const runtime = "nodejs";
// The window is relative to the current instant and the rows behind it change
// as the replay worker runs; there is nothing here to prerender.
export const dynamic = "force-dynamic";

/**
 * Spec §2: the ranked realized PnL, `Diario / Semanal / Mensual`.
 *
 * **The ranking is always sorted by SOL since 2026-09-02**, and `?unit` no
 * longer changes a single row of the answer — it names the currency a *page*
 * prints in parentheses, and this endpoint publishes `realizedSol` and
 * `realizedUsd` both. The peso is not in the payload on purpose: it is a
 * conversion at a rate with a date on it (`docs/round-ars.md`), and baking one
 * into a response would publish that rate without its caveat.
 *
 * **The contract changed, and it is worth saying plainly**: a caller who sent
 * `?unit=usd` used to get a USD-ordered ranking and now gets the SOL-ordered
 * one. That ordering left the product with the toggle that expressed it.
 *
 * Both parameters are still whitelisted, and an unrecognised value is a `400`
 * rather than a fallback. `?unit=eur` answered with a `200` is a wrong answer
 * the caller has no way to notice — and `?unit=sol`, which was valid until
 * this change, is now exactly such a value: it fails loudly here while the
 * page quietly falls back, which is the split those two surfaces have always
 * had.
 *
 * The parameter is never echoed into the response: it reaches logs and error
 * pages, and the shape of what a caller sent is not information this endpoint
 * owes them — the same rule `/api/feed` follows for a malformed cursor.
 *
 * There is no `ETag` here, unlike the feed. This route is not polled: the page
 * renders it once and a toggle is a fresh navigation, so a validator would buy
 * nothing and would have to be kept honest for free.
 *
 * Rate limited before anything is parsed, for the reason `/api/feed` gives:
 * nothing caches these responses, so every repeat is a real read of the
 * derived tables.
 */
export async function GET(request: Request): Promise<Response> {
  const limited = await rateLimited(request, "leaderboard");
  if (limited) return limited;

  const url = new URL(request.url);
  const params = url.searchParams;

  /*
    **A published calendar name earns a 308 here too, not a 400.**

    `?window=diario` was a documented URL of this API for weeks, and a caller
    holding one is not making a bad request — the window was renamed under them.
    A `308` preserves the method and the body and tells a client, once, where the
    value went; a `400` would make every one of those callers debug a query
    string that used to be right.

    An unrecognised value is still a `400`: `?window=anual` never existed, and a
    program asking for it should learn that rather than read a `1D` figure under
    a label it chose.
  */
  const resolved = resolveWindow(params.get("window"));
  if (resolved !== null && typeof resolved === "object") {
    params.set("window", resolved.redirectTo);
    return Response.redirect(url.toString(), 308);
  }
  const window = resolved;
  const fiat = parseFiat(params.get("unit"));
  if (window === null || fiat === null) return new Response("bad request", { status: 400 });

  const leaderboard = await readLeaderboard({ window });

  return new Response(JSON.stringify(leaderboard), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

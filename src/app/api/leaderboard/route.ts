import { parseFiat, readLeaderboard } from "@/lib/leaderboard";
import { rateLimited } from "@/lib/rate-limit";
import { parseWindow } from "@/lib/windows";

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

  const params = new URL(request.url).searchParams;
  const window = parseWindow(params.get("window"));
  const fiat = parseFiat(params.get("unit"));
  if (window === null || fiat === null) return new Response("bad request", { status: 400 });

  const leaderboard = await readLeaderboard({ window });

  return new Response(JSON.stringify(leaderboard), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

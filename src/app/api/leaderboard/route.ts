import { parseUnit, readLeaderboard } from "@/lib/leaderboard";
import { rateLimited } from "@/lib/rate-limit";
import { parseWindow } from "@/lib/windows";

export const runtime = "nodejs";
// The window is relative to the current instant and the rows behind it change
// as the replay worker runs; there is nothing here to prerender.
export const dynamic = "force-dynamic";

/**
 * Spec §2: the ranked realized PnL, `Diario / Semanal / Mensual` and
 * `SOL / USD`.
 *
 * Both parameters are whitelisted, and an unrecognised value is a `400` rather
 * than a fallback to the default. A `?unit=eur` answered with a SOL ranking is
 * a wrong answer delivered with a `200`, and the caller has no way to notice.
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
  const unit = parseUnit(params.get("unit"));
  if (window === null || unit === null) return new Response("bad request", { status: 400 });

  const leaderboard = await readLeaderboard({ window, unit });

  return new Response(JSON.stringify(leaderboard), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

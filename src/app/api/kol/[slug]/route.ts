import { readKolDetail } from "@/lib/kol";
import { rateLimited } from "@/lib/rate-limit";
import { resolveWindow } from "@/lib/windows";

export const runtime = "nodejs";
// The window is relative to the current instant and the rows behind it change
// as the replay worker runs; there is nothing here to prerender.
export const dynamic = "force-dynamic";

/**
 * One KOL's period, for DESIGN.md's `modal-kol`.
 *
 * The modal is opened from a row that is already on the page, so this is the
 * one thing the leaderboard does not already know: the KOL's daily series, its
 * trade list and its turnover. Everything it answers goes out through
 * `serialize.ts` — the single place that decides what leaves the server — so
 * **no address is a field of this response, and a hidden KOL's signatures are
 * dropped before they reach it.**
 *
 * `window` is whitelisted by {@link parseWindow} and an unrecognised value is a
 * `400` rather than a fallback to the default, exactly as `/api/leaderboard`
 * treats it: a caller asking for `?window=anual` should learn it does not
 * exist, not read a daily figure labelled however they like. Neither the
 * parameter nor the slug is echoed into the response — the shape of what a
 * caller sent is not information this endpoint owes them, and both reach logs.
 *
 * ## The response's shape, and the one field that changed meaning
 *
 * **`series` is the calendar's month since 2026-09-03**, not the window's span,
 * and `calendar` is the month itself — `{ month, days, sells }`. The reason is
 * that every window became rolling that day: a rolling window ends at an
 * instant, so its first and last days are partial, and `pnl_daily` is keyed by
 * `date`. A "daily series for the last 24 hours" is not a range this schema can
 * state. `serialize.ts` carries the full note beside the field.
 *
 * No field was removed. Dropping `series` was the cleaner shape and it breaks
 * whoever holds this URL, so the owner kept it and gave it the meaning it can
 * carry.
 *
 * A slug that names no approved KOL is a `404` with a body that does not say
 * which of "no such KOL" and "suspended" it was (spec §9). `readKolDetail`
 * makes that one answer rather than two.
 *
 * No `ETag`: this route is not polled. The modal fetches once per segment, and
 * a validator would buy nothing while having to be kept honest for free.
 *
 * **The tightest limit of the four**, and the reason the four are not one
 * number: the audit measured this route at ~760 ms and four Neon queries per
 * request against a `max: 1` pool, an order of magnitude past the leaderboard.
 * The check comes before the params are awaited, so a refused caller costs a
 * header read and nothing else.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const limited = await rateLimited(request, "kol-detail");
  if (limited) return limited;

  const { slug } = await params;
  const url = new URL(request.url);
  const search = url.searchParams;

  // The same 308 the ranking's route answers, for the same reason: these were
  // published URLs, and the window was renamed under whoever holds one.
  const resolved = resolveWindow(search.get("window"));
  if (resolved !== null && typeof resolved === "object") {
    search.set("window", resolved.redirectTo);
    return Response.redirect(url.toString(), 308);
  }
  const window = resolved;

  /*
    `month` is **not** whitelisted the way `window` is, and the difference is
    deliberate. A window is a closed set of three names, so `?window=anual` is a
    caller asking for something that does not exist and gets a `400`. A month is
    an open range: `?month=1999-01` is a perfectly well-formed request for a
    month this KOL did not trade in, and the honest answer is an empty
    calendar. Only a value that is not a month at all falls back, and
    `readKolDetail` is where that happens — it resolves the month it actually
    read and puts it in the response, so a client can tell which one it got.
  */
  const month = search.get("month") ?? undefined;
  if (window === null) return new Response("bad request", { status: 400 });

  const detail = await readKolDetail({ slug, window, month });
  if (!detail) return new Response("not found", { status: 404 });

  return new Response(JSON.stringify(detail), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

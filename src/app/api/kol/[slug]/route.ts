import { readKolDetail } from "@/lib/kol";
import { parseWindow } from "@/lib/windows";

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
 * A slug that names no approved KOL is a `404` with a body that does not say
 * which of "no such KOL" and "suspended" it was (spec §9). `readKolDetail`
 * makes that one answer rather than two.
 *
 * No `ETag`: this route is not polled. The modal fetches once per segment, and
 * a validator would buy nothing while having to be kept honest for free.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const window = parseWindow(new URL(request.url).searchParams.get("window"));
  if (window === null) return new Response("bad request", { status: 400 });

  const detail = await readKolDetail({ slug, window });
  if (!detail) return new Response("not found", { status: 404 });

  return new Response(JSON.stringify(detail), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

import { readAvatar } from "@/lib/avatar";
import { rateLimited } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Spec §6.3, the reader `avatar_override_url` was written for and the route
 * `serialize.ts` has been advertising since it was written: the KOL's avatar,
 * keyed by `kol_id` and served from our own origin.
 *
 * ## The URL is the whole privacy property
 *
 * `kol_id` and nothing else. Not the address (kolscan.io serves
 * `cdn.kolscan.io/profiles/<wallet>.png` and leaks it in an image URL no API
 * response mentions), and not the handle either — a handle-keyed path would not
 * leak a wallet, but it would put the KOL's identity in every `<img src>` on the
 * page for no gain, since the id is already what the serializer has.
 *
 * ## Caching
 *
 * `next.config.ts` puts `no-store, no-cache, must-revalidate, private` on every
 * `/api/*` response, which is right for the feed and the leaderboard and wrong
 * for this: an avatar is a public, non-personal image, identical for every
 * viewer, and uncacheable avatars mean a ten-row leaderboard costs ten
 * round-trips to us and ten to unavatar **on every paint**. That file excludes
 * this one path from the rule instead of overriding it; see the comment there.
 *
 * **This route owns its `Cache-Control`, and it is the only thing that sets
 * one for this path.** It has to be: the four answers below are worth
 * remembering for four different lengths of time, and a static entry in
 * `next.config.ts` cannot tell them apart. The audit of `20040c7` measured the
 * previous arrangement — the config setting a value *and* the route setting
 * one — serving `public, max-age=60, s-maxage=300`, the config's, with the
 * route's `stale-while-revalidate` stripped. `CACHE_IMAGE` was dead code and
 * every real avatar was cached for five minutes instead of a day: about 288
 * times the unavatar fetches the two lifetimes were written for.
 *
 * - a real image: a day at the edge, a week of `stale-while-revalidate`. A KOL's
 *   picture changes rarely and nothing breaks if we are a day behind it.
 * - the monogram: five minutes. It is what an outage looks like, and caching an
 *   outage for a day would mean a KOL whose upstream blipped shows a letter
 *   until tomorrow.
 * - a `404`, and a `429`: never. A suspended KOL who is reinstated, or a
 *   caller whose window has rolled over, must not be answered out of a cache
 *   that predates either — and a shared cache holding one caller's refusal
 *   would hand it to everybody else.
 *
 * Cold cache, ten ranked rows: ten requests here and ten to unavatar, once.
 * After that the edge answers and the browser's `max-age` answers before the
 * edge does.
 *
 * `X-Robots-Tag: noindex, nofollow` is set for this path explicitly in
 * `next.config.ts`, since it no longer arrives from the `/(admin|api)` rule.
 *
 * ## The query string is not ours
 *
 * The handler used to ignore it — the parameter was called `_request` — while
 * the CDN keyed on it. The audit verified that `?cachebust=1` and
 * `?cb=<random>` each returned `200` with identical headers, each a fresh
 * cache key costing a database read and a fetch to unavatar on a 2.5 s budget,
 * and every `kol_id` is published in every `avatarUrl`, so the input space is
 * public. That is an unmetered outbound-fetch amplifier with a public trigger.
 *
 * So a request carrying **any** query string is refused. `404` rather than
 * `400`: a URL that is not one we serve is not a malformed request, it is a
 * URL that does not exist, and answering it exactly as an unknown `kol_id` is
 * answered tells a prober nothing it did not already know.
 *
 * The limiter runs **before** that check, not after. Rejecting on the query
 * string first would be cheaper per request, but it would leave the one thing
 * the attacker controls — the number of distinct cache keys, and so the number
 * of origin invocations — unbounded. Refusing first bounds it, and the second
 * refusal onwards costs no database write (see `rateLimited`).
 */
const CACHE_IMAGE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";
const CACHE_MONOGRAM = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";

/** No such KOL, no such URL. Never cached: see the note on lifetimes above. */
function notFound(): Response {
  return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ kolId: string }> },
): Promise<Response> {
  const limited = await rateLimited(request, "avatar");
  if (limited) return limited;

  // The raw URL, not `new URL(...).search`, which normalises a bare trailing
  // `?` away to `""` -- a URL that is still not one we serve.
  if (request.url.includes("?")) return notFound();

  const { kolId } = await params;

  const avatar = await readAvatar(kolId);
  // No such KOL, or one that is not on a public surface. `readAvatar` applies
  // spec §9's `status = 'approved'` filter, and a suspended KOL's avatar must
  // disappear with the rest of them. The body says nothing about which of the
  // two it was: whether an id exists is not information this endpoint owes an
  // anonymous caller.
  if (!avatar) return notFound();

  return new Response(avatar.body as BodyInit, {
    status: 200,
    headers: {
      "content-type": avatar.contentType,
      "cache-control": avatar.source === "monogram" ? CACHE_MONOGRAM : CACHE_IMAGE,
    },
  });
}

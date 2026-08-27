import { readAvatar } from "@/lib/avatar";

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
 * round-trips to us and ten to unavatar **on every paint**. That file carves
 * this one path out; see the comment there.
 *
 * Two lifetimes, because a success and a failure are worth remembering for very
 * different lengths of time:
 *
 * - a real image: a day at the edge, a week of `stale-while-revalidate`. A KOL's
 *   picture changes rarely and nothing breaks if we are a day behind it.
 * - the monogram: five minutes. It is what an outage looks like, and caching an
 *   outage for a day would mean a KOL whose upstream blipped shows a letter
 *   until tomorrow.
 *
 * Cold cache, ten ranked rows: ten requests here and ten to unavatar, once.
 * After that the edge answers and the browser's `max-age` answers before the
 * edge does.
 *
 * `X-Robots-Tag: noindex, nofollow` still comes from the `/(admin|api)` rule —
 * this route sets no such header, so nothing overrides it and avatars stay out
 * of image search.
 */
const CACHE_IMAGE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";
const CACHE_MONOGRAM = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kolId: string }> },
): Promise<Response> {
  const { kolId } = await params;

  const avatar = await readAvatar(kolId);
  // No such KOL, or one that is not on a public surface. `readAvatar` applies
  // spec §9's `status = 'approved'` filter, and a suspended KOL's avatar must
  // disappear with the rest of them. The body says nothing about which of the
  // two it was: whether an id exists is not information this endpoint owes an
  // anonymous caller.
  if (!avatar) return new Response("not found", { status: 404 });

  return new Response(avatar.body as BodyInit, {
    status: 200,
    headers: {
      "content-type": avatar.contentType,
      "cache-control": avatar.source === "monogram" ? CACHE_MONOGRAM : CACHE_IMAGE,
    },
  });
}

import { permanentRedirect } from "next/navigation";

/**
 * `/leaderboard` moved to `/` on 2026-09-03 and this keeps the old URL working.
 *
 * DESIGN.md, on the name of the ranked list: the route *"stays because changing
 * a published URL costs more than the inconsistency it removes"*. The same
 * argument holds when the page moves rather than when its name does — links,
 * bookmarks and the `Ver todo` of every screenshot taken before today all point
 * here.
 *
 * `permanentRedirect` rather than a copy of the page: two URLs rendering one
 * ranking is two things to keep in step, and a 308 tells a crawler which one is
 * the page. The query string rides along, so `?window=semanal&unit=ars` lands
 * where it meant to.
 */
export default async function LeaderboardRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) query.set(key, value[0]);
  }
  const search = query.toString();
  permanentRedirect(search === "" ? "/" : `/?${search}`);
}

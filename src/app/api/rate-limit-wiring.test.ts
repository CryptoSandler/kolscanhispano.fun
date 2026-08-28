/**
 * Spec §10: *"Security headers, `ip_hash` rate limiting and the admin token
 * pattern come from `outbid-tokens`."*
 *
 * The limiter existed and was wired into exactly one place — the webhook's
 * failed-authentication path — while every public read route was unmetered.
 * The audit of `20040c7` sent 60 unauthenticated GETs at each of three of them
 * and got 60 × 200 back, `/api/kol/<slug>?window=diario` at about 760 ms and
 * four Neon queries apiece against a `max: 1` pool.
 *
 * `rate-limit.test.ts` covers what `rateLimited` decides. What this file
 * covers is the thing that was actually wrong: **which routes call it, and
 * under which bucket** — a property no single route's test can state, because
 * the failure mode is a route that was left out.
 *
 * The routes are driven directly rather than over HTTP, so a case here is
 * about the handler and not about the server. Each surface uses an address of
 * its own: `rateLimited` memoises a refusal in module state that no `TRUNCATE`
 * reaches, so a shared address would carry one surface's refusal into the
 * next.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { PUBLIC_LIMITS, PUBLIC_WINDOW_SECONDS, ipHash, type PublicBucket } from "@/lib/rate-limit";
import * as avatarRoute from "./avatar/[kolId]/route";
import * as feedRoute from "./feed/route";
import * as kolRoute from "./kol/[slug]/route";
import * as leaderboardRoute from "./leaderboard/route";

type Surface = {
  path: string;
  bucket: PublicBucket;
  /** The address this surface's cases speak from. Unique per surface. */
  ip: string;
  call: (request: Request) => Promise<Response>;
};

/**
 * Every route a request can reach without a secret. A public route missing
 * from this list is the finding this file exists for, so adding one is a
 * deliberate act rather than something a reviewer has to notice.
 *
 * The two pages, `/` and `/leaderboard`, are limited by `src/proxy.ts` under
 * the `page` bucket; they are not routes and cannot be called this way.
 *
 * Neither the slug nor the id resolves to anything, so each handler answers
 * `404` when it is allowed through. That is on purpose: what is being pinned
 * is that the limiter ran *before* the read, and a fixture would only add a
 * way for these cases to fail for another reason.
 */
const SURFACES: Surface[] = [
  {
    path: "/api/feed",
    bucket: "feed",
    ip: "192.0.2.11",
    call: (request) => feedRoute.GET(request),
  },
  {
    path: "/api/leaderboard",
    bucket: "leaderboard",
    ip: "192.0.2.12",
    call: (request) => leaderboardRoute.GET(request),
  },
  {
    path: "/api/kol/[slug]",
    bucket: "kol-detail",
    ip: "192.0.2.13",
    call: (request) => kolRoute.GET(request, { params: Promise.resolve({ slug: "no-such-kol" }) }),
  },
  {
    path: "/api/avatar/[kolId]",
    bucket: "avatar",
    ip: "192.0.2.14",
    call: (request) =>
      avatarRoute.GET(request, { params: Promise.resolve({ kolId: crypto.randomUUID() }) }),
  },
];

function requestFrom(surface: Surface, search = ""): Request {
  const url =
    surface.bucket === "leaderboard" ? "?window=diario&unit=sol" : search;
  return new Request(`http://localhost${surface.path}${url}`, {
    headers: { "x-forwarded-for": surface.ip },
  });
}

/** Puts an address at exactly its limit for `bucket` in the current window. */
async function seedToLimit(ip: string, bucket: PublicBucket): Promise<void> {
  await query(
    `INSERT INTO rate_limit (ip_hash, bucket, window_start, hits)
     VALUES ($1, $2, to_timestamp(floor(extract(epoch FROM now()) / $4::int) * $4::int), $3)
     ON CONFLICT (ip_hash, bucket, window_start) DO UPDATE SET hits = $3`,
    [ipHash(ip), bucket, PUBLIC_LIMITS[bucket], PUBLIC_WINDOW_SECONDS],
  );
}

beforeEach(async () => {
  await query("TRUNCATE rate_limit");
});

describe("every public route is metered", () => {
  it.each(SURFACES)("$path counts a request under the $bucket bucket", async (surface) => {
    const response = await surface.call(requestFrom(surface));
    expect(response.status, "allowed through while under the limit").not.toBe(429);

    const rows = await query<{ bucket: string }>(
      "SELECT bucket FROM rate_limit WHERE ip_hash = $1",
      [ipHash(surface.ip)],
    );
    expect(rows.map((row) => row.bucket)).toEqual([surface.bucket]);
  });

  it.each(SURFACES)("$path refuses a caller over its limit", async (surface) => {
    await seedToLimit(surface.ip, surface.bucket);

    const response = await surface.call(requestFrom(surface));
    expect(response.status).toBe(429);
    // The refusal must not be held by a shared cache and must say when the
    // caller may come back. `/api/avatar` is the one that makes this load
    // bearing: `next.config.ts` sets no Cache-Control for that path at all.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

    // And the refusal itself cost exactly one write -- the call that
    // discovered the limit. Everything after it is answered from the memo, so
    // a flood of 429s does not become a flood of upserts against a `max: 1`
    // pool. Asserted here as well as in `rate-limit.test.ts` because it is the
    // only thing that distinguishes a limiter from an amplifier, and because
    // the two refusals are byte-identical: only the row tells them apart.
    for (let i = 0; i < 3; i++) {
      expect((await surface.call(requestFrom(surface))).status).toBe(429);
    }
    const [row] = await query<{ hits: number }>(
      "SELECT hits FROM rate_limit WHERE ip_hash = $1 AND bucket = $2",
      [ipHash(surface.ip), surface.bucket],
    );
    expect(row.hits).toBe(PUBLIC_LIMITS[surface.bucket] + 1);
  });
});

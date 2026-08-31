/**
 * The route is thin, and the two things it decides are worth pinning: what it
 * answers for a KOL that is not on a public surface, and how long each kind of
 * answer may be cached.
 *
 * The cache lifetimes are the reason this route is worth having at all. Without
 * them a ten-row leaderboard costs ten requests here and ten to unavatar on
 * every paint, and `next.config.ts`'s blanket `no-store` on `/api/*` would
 * guarantee exactly that — which is why that file carves this one path out.
 *
 * `readAvatar` is mocked with `spy: true`, so the real implementation runs and
 * these cases assert on the route's own behaviour rather than re-testing
 * `avatar.test.ts`. The one thing that cannot run for real is the upstream
 * fetch, so the case that needs a relayed image replaces the return value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import { monogramSvg } from "@/lib/monogram";
import { GET } from "./route";

vi.mock("@/lib/avatar", { spy: true });
import * as avatar from "@/lib/avatar";

const NAME = "Brújula Rota";

beforeEach(async () => {
  // See the note in the other route tests: rate_limit is shared state.
  await query("TRUNCATE kol, kol_wallet, cabal, rate_limit CASCADE");
});

afterEach(() => {
  vi.mocked(avatar.readAvatar).mockRestore();
});

async function insertKol(status = "approved"): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [id, `preview-${id.slice(0, 8)}`, NAME, `ejemplo_${id.slice(0, 8)}`, status],
  );
  return id;
}

function get(kolId: string, search = ""): Promise<Response> {
  return GET(new Request(`http://localhost/api/avatar/${kolId}${search}`), {
    params: Promise.resolve({ kolId }),
  });
}

/** `s-maxage=<n>` from a Cache-Control header, which is the edge's lifetime. */
function sMaxAge(response: Response): number {
  return Number(response.headers.get("cache-control")?.match(/s-maxage=(\d+)/)?.[1]);
}

describe("GET /api/avatar/[kolId]", () => {
  it("404s for an id no KOL has, and for one that is not a UUID", async () => {
    for (const id of [crypto.randomUUID(), "not-a-uuid", "../../etc/passwd"]) {
      expect((await get(id)).status, id).toBe(404);
    }
  });

  it("404s for a suspended KOL: spec §9's filter reaches this surface too", async () => {
    expect((await get(await insertKol("suspended"))).status).toBe(404);
  });

  it("says nothing about whether an id exists", async () => {
    // Whether a UUID names a KOL is not information this endpoint owes an
    // anonymous caller, and a distinguishable body would make it enumerable.
    const unknown = await (await get(crypto.randomUUID())).text();
    const suspended = await (await get(await insertKol("suspended"))).text();
    expect(unknown).toBe(suspended);
  });

  it("serves the monogram as an image when there is no upstream picture", async () => {
    // No injected fetch reaches the network here: the KOL's handle resolves to
    // a real unavatar URL, so the case is driven through the mock instead.
    vi.mocked(avatar.readAvatar).mockResolvedValueOnce({
      body: monogramSvg(NAME),
      contentType: "image/svg+xml; charset=utf-8",
      source: "monogram",
    });

    const response = await get(await insertKol());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(await response.text()).toBe(monogramSvg(NAME));
  });

  it("caches a real picture for a day and a monogram for minutes", async () => {
    const kolId = await insertKol();

    vi.mocked(avatar.readAvatar).mockResolvedValueOnce({
      body: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
      source: "unavatar",
    });
    const picture = await get(kolId);

    vi.mocked(avatar.readAvatar).mockResolvedValueOnce({
      body: monogramSvg(NAME),
      contentType: "image/svg+xml; charset=utf-8",
      source: "monogram",
    });
    const monogram = await get(kolId);

    // Both are cacheable at all -- which they would not be under the blanket
    // `no-store` on /api/*, and that is the point of the carve-out.
    for (const response of [picture, monogram]) {
      expect(response.headers.get("cache-control")).toMatch(/^public,/);
      expect(response.headers.get("cache-control")).not.toContain("no-store");
    }

    // A picture is worth remembering for a long time; a monogram is what an
    // outage looks like, and caching an outage for a day would leave a KOL
    // showing a letter until tomorrow.
    expect(sMaxAge(picture)).toBe(86_400);
    expect(sMaxAge(monogram)).toBe(300);
    expect(sMaxAge(monogram)).toBeLessThan(sMaxAge(picture));
  });

  /**
   * The audit of `20040c7` found this route ignoring its query string — the
   * parameter was literally named `_request` — while the CDN keyed on it.
   * `?cachebust=1` and `?cb=<random>` each returned `200` with identical
   * headers, so every distinct string was a fresh cache key costing a database
   * read and a fetch to `unavatar.io` on a 2.5 s budget. Every `kol_id` is
   * published in every `avatarUrl`, so the trigger is public: an unmetered
   * outbound-fetch amplifier with a public input space.
   */
  describe("the query string is not part of any URL this route serves", () => {
    it("refuses one, for an id that really exists", async () => {
      const kolId = await insertKol();
      for (const search of ["?cachebust=1", "?cb=" + crypto.randomUUID(), "?", "?window=diario"]) {
        expect((await get(kolId, search)).status, search).toBe(404);
      }
      // Not merely refused: never read. The point of the refusal is the work
      // it does not do, and a 404 produced *after* the database read and the
      // upstream fetch would fix nothing.
      expect(vi.mocked(avatar.readAvatar)).not.toHaveBeenCalled();
    });

    it("answers exactly as it answers an id that does not exist", async () => {
      // 404 and not 400: a URL that is not one we serve is not a malformed
      // request, and a distinguishable answer would tell a prober that the id
      // half was real.
      const withQuery = await get(await insertKol(), "?cb=1");
      const unknown = await get(crypto.randomUUID());
      expect(withQuery.status).toBe(unknown.status);
      expect(await withQuery.text()).toBe(await unknown.text());
    });
  });

  it("lets no cache hold an answer that is not an image", async () => {
    // The route owns its `Cache-Control` now -- `next.config.ts` sets none for
    // this path -- so a 404 with no header at all would be left to a shared
    // cache's heuristics, and a KOL who is reinstated would stay missing.
    const response = await get(crypto.randomUUID());
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never puts anything but the kol_id in what it was asked for", async () => {
    // The URL is the whole privacy property: kolscan.io serves
    // `cdn.kolscan.io/profiles/<wallet>.png` and leaks the address in an image
    // URL no API response ever mentions.
    const kolId = await insertKol();
    vi.mocked(avatar.readAvatar).mockResolvedValueOnce({
      body: monogramSvg(NAME),
      contentType: "image/svg+xml; charset=utf-8",
      source: "monogram",
    });
    await get(kolId);
    expect(vi.mocked(avatar.readAvatar).mock.calls[0][0]).toBe(kolId);
  });
});

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
  await query("TRUNCATE kol, kol_wallet, cabal CASCADE");
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

function get(kolId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/avatar/${kolId}`), {
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

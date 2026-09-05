import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { releaseCabalTags } from "./release-cabal-tags";

/**
 * The thirty days, which are a write rather than a predicate — see
 * `migrations/016`. What matters here is the **boundary**, in both directions:
 * a tag released early is somebody's identity handed to a stranger.
 */
async function insert(tag: string, dissolvedDaysAgo: number | null): Promise<void> {
  await query(
    `INSERT INTO cabal (id, tag, name, dissolved_at)
     VALUES ($1::uuid, $2, $2, CASE WHEN $3::int IS NULL THEN NULL
                                    ELSE now() - ($3 || ' days')::interval END)`,
    [crypto.randomUUID(), tag, dissolvedDaysAgo],
  );
}

beforeEach(async () => {
  await query("UPDATE kol SET cabal_id = NULL");
  await query("TRUNCATE cabal CASCADE");
});

describe("releaseCabalTags", () => {
  it("releases only the tags past thirty days, and keeps everything else", async () => {
    await insert("LIVE", null); // never dissolved
    await insert("YDAY", 1);
    await insert("EDGE", 29);
    await insert("OLD", 31);

    expect(await releaseCabalTags()).toEqual(["OLD"]);

    const rows = await query<{ name: string; tag: string | null }>(
      "SELECT name, tag FROM cabal ORDER BY name",
    );
    // The dissolved cabal keeps its name and its history; only the letters go
    // back into the namespace.
    expect(rows).toEqual([
      { name: "EDGE", tag: "EDGE" },
      { name: "LIVE", tag: "LIVE" },
      { name: "OLD", tag: null },
      { name: "YDAY", tag: "YDAY" },
    ]);
  });

  it("is safe to run twice", async () => {
    await insert("OLD", 40);
    expect(await releaseCabalTags()).toEqual(["OLD"]);
    // `tag IS NOT NULL` is what makes the second run a no-op rather than a
    // second release of the same row.
    expect(await releaseCabalTags()).toEqual([]);
  });

  it("frees the tag for somebody else the moment it is released", async () => {
    await insert("ARG", 31);
    await releaseCabalTags();
    // `cabal_tag_held` covers only the cabals still holding one, so this insert
    // is the proof that the namespace really opened.
    await insert("ARG", null);
    expect(
      await query("SELECT tag FROM cabal WHERE tag = 'ARG'"),
    ).toHaveLength(1);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { hitLimit, ipHash } from "./rate-limit";

beforeEach(async () => {
  await query("TRUNCATE rate_limit");
});

describe("ipHash", () => {
  it("is deterministic, 32 bytes, and not reversible to the address", () => {
    const hashed = ipHash("203.0.113.7");
    expect(hashed.equals(ipHash("203.0.113.7"))).toBe(true);
    expect(hashed.length).toBe(32);
    expect(hashed.toString("utf8")).not.toContain("203.0.113.7");
  });

  it("differs between addresses", () => {
    expect(ipHash("203.0.113.7").equals(ipHash("203.0.113.8"))).toBe(false);
  });
});

// The window is an hour, not the minute these cases would otherwise use.
// Each case makes several sequential round trips to Neon, and `hitLimit`
// buckets on a fixed window floored from the wall clock — so a minute
// boundary falling between two calls of one case starts a fresh bucket and
// the count resets under the assertion. That flaked once in CI. An hour makes
// the boundary unreachable within a case without touching `hitLimit` itself,
// which is the thing under test.
describe("hitLimit", () => {
  it("allows calls up to the limit and blocks the next one", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await hitLimit("203.0.113.7", "test", 3, 3600)).toBe(false);
    }
    expect(await hitLimit("203.0.113.7", "test", 3, 3600)).toBe(true);
  });

  it("counts buckets independently", async () => {
    await hitLimit("203.0.113.7", "a", 1, 3600);
    expect(await hitLimit("203.0.113.7", "b", 1, 3600)).toBe(false);
  });

  it("counts callers independently", async () => {
    await hitLimit("203.0.113.7", "test", 1, 3600);
    expect(await hitLimit("203.0.113.8", "test", 1, 3600)).toBe(false);
  });

  it("stores no raw IP address", async () => {
    await hitLimit("203.0.113.7", "test", 5, 3600);
    const [row] = await query<{ ip_hash: Buffer }>("SELECT ip_hash FROM rate_limit");
    expect(row.ip_hash.indexOf(Buffer.from("203.0.113.7", "utf8"))).toBe(-1);
  });
});

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { blindIndex } from "./crypto";
import { query } from "./db";
import {
  PUBLIC_LIMITS,
  PUBLIC_WINDOW_SECONDS,
  clientIp,
  hitLimit,
  ipHash,
  pruneRateLimit,
  rateLimited,
} from "./rate-limit";

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

  // L-3. This is the same digest it always was, and that is the property that
  // makes routing it through crypto.ts a refactor rather than a migration:
  // every rate_limit row already in the database is keyed by this value, and a
  // change here would silently reset every counter and orphan every row until
  // the prune caught up. The expectation is written out longhand rather than
  // as `blindIndex(ip, "ip")` so that changing the domain string in crypto.ts
  // fails here instead of agreeing with itself.
  it("is HMAC-SHA-256 over `ip:<address>` under WALLET_HMAC_KEY, unchanged", () => {
    const key = Buffer.from(process.env.WALLET_HMAC_KEY!, "base64");
    const expected = createHmac("sha256", key).update("ip:203.0.113.7", "utf8").digest();
    expect(ipHash("203.0.113.7").equals(expected)).toBe(true);
    expect(ipHash("203.0.113.7").equals(blindIndex("203.0.113.7", "ip"))).toBe(true);
  });

  // The reason it goes through crypto.ts at all: `key()` loads both keys and
  // refuses when they are equal, and the old inline HMAC was the one keyed
  // digest in the repo that never asked. An operator who pasted one value into
  // both variables used to get a hard failure everywhere except the rate
  // limiter.
  it("refuses when the two keys are the same value", () => {
    const same = process.env.WALLET_ENC_KEY!;
    const previous = process.env.WALLET_HMAC_KEY;
    process.env.WALLET_HMAC_KEY = same;
    try {
      expect(() => ipHash("203.0.113.7")).toThrow(/must not be equal/);
    } finally {
      process.env.WALLET_HMAC_KEY = previous;
    }
  });

  // Domain separation, the reason blindIndex takes a domain at all: the same
  // string counted as an address and as a caller must not produce the same
  // digest.
  it("does not collide with the address or signature index over the same string", () => {
    const value = "203.0.113.7";
    expect(ipHash(value).equals(blindIndex(value, "address"))).toBe(false);
    expect(ipHash(value).equals(blindIndex(value, "signature"))).toBe(false);
  });
});

// A readable window, now that the boundary is pinnable. Every case that cares
// which bucket a call lands in passes the instant explicitly (`hitLimit`'s
// last parameter), so no amount of round-trip latency can move it, and the
// window can be the minute these cases read best with instead of the hour
// they used to need. The one case that is *about* the default path leaves the
// instant out on purpose and keeps an hour for the reason the whole file used
// to: it makes two sequential round trips against the server's own clock, and
// an hour is the only thing that keeps a boundary from falling between them.
const WINDOW = 60;

// Divisible by WINDOW, so it sits exactly on a boundary: T0 + WINDOW - 1 is
// the last instant of its bucket and T0 + WINDOW the first of the next, which
// is what makes the arithmetic in each case readable.
const T0 = 1_800_000_000;

describe("hitLimit", () => {
  it("allows calls up to the limit and blocks the next one", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await hitLimit("203.0.113.7", "test", 3, WINDOW, T0)).toBe(false);
    }
    expect(await hitLimit("203.0.113.7", "test", 3, WINDOW, T0)).toBe(true);
  });

  it("counts buckets independently", async () => {
    await hitLimit("203.0.113.7", "a", 1, WINDOW, T0);
    expect(await hitLimit("203.0.113.7", "b", 1, WINDOW, T0)).toBe(false);
  });

  it("counts callers independently", async () => {
    await hitLimit("203.0.113.7", "test", 1, WINDOW, T0);
    expect(await hitLimit("203.0.113.8", "test", 1, WINDOW, T0)).toBe(false);
  });

  it("stores no raw IP address", async () => {
    await hitLimit("203.0.113.7", "test", 5, WINDOW, T0);
    const [row] = await query<{ ip_hash: Buffer }>("SELECT ip_hash FROM rate_limit");
    expect(row.ip_hash.indexOf(Buffer.from("203.0.113.7", "utf8"))).toBe(-1);
  });

  // The behaviour the rate limiter exists for, and the one the hour-long
  // window used to make unreachable: being blocked is temporary.
  it("allows a blocked caller again on the first call of the next window", async () => {
    expect(await hitLimit("203.0.113.7", "test", 1, WINDOW, T0)).toBe(false);
    expect(await hitLimit("203.0.113.7", "test", 1, WINDOW, T0 + 1)).toBe(true);
    expect(await hitLimit("203.0.113.7", "test", 1, WINDOW, T0 + WINDOW)).toBe(false);
  });

  it("shares a bucket within one window and starts a new one across a boundary", async () => {
    await hitLimit("203.0.113.7", "test", 10, WINDOW, T0);
    await hitLimit("203.0.113.7", "test", 10, WINDOW, T0 + WINDOW - 1);
    await hitLimit("203.0.113.7", "test", 10, WINDOW, T0 + WINDOW);

    const rows = await query<{ window_start: Date; hits: number }>(
      "SELECT window_start, hits FROM rate_limit ORDER BY window_start",
    );
    expect(rows.map((row) => row.hits)).toEqual([2, 1]);
    expect(rows[1].window_start.getTime() - rows[0].window_start.getTime()).toBe(WINDOW * 1000);
  });

  // `floor` puts a boundary instant at the start of the window it opens, not
  // at the end of the one it closes. Worth pinning: it is exactly the kind of
  // edge a rewrite of the expression (round, ceil, a subtracted epsilon)
  // flips without anything else looking different.
  it("puts an instant exactly on a boundary in the later window", async () => {
    await hitLimit("203.0.113.7", "test", 10, WINDOW, T0 - 1);
    await hitLimit("203.0.113.7", "test", 10, WINDOW, T0);

    const rows = await query<{ window_start: Date }>(
      "SELECT window_start FROM rate_limit ORDER BY window_start",
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].window_start.getTime()).toBe(T0 * 1000);
  });

  // Omitting the instant must not quietly hand the bucketing to the
  // application's clock: `now()` is transaction start on the server, and a
  // fleet of app processes with drifting clocks would otherwise disagree
  // about which window a request belongs to. Asserted against the database's
  // own now(), never against this process's -- comparing to Date.now() here
  // would pass just as happily if the SQL had been changed to trust the
  // caller, which is the whole thing this case is meant to catch.
  it("buckets on the database's clock when no instant is supplied", async () => {
    await hitLimit("203.0.113.7", "test", 5, 3600);

    const [row] = await query<{ on_server_window: boolean }>(
      `SELECT window_start = to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600)
                AS on_server_window
         FROM rate_limit`,
    );
    expect(row.on_server_window).toBe(true);
  });
});

/**
 * `rate_limit` is the one table here that every request from every visitor
 * writes to and nothing ever reads back beyond its own window, so these cases
 * are about the only thing keeping it from growing without bound.
 *
 * Rows are inserted directly rather than through `hitLimit`, which can only
 * ever write a window near the server's now(): what needs seeding is a row
 * old enough to prune, and `now() - interval` says that in one statement
 * without pretending the days in between happened.
 */
async function seedWindow(bucket: string, daysAgo: number): Promise<void> {
  await query(
    `INSERT INTO rate_limit (ip_hash, bucket, window_start, hits)
     VALUES ($1, $2, now() - make_interval(days => $3::int), 1)`,
    [ipHash("203.0.113.7"), bucket, daysAgo],
  );
}

async function remainingBuckets(): Promise<string[]> {
  const rows = await query<{ bucket: string }>("SELECT bucket FROM rate_limit ORDER BY bucket");
  return rows.map((row) => row.bucket);
}

describe("pruneRateLimit", () => {
  it("deletes the windows older than the retention it is given and reports how many", async () => {
    await seedWindow("stale", 3);
    await seedWindow("fresh", 1);

    expect(await pruneRateLimit(2 * 24 * 3600)).toBe(1);
    expect(await remainingBuckets()).toEqual(["fresh"]);
  });

  it("keeps a week when given no retention", async () => {
    await seedWindow("eight-days", 8);
    await seedWindow("six-days", 6);

    expect(await pruneRateLimit()).toBe(1);
    expect(await remainingBuckets()).toEqual(["six-days"]);
  });

  // The count is the whole output of the cron line, so a prune that silently
  // deletes nothing and a prune that had nothing to delete must not be told
  // apart by the caller having to guess.
  // Not an EXPLAIN assertion: the planner will seq-scan a table this small
  // whatever indexes exist, so a plan check here would pin the fixture size
  // rather than the schema. What is worth pinning is that the index the
  // delete needs at production size is actually in the database
  // (migrations/007_rate_limit_prune_idx.sql) -- the PRIMARY KEY does not
  // serve it, window_start being its third column, and nothing else here
  // would ever notice it missing.
  it("has an index the age predicate can range-scan", async () => {
    const rows = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'rate_limit' AND indexname = 'rate_limit_window_start_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("(window_start)");
  });

  it("deletes nothing and returns 0 when every window is inside the retention", async () => {
    await seedWindow("yesterday", 1);
    await seedWindow("two-days", 2);

    expect(await pruneRateLimit()).toBe(0);
    expect(await remainingBuckets()).toEqual(["two-days", "yesterday"]);
  });
});


describe("clientIp", () => {
  const request = (headers: Record<string, string>) =>
    new Request("http://localhost/api/feed", { headers });

  it("takes the first hop of x-forwarded-for, which is the client", () => {
    // Everything after the first entry is a proxy the caller named, and a
    // caller can name anything. Reading the last hop -- or the whole header --
    // would let one attacker occupy an unbounded number of buckets.
    expect(clientIp(request({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" })))
      .toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, and then to one shared bucket", () => {
    expect(clientIp(request({ "x-real-ip": "203.0.113.8" }))).toBe("203.0.113.8");
    expect(clientIp(request({}))).toBe("unknown");
    // An empty header is absent, not a caller named "".
    expect(clientIp(request({ "x-forwarded-for": "  " }))).toBe("unknown");
  });
});

/**
 * `rateLimited` is the whole of what the five public surfaces do, so what is
 * pinned here is not "the counting works" -- `hitLimit` above covers that --
 * but the two properties the routes depend on and cannot state themselves:
 * the refusal is uncacheable, and the second refusal is free.
 *
 * Every case uses an address of its own. The memo is module state that no
 * `TRUNCATE` reaches, so sharing an address between cases would leak a
 * refusal from one into the next; a distinct address per case is the
 * isolation, and it costs nothing.
 */
describe("rateLimited", () => {
  const request = (ip: string) =>
    new Request("http://localhost/api/feed", { headers: { "x-forwarded-for": ip } });

  /** Puts `ip` at exactly its limit for `bucket` in the window it is in now. */
  async function seedToLimit(ip: string, bucket: keyof typeof PUBLIC_LIMITS): Promise<void> {
    await query(
      `INSERT INTO rate_limit (ip_hash, bucket, window_start, hits)
       VALUES ($1, $2, to_timestamp(floor(extract(epoch FROM now()) / $4::int) * $4::int), $3)
       ON CONFLICT (ip_hash, bucket, window_start) DO UPDATE SET hits = $3`,
      [ipHash(ip), bucket, PUBLIC_LIMITS[bucket], PUBLIC_WINDOW_SECONDS],
    );
  }

  async function hitsFor(ip: string, bucket: string): Promise<number> {
    const rows = await query<{ hits: number }>(
      "SELECT hits FROM rate_limit WHERE ip_hash = $1 AND bucket = $2",
      [ipHash(ip), bucket],
    );
    return rows[0]?.hits ?? 0;
  }

  it("lets a caller under the limit through, and counts the request", async () => {
    expect(await rateLimited(request("198.51.100.1"), "feed")).toBeNull();
    expect(await hitsFor("198.51.100.1", "feed")).toBe(1);
  });

  it("counts each bucket separately, so one surface cannot exhaust another", async () => {
    await seedToLimit("198.51.100.2", "kol-detail");
    expect(await rateLimited(request("198.51.100.2"), "kol-detail")).not.toBeNull();
    expect(await rateLimited(request("198.51.100.2"), "feed")).toBeNull();
  });

  it("refuses with a 429 that no cache may hold and a Retry-After inside the window", async () => {
    await seedToLimit("198.51.100.3", "leaderboard");

    const response = await rateLimited(request("198.51.100.3"), "leaderboard");
    expect(response?.status).toBe(429);
    // `next.config.ts` sets no Cache-Control for /api/avatar at all, so this
    // one has to carry its own: a shared cache holding a 429 would serve one
    // caller's refusal to everybody behind that cache.
    expect(response?.headers.get("cache-control")).toBe("no-store");

    const retryAfter = Number(response?.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(PUBLIC_WINDOW_SECONDS);
  });

  /**
   * The property the whole memo exists for. `hitLimit` costs an upsert on
   * every call it is given, so a limiter that consulted it once per refused
   * request would turn a flood of 429s into a flood of writes against a
   * `max: 1` pool -- the limiter as amplifier. Asserted on the row, because
   * the response is identical either way and only the write tells them apart.
   */
  it("does not touch the database again for a caller it has already refused", async () => {
    await seedToLimit("198.51.100.4", "avatar");

    expect((await rateLimited(request("198.51.100.4"), "avatar"))?.status).toBe(429);
    const afterFirst = await hitsFor("198.51.100.4", "avatar");
    expect(afterFirst).toBe(PUBLIC_LIMITS.avatar + 1);

    for (let i = 0; i < 5; i++) {
      expect((await rateLimited(request("198.51.100.4"), "avatar"))?.status).toBe(429);
    }
    expect(await hitsFor("198.51.100.4", "avatar")).toBe(afterFirst);
  });

  it("never refuses one caller for another's traffic", async () => {
    await seedToLimit("198.51.100.5", "page");
    expect(await rateLimited(request("198.51.100.5"), "page")).not.toBeNull();
    expect(await rateLimited(request("198.51.100.6"), "page")).toBeNull();
  });
});

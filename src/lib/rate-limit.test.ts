import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { hitLimit, ipHash, pruneRateLimit } from "./rate-limit";

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

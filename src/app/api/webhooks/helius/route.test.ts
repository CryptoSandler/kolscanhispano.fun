import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { inventSignature } from "@/lib/ids";
import { ipHash } from "@/lib/rate-limit";
import { POST } from "./route";

const secret = process.env.HELIUS_WEBHOOK_SECRET!;
const CLIENT_IP = "203.0.113.7";

function request(body: unknown, authorization: string | null) {
  return new Request("http://localhost/api/webhooks/helius", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLIENT_IP,
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

const payload = (signature: string) => [
  { signature, slot: 1, timestamp: 1787664000, type: "SWAP" },
];

/** Seeds the rate_limit row for CLIENT_IP directly, as if `hits` prior
 * requests had already landed in the current window. Used to put the limiter
 * at or past its threshold without actually sending that many requests. */
async function seedRateLimitHits(bucket: string, hits: number): Promise<void> {
  await query(
    `INSERT INTO rate_limit (ip_hash, bucket, window_start, hits)
     VALUES ($1, $2, to_timestamp(floor(extract(epoch FROM now()) / 60) * 60), $3)
     ON CONFLICT (ip_hash, bucket, window_start) DO UPDATE SET hits = $3`,
    [ipHash(CLIENT_IP), bucket, hits],
  );
}

// The test database is a remote Neon branch that scales to zero. A cold
// connection can by itself blow the one-second budget the timing tests below
// assert on, which would flake the test for a reason that has nothing to do
// with the handler. Warming the pool here means those tests measure the
// handler, not Neon's wake-up latency.
beforeAll(async () => {
  await query("SELECT 1");
});

beforeEach(async () => {
  await query("TRUNCATE raw_tx, rate_limit");
});

describe("POST /api/webhooks/helius", () => {
  it("rejects a missing authorization header", async () => {
    const res = await POST(request(payload(inventSignature()), null));
    expect(res.status).toBe(401);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(0);
  });

  it("rejects a wrong secret", async () => {
    const res = await POST(request(payload(inventSignature()), "wrong"));
    expect(res.status).toBe(401);
  });

  it("accepts a correct secret and stores the transaction", async () => {
    const res = await POST(request(payload(inventSignature()), secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });

  it("returns 200 on a replay without storing a duplicate", async () => {
    const body = payload(inventSignature());
    await POST(request(body, secret));
    const res = await POST(request(body, secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });

  it("answers well inside the one-second budget Helius allows", async () => {
    const started = Date.now();
    await POST(request(payload(inventSignature()), secret));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("accepts a batch of transactions in one delivery", async () => {
    const body = [...payload(inventSignature()), ...payload(inventSignature())];
    const res = await POST(request(body, secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(2);
  });

  // A ten-event batch is routine for an active webhook. A per-event sequential
  // store previously measured well over the one-second budget at this size
  // (1803ms for 10 events) — this is the test that would have caught it: the
  // batch must both land completely and come back inside the budget.
  it("stores a ten-event batch inside the one-second budget", async () => {
    const body = Array.from({ length: 10 }, () => payload(inventSignature())[0]);
    const started = Date.now();
    const res = await POST(request(body, secret));
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(10);
  });

  // A deterministically malformed event (here, a signature that is not a
  // string) must not sink the rest of the batch: retrying it would fail
  // identically every time, so the only effect of aborting on it is losing
  // every good event delivered alongside it, permanently.
  it("skips a malformed event and still stores the rest, returning 200", async () => {
    const good1 = payload(inventSignature())[0];
    const good2 = payload(inventSignature())[0];
    const malformed = { signature: 123456, slot: 1, timestamp: 1787664000, type: "SWAP" };
    const res = await POST(request([good1, malformed, good2], secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(2);
  });

  it("never rate limits an authenticated request, even from an IP already over the limit", async () => {
    // Simulate 600 prior hits against the auth-failure bucket for this IP in
    // the current window — one past what used to trip the limiter on every
    // request, authenticated or not.
    await seedRateLimitHits("helius-webhook", 600);
    const res = await POST(request(payload(inventSignature()), secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });

  it("still rate limits repeated failed-authentication attempts", async () => {
    await seedRateLimitHits("helius-webhook", 600);
    const res = await POST(request(payload(inventSignature()), "wrong"));
    expect(res.status).toBe(429);
  });
});

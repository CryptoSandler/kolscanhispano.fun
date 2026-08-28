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

  // A malformed timestamp used to escape `storeRawTxBatch` as a driver error,
  // out of POST as a 500, and into Helius's retry-three-times-then-drop path,
  // taking the good events of the same delivery with it. See raw-tx.ts.
  it("keeps the good events of a delivery whose timestamp is malformed", async () => {
    const good1 = payload(inventSignature())[0];
    const good2 = payload(inventSignature())[0];
    const malformed = { signature: inventSignature(), slot: 1, timestamp: "nonsense", type: "SWAP" };
    const res = await POST(request([good1, malformed, good2], secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(2);
  });

  it("keeps the good events of a delivery whose slot is malformed", async () => {
    const good1 = payload(inventSignature())[0];
    const good2 = payload(inventSignature())[0];
    const malformed = { signature: inventSignature(), slot: "abc", timestamp: 1787664000, type: "SWAP" };
    const res = await POST(request([good1, malformed, good2], secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(2);
  });
});

/**
 * L-1. Probed on 20040c7: `null`, `7`, `"hello"`, `[]`, `[{}]` and `[null]`
 * all answered 200, and only `{{{` got a 400 — so every body shape short of
 * unparseable JSON was accepted silently and a change in Helius's envelope
 * would have looked exactly like an hour with no trades.
 */
describe("POST /api/webhooks/helius: body shape", () => {
  it.each([
    ["null", null],
    ["a number", 7],
    ["a string", "hello"],
    ["a boolean", true],
  ])("refuses %s with 400", async (_name, body) => {
    const res = await POST(request(body, secret));
    expect(res.status).toBe(400);
  });

  it("refuses unparseable JSON with 400", async () => {
    const res = new Request("http://localhost/api/webhooks/helius", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": CLIENT_IP, authorization: secret },
      body: "{{{",
    });
    expect((await POST(res)).status).toBe(400);
  });

  // The shapes that stay 200, so the 400 above is not widened into a refusal
  // of deliveries Helius really sends. An array is the delivery shape and an
  // empty one is a real delivery; a bare object is one event.
  it.each([
    ["an empty array", [] as unknown],
    ["an array of empty objects", [{}]],
    ["an array holding null", [null]],
    ["a bare object with no signature", {}],
  ])("still accepts %s with 200", async (_name, body) => {
    const res = await POST(request(body, secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(0);
  });

  it("still stores a single event delivered as a bare object", async () => {
    const res = await POST(request(payload(inventSignature())[0], secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });
});

/**
 * M-4. `await request.json()` had no ceiling. Authentication is checked first,
 * so the read is only ever reached by a secret-holder — but a body is not
 * something a handler should agree to buffer without a bound just because the
 * caller knew a password.
 *
 * Both halves are exercised: the `content-length` claim, which is the cheap
 * refusal, and the counted read, which is the one that holds when the claim is
 * a lie.
 */
describe("POST /api/webhooks/helius: body size", () => {
  const OVER = 8 * 1024 * 1024 + 1;

  function oversized(headers: Record<string, string>) {
    // A stream, not a string: the point of the read is that it stops counting
    // before the whole thing has been buffered, and a string body would have
    // been materialised by the test itself.
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= OVER) return controller.close();
        const chunk = new Uint8Array(64 * 1024).fill(0x20);
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return new Request("http://localhost/api/webhooks/helius", {
      method: "POST",
      headers: { "x-forwarded-for": CLIENT_IP, authorization: secret, ...headers },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  }

  it("refuses a body whose content-length is over the ceiling, with 413", async () => {
    const res = await POST(oversized({ "content-length": String(OVER) }));
    expect(res.status).toBe(413);
  });

  it("refuses a body that is over the ceiling without declaring it, with 413", async () => {
    const res = await POST(oversized({}));
    expect(res.status).toBe(413);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(0);
  });

  it("does not refuse an ordinary delivery", async () => {
    const res = await POST(request(payload(inventSignature()), secret));
    expect(res.status).toBe(200);
  });

  // The ceiling sits *behind* the authentication check, and the status is how
  // that order is observable: an unauthenticated caller gets 401, not the 413
  // it would get if the handler had looked at the body first. That is the
  // right way round — 413 would tell an anonymous caller how large a body this
  // endpoint accepts, and the body of an unauthenticated request is never read
  // at all.
  it("answers 401, not 413, to an oversized unauthenticated body", async () => {
    const res = await POST(
      new Request("http://localhost/api/webhooks/helius", {
        method: "POST",
        headers: { "x-forwarded-for": CLIENT_IP, "content-length": String(OVER) },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });
});

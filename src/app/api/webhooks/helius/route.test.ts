import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { inventSignature } from "@/lib/ids";
import { POST } from "./route";

const secret = process.env.HELIUS_WEBHOOK_SECRET!;

function request(body: unknown, authorization: string | null) {
  return new Request("http://localhost/api/webhooks/helius", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.7",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

const payload = (signature: string) => [
  { signature, slot: 1, timestamp: 1787664000, type: "SWAP" },
];

// The test database is a remote Neon branch that scales to zero. A cold
// connection can by itself blow the one-second budget the timing test below
// asserts on, which would flake the test for a reason that has nothing to do
// with the handler. Warming the pool here means that test measures the
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
});

/**
 * The drain the delivery schedules, actually run.
 *
 * `route.test.ts` calls `POST` directly, which is outside a Next request scope,
 * so `after()` does nothing there — the handler is written to swallow that,
 * because the cron is the net. Which means every case in that file passes
 * whether or not the drain exists at all, and a seam nobody has rendered
 * through is the shape this repository has shipped before.
 *
 * So `after` is replaced here with something that hands the callback back, and
 * the callback is run against the real database: a delivery arrives, the row is
 * stored, and by the time the callback returns it has been parsed. That is the
 * whole claim of `docs/operations.md` §1 — the trade→row latency is seconds
 * because the delivery itself does the work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every callback `after()` was handed, in order. */
const scheduled: Array<() => unknown> = [];

vi.mock("next/server", () => ({
  after: (callback: () => unknown) => {
    scheduled.push(callback);
  },
}));

const { query } = await import("@/lib/db");
const { inventSignature } = await import("@/lib/ids");
const { POST } = await import("./route");

const secret = process.env.HELIUS_WEBHOOK_SECRET!;

function delivery(signature: string): Request {
  return new Request("https://kolscanhispano.fun/api/webhooks/helius", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: secret,
      "x-forwarded-for": "203.0.113.9",
    },
    body: JSON.stringify([
      { signature, slot: 1, timestamp: 1787664000, type: "SWAP" },
    ]),
  });
}

beforeEach(async () => {
  scheduled.length = 0;
  await query("TRUNCATE raw_tx, rate_limit");
});

afterEach(async () => {
  await query("TRUNCATE raw_tx, rate_limit");
});

describe("the delivery drains after it has answered", () => {
  it("stores the row, answers 200, and schedules exactly one drain", async () => {
    const response = await POST(delivery(inventSignature()));

    expect(response.status).toBe(200);
    // Stored before the response, parsed after it: the row exists and is
    // untouched at the moment the caller is told 200.
    const [before] = await query<{ n: string }>(
      "SELECT count(*) AS n FROM raw_tx WHERE parsed_at IS NULL",
    );
    expect(Number(before.n)).toBe(1);
    expect(scheduled).toHaveLength(1);
  });

  /**
   * The property `route.test.ts` cannot see. The payload here belongs to no
   * wallet on the roster, so the parse produces no trade — and that is the
   * point: what is asserted is that the row **was examined**, which is the
   * difference between a queue that drains on delivery and one that waits for
   * a cron GitHub runs every three hours.
   */
  it("parses the row it just stored, without a cron", async () => {
    await POST(delivery(inventSignature()));
    await scheduled[0]();

    const [after] = await query<{ n: string }>(
      "SELECT count(*) AS n FROM raw_tx WHERE parsed_at IS NULL AND parse_error IS NULL",
    );
    expect(Number(after.n)).toBe(0);
  });

  /**
   * Two deliveries landing together must not both parse: they take the parse
   * cron's own advisory lock, and the loser does nothing because the winner is
   * draining the same queue. Run in parallel rather than in sequence, because
   * in sequence the lock is free by the time the second asks for it.
   */
  it("does not race a drain that is already running", async () => {
    await POST(delivery(inventSignature()));
    await POST(delivery(inventSignature()));
    expect(scheduled).toHaveLength(2);

    await Promise.all(scheduled.map((run) => run()));

    // Whichever won, the queue is drained and nothing threw.
    const [after] = await query<{ n: string }>(
      "SELECT count(*) AS n FROM raw_tx WHERE parsed_at IS NULL AND parse_error IS NULL",
    );
    expect(Number(after.n)).toBe(0);
  });

  /** A delivery that stored nothing schedules nothing: no row, no work. */
  it("schedules no drain for a delivery with no event in it", async () => {
    const empty = new Request("https://kolscanhispano.fun/api/webhooks/helius", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: secret },
      body: "[]",
    });

    expect((await POST(empty)).status).toBe(200);
    expect(scheduled).toEqual([]);
  });
});

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route";
import { PANCAKE_V3_SWAP } from "@/lib/bnb-swap";
import { inventEvmAddress } from "@/lib/ids";

/**
 * The gate on the BNB webhook.
 *
 * The one property that matters: **a delivery nobody signed does not get in**,
 * and neither does one whose body changed after signing. Everything else this
 * endpoint does is decoding.
 */
const SECRET = "test-signing-key";

function body(): string {
  const address = inventEvmAddress();
  const topic = `0x${address.replace(/^0x/, "").padStart(64, "0")}`;
  return JSON.stringify({
    event: {
      data: {
        block: {
          logs: [
            {
              address: inventEvmAddress(),
              topics: [PANCAKE_V3_SWAP, topic, topic],
              data: `0x${"0".repeat(63)}1${"0".repeat(63)}1${"0".repeat(64)}${"0".repeat(64)}${"0".repeat(64)}`,
              blockNumber: "0x1",
              transactionHash: `0x${"ab".repeat(32)}`,
              logIndex: "0x0",
            },
          ],
        },
      },
    },
  });
}

function sign(raw: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(raw, "utf8").digest("hex");
}

function post(raw: string, signature: string | null): Promise<Response> {
  return POST(
    new Request("https://kolscanhispano.fun/api/webhooks/alchemy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature === null ? {} : { "x-alchemy-signature": signature }),
      },
      body: raw,
    }),
  );
}

beforeEach(() => {
  process.env.ALCHEMY_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.ALCHEMY_WEBHOOK_SECRET;
});

describe("POST /api/webhooks/alchemy", () => {
  it("accepts a delivery signed with the webhook's key", async () => {
    const raw = body();
    const response = await post(raw, sign(raw));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: 1, decoded: 1 });
  });

  it("refuses a delivery whose signature was altered", async () => {
    const raw = body();
    const real = sign(raw);
    // One character, which is the whole point: an HMAC that accepted a
    // near-miss would accept anything.
    const tampered = `${real.slice(0, -1)}${real.endsWith("a") ? "b" : "a"}`;
    const response = await post(raw, tampered);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("refuses a body changed after it was signed", async () => {
    const raw = body();
    const signature = sign(raw);
    // The signature is over the RAW bytes, so any edit invalidates it — this is
    // what a verifier that re-serialised the parsed body would get wrong.
    const response = await post(raw.replace("0x1", "0x2"), signature);
    expect(response.status).toBe(401);
  });

  it("refuses a delivery with no signature at all", async () => {
    expect((await post(body(), null)).status).toBe(401);
  });

  it("refuses everything when no secret is configured", async () => {
    const raw = body();
    const signature = sign(raw);
    delete process.env.ALCHEMY_WEBHOOK_SECRET;
    // Fails closed: an unset secret must not mean "accept", which is the shape
    // a missing-config bug usually takes.
    expect((await post(raw, signature)).status).toBe(401);
  });
});

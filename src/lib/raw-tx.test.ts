import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { inventSignature } from "./ids";
import { storeRawTx } from "./raw-tx";

beforeEach(async () => {
  await query("TRUNCATE raw_tx");
});

const input = () => ({
  signature: inventSignature(),
  blockTime: new Date("2026-08-25T12:00:00Z"),
  slot: 171942732,
  payload: { type: "SWAP", note: "fixture" },
  source: "webhook" as const,
});

describe("storeRawTx", () => {
  it("stores a new transaction", async () => {
    expect(await storeRawTx(input())).toBe(true);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });

  it("is idempotent on a replayed signature", async () => {
    const one = input();
    expect(await storeRawTx(one)).toBe(true);
    expect(await storeRawTx(one)).toBe(false);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });

  it("stores neither the signature nor the payload in plaintext", async () => {
    const one = { ...input(), payload: { type: "SWAP", marker: "PLAINTEXT-MARKER" } };
    await storeRawTx(one);
    const [row] = await query<{ blob: string }>("SELECT raw_tx::text AS blob FROM raw_tx");
    expect(row.blob).not.toContain(one.signature);
    expect(row.blob).not.toContain("PLAINTEXT-MARKER");
  });

  it("leaves the row unparsed for the parser to pick up", async () => {
    await storeRawTx(input());
    const [row] = await query<{ parsed_at: Date | null }>("SELECT parsed_at FROM raw_tx");
    expect(row.parsed_at).toBeNull();
  });
});

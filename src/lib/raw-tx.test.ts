import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { inventSignature } from "./ids";
import { storeRawTx, storeRawTxBatch } from "./raw-tx";

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

describe("storeRawTxBatch", () => {
  it("stores every row of a batch in one call", async () => {
    const inputs = [input(), input(), input()];
    const inserted = await storeRawTxBatch(inputs);
    expect(inserted).toHaveLength(3);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(3);
  });

  it("tolerates the same signature appearing twice within one batch", async () => {
    const duplicate = input();
    const inserted = await storeRawTxBatch([duplicate, duplicate, input()]);
    expect(inserted).toHaveLength(2);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(2);
  });

  it("skips a malformed item and still stores the rest", async () => {
    const malformed = { ...input(), signature: 123456 as unknown as string };
    const good = input();
    const inserted = await storeRawTxBatch([malformed, good]);
    expect(inserted).toEqual([good.signature]);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });

  it("returns an empty array for an empty batch without querying the database", async () => {
    expect(await storeRawTxBatch([])).toEqual([]);
  });

  it("does not insert an already-stored signature again", async () => {
    const one = input();
    await storeRawTx(one);
    const inserted = await storeRawTxBatch([one]);
    expect(inserted).toEqual([]);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });
});

/**
 * The fields `encrypt()` never sees.
 *
 * `signature` and `payload` are ciphertext by the time they reach the INSERT,
 * so a malformed one fails in `prepareRow` and lands in the skip-and-continue
 * path the batch docstring promises. `blockTime` and `slot` do not: they are
 * plain columns, and until 2026-08-28 they went into the multi-row INSERT
 * unchecked. Probed against TEST_DATABASE_URL, each of these aborted the whole
 * statement -- `invalid input syntax for type timestamp with time zone`,
 * `invalid input syntax for type bigint`, `timestamp out of range` -- so the
 * two good events in the same delivery were lost, the route returned 500, and
 * Helius retried three times and dropped the delivery for good.
 *
 * One case per rejected field, and each one asserts the *good* events landed:
 * "it threw the right error" would still pass against a version that lost the
 * batch.
 */
describe("storeRawTxBatch: the two unencrypted columns", () => {
  const rejected: Array<[string, () => ReturnType<typeof input>]> = [
    ["a block time that does not parse", () => ({ ...input(), blockTime: new Date("nonsense") })],
    ["a block time too large for Date", () => ({ ...input(), blockTime: new Date(1e18 * 1000) })],
    ["a block time before the epoch", () => ({ ...input(), blockTime: new Date("-004714-01-01T00:00:00Z") })],
    ["a block time that is not a Date at all", () => ({ ...input(), blockTime: 1787664000 as unknown as Date })],
    ["a slot that is not a number", () => ({ ...input(), slot: "abc" as unknown as number })],
    ["a slot that is fractional", () => ({ ...input(), slot: 1.5 })],
    ["a slot past Number.MAX_SAFE_INTEGER", () => ({ ...input(), slot: 1e30 })],
  ];

  it.each(rejected)("skips %s and still stores the rest of the batch", async (_name, malformed) => {
    const before = input();
    const after = input();
    const inserted = await storeRawTxBatch([before, malformed(), after]);
    expect(inserted).toEqual([before.signature, after.signature]);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(2);
  });

  // The single-item entry point keeps the opposite contract, and the same two
  // checks are what make it hold for these fields too: a backfill or reconcile
  // caller passing a bad block time wants to hear about it rather than have
  // the row quietly disappear.
  it.each(rejected)("throws out of storeRawTx on %s instead of skipping it", async (_name, malformed) => {
    await expect(storeRawTx(malformed())).rejects.toThrow();
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(0);
  });

  // The boundary on the other side, so the guard is not quietly widened into
  // one that rejects real data: a slot at the top of the safe-integer range
  // and an instant at the top of what Date can express are both stored.
  it("stores the largest slot and instant that are still representable", async () => {
    const extreme = {
      ...input(),
      slot: Number.MAX_SAFE_INTEGER,
      blockTime: new Date(8.64e15),
    };
    expect(await storeRawTx(extreme)).toBe(true);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });
});

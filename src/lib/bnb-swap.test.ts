import { describe, expect, it } from "vitest";
import {
  PANCAKE_V2_SWAP,
  PANCAKE_V3_SWAP,
  decodeSwap,
  swapFilterFor,
  type SwapLog,
} from "./bnb-swap";
import { inventEvmAddress } from "./ids";

/**
 * The decoder, against the log shapes measured on BSC mainnet on 2026-09-05.
 *
 * **Built rather than captured.** A real log carries a real recipient, and an
 * EVM address in tracked source is what `hygiene.ts` exists to refuse — so the
 * shapes are reproduced exactly and the addresses are invented. What is real is
 * the layout: topic count, word count, and which word means what.
 */
const word = (value: bigint): string => {
  const v = value < 0n ? (1n << 256n) + value : value;
  return v.toString(16).padStart(64, "0");
};
const asTopic = (address: string) => `0x${address.replace(/^0x/, "").padStart(64, "0")}`;

function v3Log(recipient: string, amount0: bigint, amount1: bigint): SwapLog {
  return {
    address: inventEvmAddress(),
    topics: [PANCAKE_V3_SWAP, asTopic(inventEvmAddress()), asTopic(recipient)],
    // amount0, amount1, sqrtPriceX96, liquidity, tick
    data: `0x${word(amount0)}${word(amount1)}${word(1n)}${word(2n)}${word(3n)}`,
    blockNumber: "0x7295f94",
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex: "0x4",
  };
}

function v2Log(recipient: string, in0: bigint, in1: bigint, out0: bigint, out1: bigint): SwapLog {
  return {
    address: inventEvmAddress(),
    topics: [PANCAKE_V2_SWAP, asTopic(inventEvmAddress()), asTopic(recipient)],
    data: `0x${word(in0)}${word(in1)}${word(out0)}${word(out1)}`,
    blockNumber: "0x7295f95",
    transactionHash: `0x${"cd".repeat(32)}`,
    logIndex: "0x1",
  };
}

describe("decodeSwap", () => {
  it("reads a v3 swap, signed, and attributes it to the recipient", () => {
    const me = inventEvmAddress();
    const decoded = decodeSwap(v3Log(me, 1_500_000n, -2_000_000n));
    expect(decoded).not.toBeNull();
    expect(decoded!.version).toBe("v3");
    // The person is `topics[2]` — never the sender, which on this chain is
    // usually a router shared by hundreds of people (`docs/multichain.md` §4).
    expect(decoded!.recipient).toBe(me.toLowerCase());
    expect(decoded!.amount0).toBe(1_500_000n);
    expect(decoded!.amount1).toBe(-2_000_000n);
  });

  it("normalises a v2 swap into the same signed shape", () => {
    const me = inventEvmAddress();
    // v2 publishes four unsigned amounts; `in - out` is what makes both
    // versions one shape for everything downstream.
    const decoded = decodeSwap(v2Log(me, 900n, 0n, 0n, 400n));
    expect(decoded!.version).toBe("v2");
    expect(decoded!.amount0).toBe(900n);
    expect(decoded!.amount1).toBe(-400n);
  });

  it("attributes to the pool that emitted, not to the sender", () => {
    const me = inventEvmAddress();
    const log = v3Log(me, 1n, -1n);
    const decoded = decodeSwap(log)!;
    expect(decoded.pool).toBe(log.address.toLowerCase());
    expect(decoded.pool).not.toBe(decoded.recipient);
  });

  it("refuses a log it does not know, rather than decoding it partly", () => {
    const me = inventEvmAddress();
    const alien = { ...v3Log(me, 1n, 1n), topics: [`0x${"11".repeat(32)}`, asTopic(me), asTopic(me)] };
    expect(decodeSwap(alien)).toBeNull();
    // A known topic with a truncated payload is refused whole: a partial decode
    // would produce a trade with a plausible, wrong amount.
    expect(decodeSwap({ ...v3Log(me, 1n, 1n), data: "0x00" })).toBeNull();
    expect(decodeSwap({ ...v2Log(me, 1n, 0n, 0n, 1n), data: "0x00" })).toBeNull();
  });

  it("skips a log with no recipient topic", () => {
    expect(decodeSwap({ ...v3Log(inventEvmAddress(), 1n, 1n), topics: [PANCAKE_V3_SWAP] })).toBeNull();
  });
});

describe("swapFilterFor", () => {
  it("filters by recipient position, which is what makes this affordable", () => {
    const me = inventEvmAddress();
    const filter = swapFilterFor(me, "bnb");
    // Both versions in one subscription, and the wallet pinned to topics[2].
    expect(filter.topics[0]).toEqual([PANCAKE_V2_SWAP, PANCAKE_V3_SWAP]);
    expect(filter.topics[1]).toBeNull();
    expect(filter.topics[2]).toBe(asTopic(me).toLowerCase());
  });

  it("refuses a non-EVM chain", () => {
    expect(() => swapFilterFor(inventEvmAddress(), "solana")).toThrow();
  });
});

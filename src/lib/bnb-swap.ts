import { isEvm, type Chain } from "./chain";

/**
 * Decoding a PancakeSwap `Swap` log into the fields a trade needs.
 *
 * ## Pool level, never a router allowlist
 *
 * `docs/multichain.md` §4 fixes the rule and the reason: on Robinhood Chain a
 * router allowlist would have dropped 86% of the volume, because the largest
 * swap sender was unidentified — *"a drop that leaves no evidence"*. The same
 * holds on BSC, where routers and aggregators are many and pools are the thing
 * that actually emits. So attribution comes from the **log**, and the person is
 * `topics[2]`, the swap's recipient.
 *
 * ## The two topics, verified against mainnet
 *
 * Measured 2026-09-05 over ten blocks of BSC through the `arrival` Alchemy app:
 * 162 V2 logs across 109 pools, 19 V3 logs across 14 pools. Both shapes carry
 * `sender` in `topics[1]` and `recipient` in `topics[2]`; they differ in the
 * data payload, which is why each has its own decoder below.
 */

/** `Swap(address,uint256,uint256,uint256,uint256,address)` — PancakeSwap V2. */
export const PANCAKE_V2_SWAP =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

/** `Swap(address,address,int256,int256,uint160,uint128,int24)` — PancakeSwap V3. */
export const PANCAKE_V3_SWAP =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

export type SwapLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};

export type DecodedSwap = {
  /** The pool that emitted it. Never a router. */
  pool: string;
  /** `topics[2]`: who received the output. The person, not the tool. */
  recipient: string;
  /** Signed, in the token's own base units. Positive is in, negative is out. */
  amount0: bigint;
  amount1: bigint;
  version: "v2" | "v3";
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
};

/** A 32-byte word as an address: the low 20 bytes. */
function wordToAddress(word: string): string {
  return `0x${word.slice(-40)}`.toLowerCase();
}

/** Two's-complement `int256` from one 32-byte word. */
function signedWord(hex: string): bigint {
  const value = BigInt(`0x${hex}`);
  const limit = 1n << 255n;
  return value >= limit ? value - (1n << 256n) : value;
}

function words(data: string): string[] {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  return Array.from({ length: Math.floor(body.length / 64) }, (_, i) =>
    body.slice(i * 64, (i + 1) * 64),
  );
}

/**
 * One log to a swap, or `null` if it is not one we decode.
 *
 * **Returns `null` rather than throwing on a shape it does not know.** An
 * ingestor meets logs it did not ask for — a webhook filter widened by
 * somebody, a pool emitting a variant — and the alternative to skipping is an
 * exception that stops the batch. What must never happen is a *silent partial*
 * decode, so every field is read or the log is refused whole.
 */
export function decodeSwap(log: SwapLog): DecodedSwap | null {
  const [topic0, , recipientWord] = log.topics;
  if (!topic0 || !recipientWord) return null;

  const common = {
    pool: log.address.toLowerCase(),
    recipient: wordToAddress(recipientWord),
    blockNumber: Number(BigInt(log.blockNumber)),
    transactionHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
  };

  if (topic0.toLowerCase() === PANCAKE_V3_SWAP) {
    // v3 data: amount0, amount1, sqrtPriceX96, liquidity, tick — the first two
    // are signed and are all this needs.
    const w = words(log.data);
    if (w.length < 2) return null;
    return { ...common, version: "v3", amount0: signedWord(w[0]), amount1: signedWord(w[1]) };
  }

  if (topic0.toLowerCase() === PANCAKE_V2_SWAP) {
    // v2 data: amount0In, amount1In, amount0Out, amount1Out — unsigned, so the
    // signed pair is `in - out`, which makes both versions one shape downstream.
    const w = words(log.data);
    if (w.length < 4) return null;
    const [in0, in1, out0, out1] = w.map((x) => BigInt(`0x${x}`));
    return { ...common, version: "v2", amount0: in0 - out0, amount1: in1 - out1 };
  }

  return null;
}

/**
 * The `eth_getLogs` filter for one KOL wallet.
 *
 * **Filtered by recipient, not by pool.** Measured 2026-09-05: filtering
 * `topics[2]` cut a ten-block window from 25 logs to 2. That is what makes the
 * subscription cheap enough to exist — and it is required, because this plan
 * caps `eth_getLogs` at a **ten-block range**, so walking BSC's 192,000 blocks a
 * day would be 38,400 calls and about 2.7 hours of wall clock. Polling is not on
 * the table; this filter is the shape a webhook subscribes with.
 */
export function swapFilterFor(address: string, chain: Chain): {
  topics: (string | string[] | null)[];
} {
  if (!isEvm(chain)) throw new Error("swapFilterFor is for EVM chains");
  const padded = `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  return { topics: [[PANCAKE_V2_SWAP, PANCAKE_V3_SWAP], null, padded] };
}

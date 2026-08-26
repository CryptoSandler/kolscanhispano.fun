/**
 * Builds the subset of DexScreener's `/latest/dex/tokens/{mints}` response
 * shape that `prices.ts` reads, plus a matching Helius DAS `getAsset`
 * fixture for the fallback path.
 *
 * As with `fixtures/swap.ts`: every mint is passed in by the caller or
 * generated with `inventAddress()` — no real Solana address may enter this
 * repository (SECURITY.md), and a fixture is exactly the kind of file that
 * would otherwise accumulate one.
 */
import { inventAddress } from "../ids";

export type DexPairInput = {
  /** The mint this pair prices — becomes `baseToken.address`. */
  mint: string;
  /** The paired currency — SOL or USDC in practice. Defaults to a fresh mint. */
  quoteMint?: string;
  symbol?: string;
  name?: string;
  /** Decimal string, as DexScreener actually sends it. */
  priceUsd?: string;
  /** Decimal string, in units of the quote token. */
  priceNative?: string;
  /** A plain number, as DexScreener actually sends it — see `prices.ts` for why. */
  liquidityUsd?: number;
  /** Trades in the last 24h. Defaults to traded (`> 0`). */
  h24Txns?: number;
  imageUrl?: string;
  chainId?: string;
  pairUrl?: string;
};

/** One DexScreener pair object, shaped exactly like the live API's `pairs[]` entries. */
export function buildDexPair(input: DexPairInput): Record<string, unknown> {
  const quoteMint = input.quoteMint ?? inventAddress();
  const h24Txns = input.h24Txns ?? 1;
  return {
    chainId: input.chainId ?? "solana",
    dexId: "orca",
    url: input.pairUrl ?? `https://dexscreener.com/solana/${inventAddress()}`,
    pairAddress: inventAddress(),
    baseToken: { address: input.mint, name: input.name ?? "Fixture Token", symbol: input.symbol ?? "FIX" },
    quoteToken: { address: quoteMint, name: "quote", symbol: "QUOTE" },
    priceNative: input.priceNative ?? "1.0",
    priceUsd: input.priceUsd ?? "1.0",
    txns: { h24: { buys: Math.ceil(h24Txns / 2), sells: Math.floor(h24Txns / 2) } },
    liquidity: { usd: input.liquidityUsd ?? 10_000, base: 1, quote: 1 },
    ...(input.imageUrl ? { info: { imageUrl: input.imageUrl } } : {}),
  };
}

/** A `/latest/dex/tokens/{mints}` response body carrying the given pairs. */
export function buildDexResponse(pairs: Record<string, unknown>[]): { schemaVersion: string; pairs: Record<string, unknown>[] | null } {
  return { schemaVersion: "1.0.0", pairs: pairs.length === 0 ? null : pairs };
}

export type HeliusAssetInput = {
  symbol?: string;
  name?: string;
  decimals?: number;
  imageUrl?: string;
  /**
   * A price DAS could in principle report on `token_info.price_info`. Only
   * used by the test that proves the fallback never reads it — spec §5.7
   * forbids Helius as a price source no matter what the payload contains.
   */
  priceInfo?: { pricePerToken: number; currency: string };
};

/** A Helius `getAsset` response body, shaped like the live DAS API's result. */
export function buildHeliusAssetResponse(input: HeliusAssetInput): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: "kolscanhispano-prices",
    result: {
      interface: "FungibleToken",
      content: {
        metadata: { symbol: input.symbol ?? null, name: input.name ?? null },
        links: input.imageUrl ? { image: input.imageUrl } : {},
      },
      token_info: {
        ...(input.decimals !== undefined ? { decimals: input.decimals } : {}),
        ...(input.priceInfo ? { price_info: input.priceInfo } : {}),
      },
    },
  };
}

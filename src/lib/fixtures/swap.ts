/**
 * Builds the subset of a Helius enhanced transaction that `parseSwap` and
 * `parsePending` read. Every address is passed in by the caller or generated
 * with `inventAddress()`/`inventSignature()` — no address or signature
 * literal may enter this repository (SECURITY.md), and a fixture is exactly
 * the kind of file that would otherwise accumulate them.
 */
import { inventAddress, inventSignature } from "../ids";
import type { AccountData, EnhancedTx, TokenBalanceChange } from "../parse-swap";

export type ExtraTokenChange = {
  mint: string;
  decimals: number;
  rawTokenAmount: string;
};

export type SwapPayloadInput = {
  /** The wallet whose leg of the swap this fixture describes. */
  wallet: string;
  /** The traded mint. */
  mint: string;
  decimals: number;
  /** The wallet's net native (lamports) balance change. */
  nativeChangeLamports: number;
  /** The wallet's net raw balance change of `mint` (signed string). */
  tokenChangeRaw: string;
  /** The transaction fee, in lamports. */
  feeLamports: number;
  /** Whether `wallet` is the fee payer. */
  isFeePayer: boolean;
  /**
   * Additional SPL token legs this wallet held in the transaction — used to
   * build a stablecoin-quoted or token-to-token swap (two non-SOL legs) or a
   * persistent WSOL leg (mint = the wrapped-SOL mint) instead of a native
   * balance change.
   */
  extraTokenChanges?: ExtraTokenChange[];
  slot?: number | null;
  signature?: string;
  /** Unix seconds. Defaults to now. */
  timestamp?: number;
};

/** Builds a minimal Helius-shaped enhanced transaction for one wallet's swap. */
export function buildSwapPayload(input: SwapPayloadInput): EnhancedTx {
  const feePayer = input.isFeePayer ? input.wallet : inventAddress();

  const tokenBalanceChanges: TokenBalanceChange[] = [
    {
      userAccount: input.wallet,
      mint: input.mint,
      rawTokenAmount: { tokenAmount: input.tokenChangeRaw, decimals: input.decimals },
    },
    ...(input.extraTokenChanges ?? []).map((extra) => ({
      userAccount: input.wallet,
      mint: extra.mint,
      rawTokenAmount: { tokenAmount: extra.rawTokenAmount, decimals: extra.decimals },
    })),
  ];

  const accountData: AccountData[] = [
    {
      account: input.wallet,
      nativeBalanceChange: input.nativeChangeLamports,
      tokenBalanceChanges,
    },
  ];

  // A distinct fee payer needs its own accountData entry so `payload.feePayer`
  // resolves to something the payload actually accounts for, matching real
  // Helius output.
  if (feePayer !== input.wallet) {
    accountData.push({ account: feePayer, nativeBalanceChange: -input.feeLamports, tokenBalanceChanges: [] });
  }

  return {
    signature: input.signature ?? inventSignature(),
    slot: input.slot ?? null,
    timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
    type: "SWAP",
    fee: input.feeLamports,
    feePayer,
    accountData,
  };
}

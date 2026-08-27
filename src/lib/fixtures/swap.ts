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

/** One SPL leg of a swap, as `buildObservedSwapPayload` takes them. */
export type ObservedLeg = {
  mint: string;
  decimals: number;
  /** Signed raw base units. */
  rawTokenAmount: string;
  /**
   * The lamports this leg's **own token account** reports moving, on its own
   * `accountData` entry. Defaults to 0.
   *
   * It is a parameter because it was hardcoded to 0 here, and that made a
   * whole term of `settleTrade`'s residue bound —
   * `parse-swap.ts`'s `identifiableRentFor` — invisible to every fixture in
   * this file. The term was then exercised only by hand-patching the entry
   * after the fact, always with a rent-shaped value, and the case that was
   * neither zero nor rent (a WSOL account, whose lamports are the trade) went
   * unwritten until the corpus produced it. A fixture builder that cannot
   * express a real field is a blind spot, not a simplification.
   *
   * Rent when the account was opened or closed by the transaction, the
   * transferred lamports when the mint is wrapped SOL, 0 when it was neither.
   */
  nativeChangeLamports?: number;
};

export type ObservedSwapInput = {
  /** The wallet whose swap this fixture describes. */
  wallet: string;
  /** The wallet's net native (lamports) balance change. */
  nativeChangeLamports: number;
  /** Every SPL leg the wallet moved, one `accountData` entry each. */
  legs: ObservedLeg[];
  feeLamports: number;
  isFeePayer: boolean;
  slot?: number | null;
  signature?: string;
  /** Unix seconds. Defaults to now. */
  timestamp?: number;
};

/**
 * The same transaction as {@link buildSwapPayload}, in the layout Helius was
 * **measured** to emit.
 *
 * Task 6 sampled six real mainnet enhanced transactions and found all 34
 * balance changes in the same shape: the `accountData` entry carrying a token
 * change is the **token account** (`tokenAccount === account`), with the
 * owning wallet named only in `userAccount`, while the wallet's own entry
 * carries lamports and an empty `tokenBalanceChanges`. Not one entry had a
 * wallet's token change sitting on the wallet's own entry, which is exactly
 * what `buildSwapPayload` produces.
 *
 * The parser is entry-agnostic — `balanceChangesFor` collects by `userAccount`
 * and `nativeLamportsFor` by `account` — so the two layouts give identical
 * arithmetic, and the older builder's ~130 existing cases are not wrong. This
 * one exists so that new fixtures are built on a shape Helius was seen to
 * send rather than on one nothing has ever produced.
 *
 * `tokenAccount` itself is deliberately absent: `parse-swap.ts`'s
 * `TokenBalanceChange` is documented as "the subset of Helius's shape this
 * parser reads", and the parser never reads it. What the observed layout
 * actually changes — which entry a change hangs off, and which identity names
 * the wallet — is reproduced in full.
 */
export function buildObservedSwapPayload(input: ObservedSwapInput): EnhancedTx {
  const feePayer = input.isFeePayer ? input.wallet : inventAddress();

  const accountData: AccountData[] = [
    // The wallet's own entry: lamports, and no token changes at all.
    { account: input.wallet, nativeBalanceChange: input.nativeChangeLamports, tokenBalanceChanges: [] },
    // One entry per token account, keyed to the wallet only by `userAccount`.
    ...input.legs.map((leg) => ({
      account: inventAddress(), // the associated token account, not the wallet
      nativeBalanceChange: leg.nativeChangeLamports ?? 0,
      tokenBalanceChanges: [
        {
          userAccount: input.wallet,
          mint: leg.mint,
          rawTokenAmount: { tokenAmount: leg.rawTokenAmount, decimals: leg.decimals },
        },
      ],
    })),
  ];

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

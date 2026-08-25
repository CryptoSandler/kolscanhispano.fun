import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { buildSwapPayload } from "./fixtures/swap";
import { inventAddress, inventSignature } from "./ids";
import { addWallet } from "./wallets";
import {
  MalformedPayloadError,
  USDC_MINT,
  WSOL_MINT,
  evaluateSwap,
  parseErrorFor,
  parsePending,
  parseSwap,
  readTradeHeader,
  type EnhancedTx,
  type SwapOutcome,
  type TokenBalanceChange,
} from "./parse-swap";
import { storeRawTx } from "./raw-tx";

const wallet = { id: "w-1", kolId: "k-1", address: inventAddress() };
const mint = inventAddress();

/**
 * Payload fields are typed, so breaking one on purpose needs a cast. Every
 * deliberate mutation goes through these helpers instead of scattering
 * `as unknown as` through the tests, and each one names the exact field it
 * breaks — the point of these tests is which field is unreadable, not how
 * the cast is spelled.
 */
function setField(payload: EnhancedTx, field: string, value: unknown): EnhancedTx {
  (payload as unknown as Record<string, unknown>)[field] = value;
  return payload;
}

function dropField(payload: EnhancedTx, field: string): EnhancedTx {
  delete (payload as unknown as Record<string, unknown>)[field];
  return payload;
}

/** Breaks the `decimals` of the wallet's own (first) balance change. */
function setDecimals(payload: EnhancedTx, value: unknown): EnhancedTx {
  const amount = payload.accountData[0].tokenBalanceChanges[0].rawTokenAmount;
  (amount as unknown as Record<string, unknown>).decimals = value;
  return payload;
}

/**
 * Appends an untracked liquidity pool whose own leg cannot be read. Nothing
 * in it belongs to a tracked wallet, so nothing in it may cost one a trade.
 */
function withUnreadablePoolLeg(payload: EnhancedTx): EnhancedTx {
  const pool = inventAddress();
  payload.accountData.push({
    account: pool,
    nativeBalanceChange: 1_000_000_000,
    tokenBalanceChanges: [
      // Not a whole number of base units: the exact shape that raises
      // MalformedPayloadError when it is read.
      { userAccount: pool, mint: inventAddress(), rawTokenAmount: { tokenAmount: "-1.5", decimals: 6 } },
    ],
  });
  return payload;
}

/**
 * Appends an untracked liquidity pool, then breaks its entry however
 * `mutate` says. Nothing in it belongs to a tracked wallet.
 */
function withPoolAccount(payload: EnhancedTx, mutate: (entry: Record<string, unknown>) => void): EnhancedTx {
  const pool = inventAddress();
  const entry: Record<string, unknown> = {
    account: pool,
    nativeBalanceChange: 1_000_000_000,
    tokenBalanceChanges: [
      { userAccount: pool, mint: inventAddress(), rawTokenAmount: { tokenAmount: "-2000000", decimals: 6 } },
    ],
  };
  mutate(entry);
  payload.accountData.push(entry as unknown as (typeof payload.accountData)[number]);
  return payload;
}

/** Breaks the `account` identity of the wallet's own (first) accountData entry. */
function setOwnAccount(payload: EnhancedTx, value: unknown): EnhancedTx {
  (payload.accountData[0] as unknown as Record<string, unknown>).account = value;
  return payload;
}

/**
 * A buy whose SOL side is split down the middle: 0.5 SOL through a standing
 * WSOL account (keyed off `userAccount`) and 0.5 SOL natively (keyed off
 * `account`). Truth: `buy tok=2 sol=1 price_sol=0.5`. The sell mirrors it.
 */
function splitSolSide(address: string, side: "buy" | "sell", theMint: string): EnhancedTx {
  return buildSwapPayload({
    wallet: address,
    mint: theMint,
    decimals: 6,
    nativeChangeLamports: side === "buy" ? -(500_000_000 + 5_000) : 500_000_000 - 5_000,
    tokenChangeRaw: side === "buy" ? "2000000" : "-2000000",
    feeLamports: 5_000,
    isFeePayer: true,
    extraTokenChanges: [
      { mint: WSOL_MINT, decimals: 9, rawTokenAmount: side === "buy" ? "-500000000" : "500000000" },
    ],
  });
}

/**
 * The **real ATA shape**: the wallet's WSOL leg lives on its own
 * `accountData` entry, whose `account` is the token account rather than the
 * wallet, and whose change carries `userAccount: <wallet>`. Half the SOL
 * side is native (keyed off `account`), half is WSOL (keyed off
 * `userAccount`). Truth: `buy tok=2 sol=1 price_sol=0.5`.
 */
function splitSolSideViaAta(address: string, side: "buy" | "sell", theMint: string): EnhancedTx {
  const payload = buildSwapPayload({
    wallet: address,
    mint: theMint,
    decimals: 6,
    nativeChangeLamports: side === "buy" ? -(500_000_000 + 5_000) : 500_000_000 - 5_000,
    tokenChangeRaw: side === "buy" ? "2000000" : "-2000000",
    feeLamports: 5_000,
    isFeePayer: true,
  });
  payload.accountData.push({
    account: inventAddress(), // the ATA, not the wallet
    nativeBalanceChange: 0,
    tokenBalanceChanges: [
      {
        userAccount: address,
        mint: WSOL_MINT,
        rawTokenAmount: { tokenAmount: side === "buy" ? "-500000000" : "500000000", decimals: 9 },
      },
    ],
  });
  return payload;
}

/** Applies `mutate` to the ATA entry `splitSolSideViaAta` appended. */
function breakAta(payload: EnhancedTx, mutate: (entry: Record<string, unknown>) => void): EnhancedTx {
  mutate(payload.accountData[payload.accountData.length - 1] as unknown as Record<string, unknown>);
  return payload;
}

/**
 * A 1-SOL buy of 2 tokens whose **token** side is reported as two changes of
 * one token each, the second on its own `accountData` entry (a second token
 * account of the same mint). Truth: `buy tok=2 sol=1 price_sol=0.5`; hide the
 * second change and the survivor reads as `tok=1 price_sol=1`.
 *
 * The second change has to live on its own entry to exercise this: a change
 * sitting on the wallet's own entry is already covered by the `account ===
 * address` rule, which raises whatever its `userAccount` says.
 */
function splitTokenSide(address: string, theMint: string): EnhancedTx {
  const payload = buildSwapPayload({
    wallet: address,
    mint: theMint,
    decimals: 6,
    nativeChangeLamports: -1_000_005_000,
    tokenChangeRaw: "1000000",
    feeLamports: 5_000,
    isFeePayer: true,
  });
  payload.accountData.push({
    account: inventAddress(), // a second token account, not the wallet
    nativeBalanceChange: 0,
    tokenBalanceChanges: [
      { userAccount: address, mint: theMint, rawTokenAmount: { tokenAmount: "1000000", decimals: 6 } },
    ],
  });
  return payload;
}

/**
 * A genuine two-leg swap whose second leg sits on its own `accountData`
 * entry. Truth: `unsupported_quote` — a swap this batch cannot price at all.
 */
function twoLegViaAta(address: string, theMint: string, otherMint: string): EnhancedTx {
  const payload = buildSwapPayload({
    wallet: address,
    mint: theMint,
    decimals: 6,
    nativeChangeLamports: -1_000_005_000,
    tokenChangeRaw: "2000000",
    feeLamports: 5_000,
    isFeePayer: true,
  });
  payload.accountData.push({
    account: inventAddress(),
    nativeBalanceChange: 0,
    tokenBalanceChanges: [
      { userAccount: address, mint: otherMint, rawTokenAmount: { tokenAmount: "-3000000", decimals: 6 } },
    ],
  });
  return payload;
}

/** Breaks the identity of the wallet's own (first) balance change. */
function setOwnUserAccount(payload: EnhancedTx, value: unknown): EnhancedTx {
  (payload.accountData[0].tokenBalanceChanges[0] as unknown as Record<string, unknown>).userAccount = value;
  return payload;
}

/** Sets the `tokenAmount` of the wallet's own (first) balance change. */
function setOwnRawAmount(payload: EnhancedTx, value: unknown): EnhancedTx {
  const amount = payload.accountData[0].tokenBalanceChanges[0].rawTokenAmount;
  (amount as unknown as Record<string, unknown>).tokenAmount = value;
  return payload;
}

/**
 * Everything `parsePending` reads on behalf of one wallet: its leg, plus the
 * transaction header a trade needs. Validation is narrow and lazy now, so a
 * malformed `timestamp` is only reached by a payload that produces a trade —
 * asserting on `evaluateSwap` alone would miss it.
 */
function readForWallet(
  payload: EnhancedTx,
  w: { id: string; kolId: string; address: string },
): ReturnType<typeof evaluateSwap> {
  const result = evaluateSwap(payload, w);
  if (result.outcome === "trade") readTradeHeader(payload);
  return result;
}

describe("parseSwap", () => {
  it("reads a buy: SOL out, tokens in", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      // 1 SOL spent (1_000_000_000 lamports) plus the 5_000 lamport fee,
      // which nativeBalanceChange already includes for the fee payer.
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000", // 2 tokens in
      feeLamports: 5_000,
      isFeePayer: true,
    });

    const trade = parseSwap(payload, wallet)!;
    expect(trade.side).toBe("buy");
    expect(trade.tokenAmount).toBeCloseTo(2, 9);
    expect(trade.solAmount).toBeCloseTo(1, 9); // fee excluded from the trade amount
    expect(trade.feeSol).toBeCloseTo(0.000005, 9);
    expect(trade.mint).toBe(mint);
    expect(trade.instructionIndex).toBe(0);
  });

  it("reads a sell: tokens out, SOL in", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      // 2 SOL received (2_000_000_000 lamports) less the 5_000 lamport fee.
      nativeChangeLamports: 1_999_995_000,
      tokenChangeRaw: "-2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });

    const trade = parseSwap(payload, wallet)!;
    expect(trade.side).toBe("sell");
    expect(trade.solAmount).toBeCloseTo(2, 9);
  });

  it("does not charge the fee to a wallet that did not pay it", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -1_000_000_000, // 1 SOL, no fee involved
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: false,
    });

    const trade = parseSwap(payload, wallet)!;
    expect(trade.solAmount).toBeCloseTo(1, 9);
    expect(trade.feeSol).toBe(0);
  });

  it("reads a sell from a wallet that did not pay the fee", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: 2_000_000_000, // 2 SOL received, no fee deducted
      tokenChangeRaw: "-2000000",
      feeLamports: 5_000,
      isFeePayer: false,
    });

    const trade = parseSwap(payload, wallet)!;
    expect(trade.side).toBe("sell");
    expect(trade.solAmount).toBeCloseTo(2, 9);
    expect(trade.feeSol).toBe(0);
  });

  it("ignores a transaction that does not touch this wallet", () => {
    const payload = buildSwapPayload({
      wallet: inventAddress(),
      mint,
      decimals: 6,
      nativeChangeLamports: -1_000_000_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    expect(parseSwap(payload, wallet)).toBeNull();
  });

  it("ignores a transaction with no SOL leg", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: 0,
      tokenChangeRaw: "2000000",
      feeLamports: 0,
      isFeePayer: false,
    });
    expect(parseSwap(payload, wallet)).toBeNull();
    // Named, so the invariant table can assert this shape specifically
    // instead of excluding every outcome that happens to share a name.
    expect(evaluateSwap(payload, wallet).outcome).toBe("no_sol_leg");
  });

  it("respects token decimals", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 9,
      nativeChangeLamports: -1_000_000_000,
      tokenChangeRaw: "2000000000",
      feeLamports: 0,
      isFeePayer: false,
    });
    expect(parseSwap(payload, wallet)!.tokenAmount).toBeCloseTo(2, 9);
  });

  it("uses a persistent WSOL leg as the SOL side when native balance carries only the fee", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -5_000, // gas only; the swap itself moved a WSOL token account
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: WSOL_MINT, decimals: 9, rawTokenAmount: "-1000000000" }],
    });

    const trade = parseSwap(payload, wallet)!;
    expect(trade.side).toBe("buy");
    expect(trade.solAmount).toBeCloseTo(1, 9);
    expect(trade.feeSol).toBeCloseTo(0.000005, 9);
  });

  it("sums a native leg and a WSOL leg together rather than treating WSOL as a fallback", () => {
    // Review round 1, finding 1, worked example: a buy funded from a
    // persistent WSOL account, in a transaction that also pays 2_039_280
    // lamports of rent for a new token ATA. nativeBalanceChange therefore
    // carries the fee AND the rent (neither of which is the swap itself),
    // while the swap's 1 SOL is entirely in the WSOL leg. The old fallback
    // (WSOL used only when the native leg nets to exactly zero) missed the
    // WSOL leg completely here and reported ~0.00204 SOL against a true
    // combined delta of 1.00203928 SOL.
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -(5_000 + 2_039_280),
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: WSOL_MINT, decimals: 9, rawTokenAmount: "-1000000000" }],
    });

    const trade = parseSwap(payload, wallet)!;
    expect(trade).not.toBeNull();
    expect(trade.side).toBe("buy");
    // (nativeChange + fee) + wsolLeg, magnitude: 2_039_280 + 1_000_000_000 = 1_002_039_280 lamports.
    expect(trade.solAmount).toBeCloseTo(1.00203928, 8);
    expect(trade.feeSol).toBeCloseTo(0.000005, 9);
  });

  it("rejects a sell whose net SOL/WSOL delta is still negative, instead of booking it as profit", () => {
    // Review round 1, finding 2, worked example: a Jito tip larger than the
    // sale proceeds. feeAdjustedNative = -9_005_000 + 5_000 = -9_000_000: a
    // net outflow, even though the token leg says "sell". The old code took
    // Math.abs and reported `sell, solAmount: 0.009` — manufacturing
    // proceeds, and profit, out of a loss.
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -9_005_000,
      tokenChangeRaw: "-2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });

    expect(parseSwap(payload, wallet)).toBeNull();
    expect(evaluateSwap(payload, wallet).outcome).toBe("sol_leg_wrong_direction");
  });

  it("rejects a buy whose net SOL/WSOL delta is positive, instead of booking it as a purchase", () => {
    // Mirror case: a rent refund (or similar) leaves the native delta
    // positive even though the token leg says "buy".
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: 4_000_000,
      tokenChangeRaw: "2000000",
      feeLamports: 0,
      isFeePayer: false,
    });

    expect(parseSwap(payload, wallet)).toBeNull();
    expect(evaluateSwap(payload, wallet).outcome).toBe("sol_leg_wrong_direction");
  });

  it("does not record a SOL<->USDC rotation as a trade (spec §4.3)", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint: USDC_MINT,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    expect(parseSwap(payload, wallet)).toBeNull();
    // A named outcome, not a bare "no_trade": this is a spec exclusion, and
    // the invariant test below asserts it by name rather than excluding a
    // whole catch-all outcome from its table.
    expect(evaluateSwap(payload, wallet).outcome).toBe("stable_rotation");
    expect(parseErrorFor("stable_rotation")).toBeNull();
  });

  it("returns null for a token-to-token swap and flags it as an unsupported quote", () => {
    const otherMint = inventAddress();
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -5_000, // gas only; both legs are SPL tokens
      tokenChangeRaw: "-1000000",
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: otherMint, decimals: 6, rawTokenAmount: "2000000" }],
    });

    expect(parseSwap(payload, wallet)).toBeNull();
    expect(evaluateSwap(payload, wallet).outcome).toBe("unsupported_quote");
  });

  it("does not flag an ordinary single-mint swap as an unsupported quote", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    expect(evaluateSwap(payload, wallet).outcome).toBe("trade");
  });

  it("treats a 1-raw-unit router remainder as dust, not a second leg", () => {
    // A router can leave a literal 1-raw-unit remainder on an intermediate
    // mint. At 6 decimals that is one millionth of a token, exactly the
    // dust floor, so the remainder is dropped and the real leg stands
    // alone. Judged on the leg's own quantity, never against the other leg.
    const dustMint = inventAddress();
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: dustMint, decimals: 6, rawTokenAmount: "1" }],
    });

    const trade = parseSwap(payload, wallet)!;
    expect(trade).not.toBeNull();
    expect(trade.mint).toBe(mint);
    expect(trade.side).toBe("buy");
    expect(trade.solAmount).toBeCloseTo(1, 9);
  });

  it("does not treat a 2-raw-unit leg as dust: the swap is unsupported, not silently reduced to one leg", () => {
    // Review round 2: dust is judged absolutely, never relatively. A leg of
    // 2 raw units is one unit above the floor and must survive as a real
    // leg, even though it would previously have been dropped as "dust"
    // relative to a much larger dominant leg.
    const otherMint = inventAddress();
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -5_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: otherMint, decimals: 6, rawTokenAmount: "2" }],
    });
    expect(evaluateSwap(payload, wallet).outcome).toBe("unsupported_quote");
  });

  it("still flags two comparably-sized legs as an unsupported quote", () => {
    const otherMint = inventAddress();
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -5_000,
      tokenChangeRaw: "-1000000",
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: otherMint, decimals: 6, rawTokenAmount: "1500000" }],
    });
    expect(evaluateSwap(payload, wallet).outcome).toBe("unsupported_quote");
  });

  it("does not fabricate a near-zero cost basis from a token<->token swap with a lopsided count ratio", () => {
    // Review round 2, the fabrication this finding is about: a relative
    // ("ratio") dust filter compares raw counts across two different mints
    // as if they were values. 1,000,000 units of a 0-decimal mint against
    // 0.5 units of a 6-decimal mint is a 2,000,000x count ratio, but both
    // are genuine legs — there is no price data here to say one of them
    // doesn't count. The old ratio-based filter dropped the smaller leg and
    // reported `buy, tokenAmount 1000000, solAmount 0.00203928` (the ATA
    // rent below, misread as the whole trade). The fix must refuse to
    // guess: two real legs survive, and the swap is unsupported_quote.
    const mintA = inventAddress(); // 0 decimals: raw count IS the human amount
    const mintB = inventAddress(); // 6 decimals
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint: mintA,
      decimals: 0,
      tokenChangeRaw: "1000000", // 1,000,000 units in
      nativeChangeLamports: -(5_000 + 2_039_280), // ordinary fee + ATA rent
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: mintB, decimals: 6, rawTokenAmount: "-500000" }], // 0.5 units out
    });

    expect(parseSwap(payload, wallet)).toBeNull();
    expect(evaluateSwap(payload, wallet).outcome).toBe("unsupported_quote");
  });

  it("does not fabricate a trade from a meme<->USDC swap with a ~200,000x count ratio", () => {
    // Ten million units of a 0-decimal ("sub-cent") meme token against 50
    // USDC is a 200,000x count ratio — the same shape the review flagged as
    // routine, not a corner case. With only a gas-only native change (no
    // rent), the old ratio filter dropped the USDC leg as dust, leaving a
    // single-leg "trade" whose SOL side then netted to zero and vanished as
    // `no_trade` with no error — reopening the round-1 silent-drop hole.
    const memeMint = inventAddress();
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint: memeMint,
      decimals: 0,
      tokenChangeRaw: "10000000", // 10,000,000 meme units in
      nativeChangeLamports: -5_000, // gas only
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: USDC_MINT, decimals: 6, rawTokenAmount: "-50000000" }], // 50 USDC out
    });

    expect(parseSwap(payload, wallet)).toBeNull();
    expect(evaluateSwap(payload, wallet).outcome).toBe("unsupported_quote");
  });

  it("does not drop a sole 1-raw-unit leg: it can be the entire trade, not a router remainder", () => {
    // Review round 3: round 2 dropped dropDust's `length <= 1` guard, so a
    // wallet's ONLY token leg — e.g. one whole unit of a 0-decimal mint —
    // was itself being filtered out as "dust", turning a real buy/sell into
    // `no_trade`. Measured against the round-2 code before this fix: a
    // 0-decimal mint, one token bought for 1.000005 SOL, sole leg, returned
    // `no_trade` instead of `buy, tokenAmount 1, solAmount 1`.
    const oneUnitMint = inventAddress();
    const buy = buildSwapPayload({
      wallet: wallet.address,
      mint: oneUnitMint,
      decimals: 0,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "1",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    const buyTrade = parseSwap(buy, wallet)!;
    expect(buyTrade).not.toBeNull();
    expect(buyTrade.side).toBe("buy");
    expect(buyTrade.tokenAmount).toBeCloseTo(1, 9);
    expect(buyTrade.solAmount).toBeCloseTo(1, 9);

    const sell = buildSwapPayload({
      wallet: wallet.address,
      mint: oneUnitMint,
      decimals: 0,
      nativeChangeLamports: 1_999_995_000,
      tokenChangeRaw: "-1",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    const sellTrade = parseSwap(sell, wallet)!;
    expect(sellTrade).not.toBeNull();
    expect(sellTrade.side).toBe("sell");
    expect(sellTrade.solAmount).toBeCloseTo(2, 9);
  });

  it("still applies the wrong-direction check to a sole 1-raw-unit leg", () => {
    // Round 3 finding: the missing guard also pre-empted the direction
    // check, since a sole dust-eaten leg short-circuited to `no_trade`
    // before the SOL delta's sign was ever examined.
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint: inventAddress(),
      decimals: 0,
      nativeChangeLamports: -9_005_000, // a tip larger than the sale proceeds
      tokenChangeRaw: "-1",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    expect(parseSwap(payload, wallet)).toBeNull();
    expect(evaluateSwap(payload, wallet).outcome).toBe("sol_leg_wrong_direction");
  });

  it("does not fabricate a cost basis from a sole 1-raw-unit leg of a 6-decimal mint", () => {
    // Review round 4: the round-3 arity guard exempted a sole leg from the
    // dust floor whatever the mint's decimals, so one millionth of a token
    // was booked as a whole trade priced off the ATA rent left in the native
    // delta. Measured against the round-3 code:
    //   buy tok=0.000001 sol=0.00203928 -> price_sol 2039.28
    // A fabricated cost basis in `trade` and `position`. Dust is now judged
    // on the token quantity (raw / 10**decimals), so this is `dust_only`.
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint: inventAddress(),
      decimals: 6,
      nativeChangeLamports: -(2_039_280 + 5_000), // ATA rent plus gas
      tokenChangeRaw: "1",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    expect(parseSwap(payload, wallet)).toBeNull();
    expect(evaluateSwap(payload, wallet).outcome).toBe("dust_only");
  });

  it("does not fabricate a cost basis from a sole 1-raw-unit leg of a 9-decimal mint", () => {
    // The same defect at nine decimals, where one raw unit is a billionth of
    // a token. Measured against the round-3 code:
    //   buy tok=1e-9 sol=0.004995 -> price_sol 4,995,000
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint: inventAddress(),
      decimals: 9,
      nativeChangeLamports: -5_000_000,
      tokenChangeRaw: "1",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    expect(parseSwap(payload, wallet)).toBeNull();
    expect(evaluateSwap(payload, wallet).outcome).toBe("dust_only");
  });

  it("judges the dust floor on token quantity, so the same raw count differs by decimals", () => {
    // The whole point of the rule, stated as one comparison: an identical
    // raw count is a whole token at 0 decimals and a millionth of one at 6.
    const build = (decimals: number) =>
      buildSwapPayload({
        wallet: wallet.address,
        mint: inventAddress(),
        decimals,
        nativeChangeLamports: -1_000_005_000,
        tokenChangeRaw: "1",
        feeLamports: 5_000,
        isFeePayer: true,
      });
    expect(evaluateSwap(build(0), wallet).outcome).toBe("trade");
    expect(evaluateSwap(build(6), wallet).outcome).toBe("dust_only");
    expect(evaluateSwap(build(9), wallet).outcome).toBe("dust_only");
  });

  it("keeps a leg one raw unit above the floor at 6 decimals", () => {
    // The floor is 1/1,000,000 of a token inclusive; 2/1,000,000 is a real
    // leg. Sole leg here, so the guard being absent must not swallow it.
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint: inventAddress(),
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    expect(evaluateSwap(payload, wallet).outcome).toBe("trade");
  });

  it("converts a WSOL leg to lamports by its reported decimals rather than assuming nine", () => {
    // The same unit error one level down: the SOL side sums native lamports
    // with the WSOL token leg, which is only the identity because WSOL has 9
    // decimals. Reading the raw amount without consulting the decimals the
    // payload reports would add a 6-decimal figure straight into a lamports
    // total and understate the SOL side by 1000x.
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -5_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
      // 1 WSOL expressed at 6 decimals: 1,000,000 raw units, not 1e9.
      extraTokenChanges: [{ mint: WSOL_MINT, decimals: 6, rawTokenAmount: "-1000000" }],
    });
    const trade = parseSwap(payload, wallet)!;
    expect(trade.side).toBe("buy");
    expect(trade.solAmount).toBeCloseTo(1, 9); // 1 SOL, not 0.001
  });

  it("sums two balance changes of one mint at a common scale, not as raw counts", () => {
    // Two token accounts of the same mint reported at different decimals are
    // not addable as raw counts: 1,000,000 units at 6 decimals is 1 token,
    // 1,000,000 at 9 decimals is 0.001. Summing them unscaled would report
    // 2 tokens instead of 1.001.
    const splitMint = inventAddress();
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint: splitMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "1000000", // 1 token
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: splitMint, decimals: 9, rawTokenAmount: "1000000" }], // 0.001 token
    });
    const trade = parseSwap(payload, wallet)!;
    expect(trade.mint).toBe(splitMint);
    expect(trade.tokenAmount).toBeCloseTo(1.001, 9);
  });

  // ---- Task 9b: the fields that were still outside the require* discipline ----

  const cleanBuy = () =>
    buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });

  it("refuses a decimals it cannot read instead of silently reading it as zero", () => {
    // Consequence 3, measured against 7788380: `decimals: -3` on this exact
    // 2,000,000-raw leg wrote `tokenAmount 2000000, price_sol 5e-7` into
    // `trade` and `position` — a cost basis wrong by a factor of a million,
    // on the number the leaderboard ranks. `normalizeDecimals` mapped
    // anything unreadable to 0 while every neighbouring field raised.
    // `NaN` produced the same trade.
    for (const broken of [-3, Number.NaN, 6.5, 40, "6", null, undefined]) {
      expect(() => evaluateSwap(setDecimals(cleanBuy(), broken), wallet)).toThrow(MalformedPayloadError);
    }
    // The boundaries of the accepted range are still accepted.
    expect(evaluateSwap(setDecimals(cleanBuy(), 0), wallet).outcome).toBe("trade");
    expect(evaluateSwap(setDecimals(cleanBuy(), 32), wallet).outcome).toBe("dust_only"); // 2e-32 of a token
  });

  it("requires a fee, while an absent nativeBalanceChange is legitimately zero", () => {
    // Spec §4.4 makes the fee material and Helius always sends it, so an
    // absent `fee` is an unreadable payload. Measured against 7788383's
    // `requireLamports` (absent -> 0n): a missing fee on this fee-payer buy
    // silently wrote `sol_amount 1.000005, price_sol 0.5000025` instead of
    // 1 and 0.5 — the fee dropped straight out of the §4.4 arithmetic.
    expect(() => evaluateSwap(dropField(cleanBuy(), "fee"), wallet)).toThrow(MalformedPayloadError);
    for (const broken of [null, "5000", 5_000.5, Number.NaN, -1]) {
      expect(() => evaluateSwap(setField(cleanBuy(), "fee", broken), wallet)).toThrow(MalformedPayloadError);
    }

    // The other half of the asymmetry: an account that simply did not move
    // its native balance is ordinary, and its swap still reads. The SOL side
    // here is entirely a WSOL leg.
    const noNative = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: 0,
      tokenChangeRaw: "2000000",
      feeLamports: 0,
      isFeePayer: false,
      extraTokenChanges: [{ mint: WSOL_MINT, decimals: 9, rawTokenAmount: "-1000000000" }],
    });
    delete (noNative.accountData[0] as Partial<(typeof noNative.accountData)[number]>).nativeBalanceChange;
    const trade = parseSwap(noNative, wallet)!;
    expect(trade.side).toBe("buy");
    expect(trade.solAmount).toBeCloseTo(1, 9);

    // But a present-and-unreadable one is malformed, not coerced to zero:
    // coercing would turn an unreadable SOL leg into a silent `no_sol_leg`.
    for (const broken of ["-1000005000", -1_000_005_000.5, Number.NaN]) {
      const payload = cleanBuy();
      (payload.accountData[0] as unknown as Record<string, unknown>).nativeBalanceChange = broken;
      expect(() => evaluateSwap(payload, wallet)).toThrow(MalformedPayloadError);
    }

    // `null` is the one value that must NOT throw: like an absent field, it
    // reads as "this account's native balance did not move". Built here
    // without a fee to pay, so the whole SOL side really is zero.
    const nullNative = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: 0,
      tokenChangeRaw: "2000000",
      feeLamports: 0,
      isFeePayer: false,
    });
    (nullNative.accountData[0] as unknown as Record<string, unknown>).nativeBalanceChange = null;
    expect(evaluateSwap(nullNative, wallet).outcome).toBe("no_sol_leg");
  });

  it("requires a feePayer it can read rather than silently making every wallet a non-fee-payer", () => {
    // `wallet.address === payload.feePayer` is false for any non-string, so
    // an unreadable feePayer would drop the fee out of the §4.4 arithmetic
    // for every wallet in the row without a word.
    expect(() => evaluateSwap(dropField(cleanBuy(), "feePayer"), wallet)).toThrow(MalformedPayloadError);
    expect(() => evaluateSwap(setField(cleanBuy(), "feePayer", 12345), wallet)).toThrow(MalformedPayloadError);
  });

  it("reads the transaction header through the same discipline", () => {
    // Consequence 1, measured against 7788380 through parsePending: a
    // missing `timestamp` reached Postgres as `invalid input syntax for type
    // timestamp with time zone: "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN"`, a
    // non-string `signature` reached `encrypt()` as `TypeError: The "data"
    // argument must be of type string ... Received type number (12345)`, and
    // a non-numeric `slot` reached Postgres as `invalid input syntax for
    // type bigint: "abc"`. All three left the row `parsed_at NULL,
    // parse_error NULL`, to be re-selected and to throw again forever.
    for (const broken of [undefined, null, 0, -1, "1750000000", 1.5, Date.now()]) {
      expect(() => readTradeHeader(setField(cleanBuy(), "timestamp", broken))).toThrow(MalformedPayloadError);
    }
    for (const broken of [undefined, null, 12345, ""]) {
      expect(() => readTradeHeader(setField(cleanBuy(), "signature", broken))).toThrow(MalformedPayloadError);
    }
    for (const broken of ["abc", "555", 1.5, -1, Number.NaN]) {
      expect(() => readTradeHeader(setField(cleanBuy(), "slot", broken))).toThrow(MalformedPayloadError);
    }

    // A slot is genuinely nullable (task decision 1), so absent is null, not
    // an error — the one field in the header that has a legitimate absence.
    expect(readTradeHeader(dropField(cleanBuy(), "slot")).slot).toBeNull();
    expect(readTradeHeader(setField(cleanBuy(), "slot", null)).slot).toBeNull();

    const seconds = 1_770_000_000;
    const header = readTradeHeader(setField(setField(cleanBuy(), "timestamp", seconds), "slot", 555));
    expect(header.blockTime.getTime()).toBe(seconds * 1000);
    expect(header.slot).toBe(555);
    expect(typeof header.signature).toBe("string");
  });

  it("does not let a malformed leg on an untracked account cost a tracked wallet its trade", () => {
    // Consequence 4: validation used to walk the entire payload before any
    // wallet was evaluated, so an unreadable leg on an account belonging to
    // no tracked wallet — a liquidity pool the parser never reads — made the
    // whole row `malformed_payload` and wrote zero trades. Measured against
    // 7788380 end to end: 0 trades, `parse_error = 'malformed_payload'`,
    // even though this wallet's own leg is perfectly readable.
    const payload = withUnreadablePoolLeg(cleanBuy());
    const trade = parseSwap(payload, wallet)!;
    expect(trade).not.toBeNull();
    expect(trade.side).toBe("buy");
    expect(trade.solAmount).toBeCloseTo(1, 9);
    expect(trade.tokenAmount).toBeCloseTo(2, 9);
  });

  it("bounds a raw token amount to the u64 an SPL amount actually is", () => {
    // Review of 9b, the seventh instance of the unit defect and the only one
    // that was not requeueable. A 321-digit tokenAmount on the token leg AND
    // on a WSOL leg both became Infinity at Number(), so
    // priceSol = Infinity / Infinity = NaN. Measured end to end against
    // 4d401fb: trade{token_amount Infinity, sol_amount Infinity,
    // price_sol NaN}, position dirty, parsed_at SET, parse_error NULL. The
    // token leg alone gave price_sol 0.
    const huge = "9".repeat(321);
    expect(() => evaluateSwap(setOwnRawAmount(cleanBuy(), huge), wallet)).toThrow(MalformedPayloadError);
    expect(() =>
      evaluateSwap(
        buildSwapPayload({
          wallet: wallet.address,
          mint,
          decimals: 6,
          nativeChangeLamports: -5_000,
          tokenChangeRaw: huge,
          feeLamports: 5_000,
          isFeePayer: true,
          extraTokenChanges: [{ mint: WSOL_MINT, decimals: 9, rawTokenAmount: `-${huge}` }],
        }),
        wallet,
      ),
    ).toThrow(MalformedPayloadError);

    // The boundary is the u64 domain itself, not a digit count.
    const u64Max = (2n ** 64n - 1n).toString();
    expect(evaluateSwap(setOwnRawAmount(cleanBuy(), u64Max), wallet).outcome).toBe("trade");
    expect(() => evaluateSwap(setOwnRawAmount(cleanBuy(), (2n ** 64n).toString()), wallet)).toThrow(
      MalformedPayloadError,
    );
    expect(() => evaluateSwap(setOwnRawAmount(cleanBuy(), `-${2n ** 64n}`), wallet)).toThrow(MalformedPayloadError);
  });

  it("rejects a raw token amount that is a JSON number too large to be exact", () => {
    // `12345678901234567890` as a JSON number is not one integer but a
    // double standing for 12345678901234567000: accepting it re-rounds the
    // amount without a word. Every sibling guard here uses
    // Number.isSafeInteger; this one used Number.isInteger.
    expect(() => evaluateSwap(setOwnRawAmount(cleanBuy(), 12345678901234567890), wallet)).toThrow(
      MalformedPayloadError,
    );
    // The same digits as a *string* are exact and inside the u64 domain, so
    // they are read as written. The distinction is exactness, not size.
    const trade = parseSwap(setOwnRawAmount(cleanBuy(), "12345678901234567890"), wallet)!;
    expect(trade.side).toBe("buy");
    // A safe integer as a number is still fine.
    expect(evaluateSwap(setOwnRawAmount(cleanBuy(), 2_000_000), wallet).outcome).toBe("trade");
  });

  it("skips an unattributable identity only where it provably moved nothing", () => {
    // The leniency exists for the documented Helius `userAccount: ""`, but
    // it only survives where the dropped change could not have moved a
    // number: a zero-valued change, an `account` with no lamport movement,
    // and a row where this wallet has no leg at all. Everything else is
    // refused — see the paired test below.
    for (const identity of ["", null, 42, undefined]) {
      const zeroChange = withPoolAccount(cleanBuy(), (entry) => {
        const change = (entry.tokenBalanceChanges as Record<string, unknown>[])[0];
        change.userAccount = identity;
        (change.rawTokenAmount as Record<string, unknown>).tokenAmount = "0";
      });
      expect(parseSwap(zeroChange, wallet)!.solAmount).toBeCloseTo(1, 9);

      // No lamport movement on this entry: an unreadable `account` is only
      // skippable when nothing moved through it.
      const poolAccount = withPoolAccount(cleanBuy(), (entry) => {
        entry.account = identity;
        entry.nativeBalanceChange = 0;
        (((entry.tokenBalanceChanges as Record<string, unknown>[])[0]
          .rawTokenAmount as Record<string, unknown>).tokenAmount = "0");
      });
      expect(parseSwap(poolAccount, wallet)!.solAmount).toBeCloseTo(1, 9);
    }

    // A wallet with no leg of its own: the transaction does not concern it,
    // so nothing is being reported short and nothing is refused.
    const notOurs = withPoolAccount(
      buildSwapPayload({
        wallet: inventAddress(),
        mint,
        decimals: 6,
        nativeChangeLamports: -1_000_005_000,
        tokenChangeRaw: "2000000",
        feeLamports: 5_000,
        isFeePayer: true,
      }),
      (entry) => {
        (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = "";
      },
    );
    expect(evaluateSwap(notOurs, wallet).outcome).toBe("no_token_leg");
  });

  it("refuses an unattributable non-zero change when this wallet has a leg of its own", () => {
    // Review of 9b round 2. The WSOL leg sits on a SEPARATE accountData
    // entry in the real ATA shape — `account` is the token account, not the
    // wallet — so skipping it for an unreadable `userAccount` dropped the
    // WSOL half of the SOL side and kept the native half. Measured against
    // 171a6ea:
    //   truth                        tok=2 sol=1   price_sol=0.5
    //   userAccount unreadable (ATA) tok=2 sol=0.5 price_sol=0.25
    // with parse_error NULL, parsed_at SET and position dirty — in the very
    // shape the leniency was introduced for.
    for (const side of ["buy", "sell"] as const) {
      const truth = parseSwap(splitSolSideViaAta(wallet.address, side, mint), wallet)!;
      expect(truth.solAmount).toBeCloseTo(1, 9);
      expect(truth.solAmount / truth.tokenAmount).toBeCloseTo(0.5, 9);

      for (const identity of ["", null, 42, undefined]) {
        const broken = breakAta(splitSolSideViaAta(wallet.address, side, mint), (entry) => {
          (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = identity;
        });
        expect(() => evaluateSwap(broken, wallet)).toThrow(MalformedPayloadError);
      }

      // An unreadable container on that same ATA is indistinguishable from
      // the above: it may hold this wallet's WSOL leg.
      for (const container of [undefined, null, "not-an-array", 7]) {
        const broken = breakAta(splitSolSideViaAta(wallet.address, side, mint), (entry) => {
          entry.tokenBalanceChanges = container;
        });
        expect(() => evaluateSwap(broken, wallet)).toThrow(MalformedPayloadError);
      }

      const nonObjectChange = breakAta(splitSolSideViaAta(wallet.address, side, mint), (entry) => {
        (entry.tokenBalanceChanges as unknown[])[0] = "not-a-change";
      });
      expect(() => evaluateSwap(nonObjectChange, wallet)).toThrow(MalformedPayloadError);

      const nonObjectEntry = splitSolSideViaAta(wallet.address, side, mint);
      (nonObjectEntry.accountData as unknown as unknown[])[nonObjectEntry.accountData.length - 1] = "not-an-account";
      expect(() => evaluateSwap(nonObjectEntry, wallet)).toThrow(MalformedPayloadError);
    }
  });

  it("refuses a half-hidden token side rather than halving the token amount", () => {
    // The same defect on the token side: two changes of one token each, the
    // second on its own token-account entry and unattributable. Measured
    // against 171a6ea with exactly that shape:
    //   truth              tok=2 sol=1 price_sol=0.5
    //   half hidden        tok=1 sol=1 price_sol=1
    // (A hidden change on the wallet's OWN entry was already refused there
    // by the `account === address` rule — only the separate-entry shape
    // regressed, and that is the shape this asserts.)
    const truth = parseSwap(splitTokenSide(wallet.address, mint), wallet)!;
    expect(truth.tokenAmount).toBeCloseTo(2, 9);
    expect(truth.solAmount / truth.tokenAmount).toBeCloseTo(0.5, 9);

    const broken = breakAta(splitTokenSide(wallet.address, mint), (entry) => {
      (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = "";
    });
    expect(() => evaluateSwap(broken, wallet)).toThrow(MalformedPayloadError);
  });

  it("refuses a two-leg swap with one leg's identity unreadable, rather than trading the survivor", () => {
    // Arity is monotone under dropped data too: a genuine token<->token
    // swap with the second leg's identity unreadable is an ordinary,
    // self-consistent one-leg trade. Measured against 171a6ea, second leg on
    // its own entry:
    //   trade{token_amount 2, sol_amount 1, price_sol 0.5}, position dirty,
    //   parsed_at SET, parse_error NULL
    // — a written trade where the truth is `unsupported_quote`, i.e. a swap
    // this batch cannot price at all.
    const otherMint = inventAddress();
    expect(evaluateSwap(twoLegViaAta(wallet.address, mint, otherMint), wallet).outcome).toBe("unsupported_quote");

    const hidden = breakAta(twoLegViaAta(wallet.address, mint, otherMint), (entry) => {
      (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = "";
    });
    expect(() => evaluateSwap(hidden, wallet)).toThrow(MalformedPayloadError);
  });

  it("still fails closed when the unreadable identity is on the tracked wallet's own entry", () => {
    // The distinction that is the point: on an entry that demonstrably
    // belongs to this wallet (`account === address`), an unreadable change
    // or identity may be hiding this wallet's own leg. Reporting less than
    // the wallet actually did would be the silent drop this whole task
    // exists to prevent, so the row is recorded and requeued instead.
    for (const identity of ["", null, 42, undefined]) {
      expect(() => evaluateSwap(setOwnUserAccount(cleanBuy(), identity), wallet)).toThrow(MalformedPayloadError);
    }
    for (const container of [undefined, null, "not-an-array", 7]) {
      const payload = cleanBuy();
      (payload.accountData[0] as unknown as Record<string, unknown>).tokenBalanceChanges = container;
      expect(() => evaluateSwap(payload, wallet)).toThrow(MalformedPayloadError);
    }
    const junkChange = cleanBuy();
    (junkChange.accountData[0].tokenBalanceChanges as unknown as unknown[])[0] = "not-a-change";
    expect(() => evaluateSwap(junkChange, wallet)).toThrow(MalformedPayloadError);

    // `accountData` itself is the one structural check that stays fatal: a
    // payload with nothing readable there mentions no address at all, so
    // skipping it would settle the row as "touches no tracked wallet".
    expect(() => evaluateSwap(setField(cleanBuy(), "accountData", null), wallet)).toThrow(MalformedPayloadError);
  });

  it("refuses an unreadable account over lamports that actually moved", () => {
    // Review of 9b round 1: the lenient identity read was over-applied. The
    // native leg is keyed off `account`, while the token and WSOL legs are
    // keyed off `userAccount`, so skipping an entry whose `account` is
    // unreadable dropped HALF of a split SOL side and kept the other —
    // producing a wrong number rather than a refusal. Measured against
    // 5787ed9 on this exact shape:
    //   truth:               trade buy  tok=2 sol=1        price_sol=0.5
    //   account unreadable:  trade buy  tok=2 sol=0.499995 price_sol=0.2499975
    //   sell direction:      trade sell tok=2 sol=0.500005 price_sol=0.2500025
    // Right direction, plausible magnitude, parse_error NULL, parsed_at SET,
    // position dirty: a cost basis wrong by 2x, silently, on the number the
    // leaderboard ranks.
    for (const side of ["buy", "sell"] as const) {
      const truth = parseSwap(splitSolSide(wallet.address, side, mint), wallet)!;
      expect(truth.side).toBe(side);
      expect(truth.solAmount).toBeCloseTo(1, 9);
      expect(truth.solAmount / truth.tokenAmount).toBeCloseTo(0.5, 9);

      for (const identity of ["", null, 42, undefined]) {
        const broken = setOwnAccount(splitSolSide(wallet.address, side, mint), identity);
        expect(() => evaluateSwap(broken, wallet)).toThrow(MalformedPayloadError);
      }
    }

    // The same rule seen from the other side: an unreadable account whose
    // lamports did not move is still skipped, so the documented Helius
    // shape and ordinary pool entries cost nothing.
    const quiet = withPoolAccount(cleanBuy(), (entry) => {
      entry.account = "";
      entry.nativeBalanceChange = 0;
    });
    expect(parseSwap(quiet, wallet)!.solAmount).toBeCloseTo(1, 9);

    // A present-but-unreadable nativeBalanceChange cannot be shown to be
    // zero, so it raises rather than being assumed harmless.
    const unreadableNative = withPoolAccount(cleanBuy(), (entry) => {
      entry.account = null;
      entry.nativeBalanceChange = "1000000000";
    });
    expect(() => evaluateSwap(unreadableNative, wallet)).toThrow(MalformedPayloadError);
  });

  it("records rather than silently resolving when an unreadable account holds the whole SOL side", () => {
    // The `no_sol_leg` variant: the SOL side is entirely native, the wallet
    // is not the fee payer, and its own entry's `account` is unreadable.
    // Under the over-applied leniency this resolved to `no_sol_leg` — a
    // silent-by-design outcome — so a real 1-SOL buy vanished with
    // parse_error NULL. Now it is recorded and requeueable.
    const payload = setOwnAccount(
      buildSwapPayload({
        wallet: wallet.address,
        mint,
        decimals: 6,
        nativeChangeLamports: -1_000_000_000,
        tokenChangeRaw: "2000000",
        feeLamports: 5_000,
        isFeePayer: false,
      }),
      "",
    );
    expect(() => evaluateSwap(payload, wallet)).toThrow(MalformedPayloadError);
  });
});

async function makeKol(handle: string): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    "INSERT INTO kol (id, slug, display_name, x_handle, status) VALUES ($1,$2,$3,$4,'approved')",
    [id, handle, handle, handle],
  );
  return id;
}

describe("parsePending", () => {
  let kolId: string;
  let walletAddress: string;
  let walletId: string;
  let testMint: string;

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price CASCADE");
    kolId = await makeKol("parse-swap-kol");
    walletAddress = inventAddress();
    walletId = await addWallet(kolId, walletAddress);
    testMint = inventAddress();
  });

  it("parses a buy into a trade row, prices it in USD, and marks the position dirty", async () => {
    const minute = new Date("2026-08-25T12:00:00.000Z");
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, 150)", [minute]);

    const payload = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
      timestamp: Math.floor(minute.getTime() / 1000),
      slot: 555,
    });
    await storeRawTx({ signature: payload.signature, blockTime: minute, slot: 555, payload, source: "webhook" });

    const processed = await parsePending();
    expect(processed).toBe(1);

    const [trade] = await query<Record<string, unknown>>(
      "SELECT * FROM trade WHERE kol_id = $1", [kolId],
    );
    expect(trade.side).toBe("buy");
    expect(Number(trade.token_amount)).toBeCloseTo(2, 9);
    expect(Number(trade.sol_amount)).toBeCloseTo(1, 9);
    expect(Number(trade.fee_sol)).toBeCloseTo(0.000005, 9);
    expect(Number(trade.sol_usd)).toBe(150);
    expect(Number(trade.usd_amount)).toBeCloseTo(150, 9);
    expect(Number(trade.price_sol)).toBeCloseTo(0.5, 9);
    expect(Number(trade.price_usd)).toBeCloseTo(75, 9);
    expect(String(trade.slot)).toBe("555");
    expect(trade.instruction_index).toBe(0);

    const [pos] = await query<{ dirty: boolean }>(
      "SELECT dirty FROM position WHERE kol_id = $1 AND mint = $2", [kolId, testMint],
    );
    expect(pos.dirty).toBe(true);

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parsed_at).not.toBeNull();
    expect(raw.parse_error).toBeNull();
  });

  it("is idempotent on a reparse", async () => {
    const payload = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    await parsePending();
    const secondPass = await parsePending();
    expect(secondPass).toBe(0); // parsed_at is already set; nothing left to examine

    const trades = await query("SELECT id FROM trade");
    expect(trades).toHaveLength(1);
  });

  it("leaves sol_usd, usd_amount and price_usd null when no sol_price row exists at or before block_time", async () => {
    const payload = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    await storeRawTx({
      signature: payload.signature,
      blockTime: new Date("2020-01-01T00:00:00Z"),
      slot: 1,
      payload,
      source: "webhook",
    });

    await parsePending();

    const [trade] = await query<Record<string, unknown>>("SELECT * FROM trade WHERE kol_id = $1", [kolId]);
    expect(trade.sol_usd).toBeNull();
    expect(trade.usd_amount).toBeNull();
    expect(trade.price_usd).toBeNull();
    expect(Number(trade.sol_amount)).toBeCloseTo(1, 9); // the SOL side is still recorded
  });

  it("records an unsupported quote without inserting a trade", async () => {
    const otherMint = inventAddress();
    const payload = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -5_000,
      tokenChangeRaw: "-1000000",
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: otherMint, decimals: 6, rawTokenAmount: "2000000" }],
    });
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    const processed = await parsePending();
    expect(processed).toBe(1);

    const trades = await query("SELECT id FROM trade");
    expect(trades).toHaveLength(0);

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parsed_at).not.toBeNull(); // never retried again (task 9 scope note)
    expect(raw.parse_error).toBe("unsupported_quote");
  });

  it("does not fabricate a trade end to end for a lopsided-count token<->token swap", async () => {
    // parsePending-level regression for review round 2's fabrication case
    // (see the equivalent evaluateSwap-level test for the full worked
    // numbers): confirms the row is never left with parse_error NULL.
    const mintA = inventAddress();
    const mintB = inventAddress();
    const payload = buildSwapPayload({
      wallet: walletAddress,
      mint: mintA,
      decimals: 0,
      tokenChangeRaw: "1000000",
      nativeChangeLamports: -(5_000 + 2_039_280),
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: mintB, decimals: 6, rawTokenAmount: "-500000" }],
    });
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    await parsePending();

    expect(await query("SELECT id FROM trade")).toHaveLength(0);
    const [raw] = await query<{ parse_error: string | null }>("SELECT parse_error FROM raw_tx");
    expect(raw.parse_error).toBe("unsupported_quote");
    expect(raw.parse_error).not.toBeNull();
  });

  it("does not fabricate a trade end to end for a lopsided-count meme<->USDC swap", async () => {
    const memeMint = inventAddress();
    const payload = buildSwapPayload({
      wallet: walletAddress,
      mint: memeMint,
      decimals: 0,
      tokenChangeRaw: "10000000",
      nativeChangeLamports: -5_000,
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: USDC_MINT, decimals: 6, rawTokenAmount: "-50000000" }],
    });
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    await parsePending();

    expect(await query("SELECT id FROM trade")).toHaveLength(0);
    const [raw] = await query<{ parse_error: string | null }>("SELECT parse_error FROM raw_tx");
    expect(raw.parse_error).toBe("unsupported_quote");
    expect(raw.parse_error).not.toBeNull();
  });

  it("records a wrong-direction SOL leg without inserting a trade", async () => {
    const payload = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -9_005_000, // a tip larger than the sale proceeds
      tokenChangeRaw: "-2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    await parsePending();

    const trades = await query("SELECT id FROM trade");
    expect(trades).toHaveLength(0);

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parsed_at).not.toBeNull();
    expect(raw.parse_error).toBe("sol_leg_wrong_direction");
  });

  it("marks a row parsed with no error when it touches no registered wallet", async () => {
    const payload = buildSwapPayload({
      wallet: inventAddress(),
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    await parsePending();

    const trades = await query("SELECT id FROM trade");
    expect(trades).toHaveLength(0);

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parsed_at).not.toBeNull();
    expect(raw.parse_error).toBeNull();
  });

  it("stops indexing a withdrawn wallet without touching its earlier trade history", async () => {
    await query("UPDATE kol_wallet SET status = 'withdrawn' WHERE id = $1", [walletId]);

    const payload = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    await parsePending();

    const trades = await query("SELECT id FROM trade");
    expect(trades).toHaveLength(0);

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parsed_at).not.toBeNull();
    expect(raw.parse_error).toBeNull(); // withdrawal is not an error, just no longer tracked
  });

  it("gives each tracked wallet in a transaction its own outcome, not a row-wide silent drop", async () => {
    const kol2 = await makeKol("parse-swap-kol-2");
    const wallet2Address = inventAddress();
    await addWallet(kol2, wallet2Address);
    const otherMint = inventAddress();

    // Wallet A (walletAddress) does a clean SOL-quoted buy.
    const payload = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    // Wallet B does a token-to-token swap in the same transaction. The
    // fixture only models one wallet's legs directly, so wallet B's entry is
    // added onto the same payload the way a second tracked wallet touched by
    // the same transaction would appear in a real Helius payload.
    payload.accountData.push({
      account: wallet2Address,
      nativeBalanceChange: -5_000,
      tokenBalanceChanges: [
        { userAccount: wallet2Address, mint: testMint, rawTokenAmount: { tokenAmount: "-1000000", decimals: 6 } },
        { userAccount: wallet2Address, mint: otherMint, rawTokenAmount: { tokenAmount: "2000000", decimals: 6 } },
      ],
    });

    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });
    await parsePending();

    const trades = await query<{ kol_id: string }>("SELECT kol_id FROM trade");
    expect(trades).toHaveLength(1);
    expect(trades[0].kol_id).toBe(kolId); // wallet A's clean trade was written

    const [raw] = await query<{ parse_error: string | null }>("SELECT parse_error FROM raw_tx");
    expect(raw.parse_error).toBe("unsupported_quote"); // wallet B's drop is not silent
  });

  it("does not let a malformed row block a later good one from being parsed", async () => {
    // Inserted directly (bypassing storeRawTx, which can't produce invalid
    // ciphertext) with an explicit, earlier received_at so it is always
    // selected first regardless of timing.
    await query(
      `INSERT INTO raw_tx (signature_hmac, signature_enc, payload_enc, slot, block_time, received_at, source)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', 'webhook')`,
      [Buffer.from(inventSignature()), Buffer.from("not-real-ciphertext"), Buffer.from("also-not-real"), 1, new Date()],
    );

    const payload = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    await parsePending(1); // limit 1: only the malformed row, which sorts first
    expect(await query("SELECT id FROM trade")).toHaveLength(0);

    await parsePending(1); // the malformed row is now excluded (parse_error set); the good row runs
    expect(await query("SELECT id FROM trade")).toHaveLength(1);
  });

  it("records an unreadable raw token amount instead of throwing out of parsePending", async () => {
    // Review round 5. `BigInt("1.5")` threw a SyntaxError from inside the
    // per-wallet loop, past parsePending's only try/catch (which covers
    // decryption). Measured before the fix, with the bad row sorting first:
    // parsePending threw `SyntaxError: Cannot convert 1.5 to a BigInt`, zero
    // trades were written, and BOTH rows stayed `parsed_at NULL,
    // parse_error NULL` — so the pending query, which orders by received_at,
    // re-selected the same row and threw again on every later run. A
    // permanent head-of-line stall, with the good delivery behind it never
    // parsed and nothing recorded anywhere.
    const bad = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "1.5", // not a whole number of base units
      feeLamports: 5_000,
      isFeePayer: true,
    });
    await storeRawTx({ signature: bad.signature, blockTime: new Date(), slot: 1, payload: bad, source: "webhook" });
    // Force it to the head of the queue, so a stall would hide the good row.
    await query("UPDATE raw_tx SET received_at = now() - interval '1 minute'");

    const good = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    await storeRawTx({ signature: good.signature, blockTime: new Date(), slot: 2, payload: good, source: "webhook" });

    await expect(parsePending()).resolves.toBe(2); // does not throw
    expect(await query("SELECT id FROM trade")).toHaveLength(1); // the good row got through

    const rows = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx ORDER BY received_at",
    );
    expect(rows[0].parse_error).toBe("malformed_payload");
    expect(rows[0].parsed_at).toBeNull(); // requeue by clearing parse_error, as before
    expect(rows[1].parse_error).toBeNull();

    // The head of the line is unblocked: the poison row is filtered out by
    // `parse_error IS NULL`, so a second run neither throws nor re-selects it.
    await expect(parsePending()).resolves.toBe(0);
    expect(await query("SELECT id FROM trade")).toHaveLength(1);
  });

  it("records a missing rawTokenAmount rather than throwing a TypeError", async () => {
    // The same stall through a different door: before the fix this threw
    // `TypeError: Cannot read properties of undefined (reading 'decimals')`
    // and left the row `parsed_at NULL, parse_error NULL`.
    const bad = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });
    delete (bad.accountData[0].tokenBalanceChanges[0] as Partial<TokenBalanceChange>).rawTokenAmount;
    await storeRawTx({ signature: bad.signature, blockTime: new Date(), slot: 1, payload: bad, source: "webhook" });

    await expect(parsePending()).resolves.toBe(1);
    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parse_error).toBe("malformed_payload");
    expect(raw.parsed_at).toBeNull();
    expect(await query("SELECT id FROM trade")).toHaveLength(0);
  });

  it("leaves a malformed row retryable: parse_error is set but parsed_at stays null", async () => {
    const signatureHmac = Buffer.from(inventSignature());
    await query(
      `INSERT INTO raw_tx (signature_hmac, signature_enc, payload_enc, slot, block_time, source)
       VALUES ($1, $2, $3, $4, $5, 'webhook')`,
      [signatureHmac, Buffer.from("not-real-ciphertext"), Buffer.from("also-not-real"), 1, new Date()],
    );

    const processed = await parsePending();
    expect(processed).toBe(1);

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parsed_at).toBeNull(); // still eligible for a fix to reprocess, once parse_error clears
    expect(raw.parse_error).toBe("malformed_payload");
  });

  // ---- Task 9b: the four consequences, end to end ----

  const goodBuy = () =>
    buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });

  it("records a missing timestamp instead of stalling the queue on it forever", async () => {
    // Consequence 1, measured against 7788380 with this exact row:
    //   RUN 1 threw: error: invalid input syntax for type timestamp with time
    //                zone: "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN"
    //   RUN 1 trades: 0   rows: [{parsed_at: null, parse_error: null}]
    //   RUN 2 threw: the same error, on the same re-selected row.
    // `insertTrade` read `payload.timestamp` directly, past every guard in
    // the file, so the throw came from Postgres. Worse than the stall round
    // 5 fixed: it only fires on rows that reach `insertTrade` — real trades
    // for tracked wallets.
    const bad = dropField(goodBuy(), "timestamp");
    await storeRawTx({ signature: bad.signature, blockTime: new Date(), slot: 1, payload: bad, source: "webhook" });
    // Force it to the head of the queue, so a stall would hide the good row.
    await query("UPDATE raw_tx SET received_at = now() - interval '1 minute'");

    const good = goodBuy();
    await storeRawTx({ signature: good.signature, blockTime: new Date(), slot: 2, payload: good, source: "webhook" });

    await expect(parsePending()).resolves.toBe(2); // does not throw
    expect(await query("SELECT id FROM trade")).toHaveLength(1); // the good row got through

    const rows = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx ORDER BY received_at",
    );
    expect(rows[0].parse_error).toBe("malformed_payload");
    expect(rows[0].parsed_at).toBeNull(); // requeue by clearing parse_error
    expect(rows[1].parse_error).toBeNull();

    // The head of the line is unblocked: a second run neither throws nor
    // re-selects the poison row.
    await expect(parsePending()).resolves.toBe(0);
    expect(await query("SELECT id FROM trade")).toHaveLength(1);
  });

  it("records a non-string signature and a non-numeric slot rather than throwing on them", async () => {
    // The same stall through two more doors, both measured against 7788380:
    //   signature 12345 -> TypeError: The "data" argument must be of type
    //     string or an instance of Buffer, TypedArray, or DataView.
    //     Received type number (12345)   [from encrypt(), inside insertTrade]
    //   slot "abc" -> error: invalid input syntax for type bigint: "abc"
    // Both left the row `parsed_at NULL, parse_error NULL` and threw again
    // on every later run. `route.ts` only checks `!event?.signature`, so a
    // numeric signature is truthy there and reaches the parser.
    const badSignature = goodBuy();
    const realSignature = badSignature.signature; // the raw_tx row's own signature stays valid
    setField(badSignature, "signature", 12345);
    await storeRawTx({
      signature: realSignature,
      blockTime: new Date(),
      slot: 1,
      payload: badSignature,
      source: "webhook",
    });

    const badSlot = setField(goodBuy(), "slot", "abc");
    await storeRawTx({ signature: badSlot.signature, blockTime: new Date(), slot: 2, payload: badSlot, source: "webhook" });

    await expect(parsePending()).resolves.toBe(2);
    expect(await query("SELECT id FROM trade")).toHaveLength(0);

    const rows = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(rows.map((r) => r.parse_error)).toEqual(["malformed_payload", "malformed_payload"]);
    expect(rows.every((r) => r.parsed_at === null)).toBe(true);
    await expect(parsePending()).resolves.toBe(0); // neither row stalls the queue
  });

  it("does not write a 1970 trade from a null timestamp", async () => {
    // Consequence 2, measured against 7788380: `timestamp: null` coerced to
    // 0 and wrote a trade with
    //   block_time 1970-01-01T00:00:00.000Z, sol_usd null
    // — a real trade dated 1970, priced off a 1970 SOL/USD lookup, with
    // nothing recorded anywhere. Silent, not even a stall.
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, 150)", [new Date("1970-01-01T00:00:00.000Z")]);

    const bad = setField(goodBuy(), "timestamp", null);
    await storeRawTx({ signature: bad.signature, blockTime: new Date(), slot: 1, payload: bad, source: "webhook" });

    await expect(parsePending()).resolves.toBe(1);
    expect(await query("SELECT id FROM trade")).toHaveLength(0);

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parse_error).toBe("malformed_payload");
    expect(raw.parsed_at).toBeNull();
  });

  it("does not write a cost basis a million times wrong from an unreadable decimals", async () => {
    // Consequence 3, measured against 7788380 with this exact row
    // (`decimals: -3` on a 2,000,000-raw leg bought for 1 SOL):
    //   trade: token_amount 2000000, sol_amount 1, price_sol 0.0000005
    // The correct reading is token_amount 2, price_sol 0.5 — the written
    // basis was wrong by a factor of a million, on the number the
    // leaderboard ranks, and `position` was marked dirty off it.
    // `normalizeDecimals` mapped it to 0 while every neighbouring field
    // raised.
    const bad = setDecimals(goodBuy(), -3);
    await storeRawTx({ signature: bad.signature, blockTime: new Date(), slot: 1, payload: bad, source: "webhook" });

    await expect(parsePending()).resolves.toBe(1);
    expect(await query("SELECT id FROM trade")).toHaveLength(0);
    expect(await query("SELECT kol_id FROM position")).toHaveLength(0);

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parse_error).toBe("malformed_payload");
    expect(raw.parsed_at).toBeNull();
  });

  it("keeps a tracked wallet's trade when an untracked account's leg is unreadable", async () => {
    // Consequence 4, measured against 7788380: validation walked the ENTIRE
    // payload before any wallet was evaluated, so an unreadable leg on an
    // untracked liquidity pool made the row `malformed_payload` and wrote
    //   trades: 0
    // even though the tracked wallet's own leg reads perfectly. It failed
    // closed and stayed requeueable, but a permanently unreadable
    // third-party field permanently cost a good wallet its trade.
    const payload = withUnreadablePoolLeg(goodBuy());
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    await expect(parsePending()).resolves.toBe(1);

    const [trade] = await query<Record<string, unknown>>("SELECT * FROM trade");
    expect(Number(trade.token_amount)).toBeCloseTo(2, 9);
    expect(Number(trade.sol_amount)).toBeCloseTo(1, 9);
    expect(Number(trade.price_sol)).toBeCloseTo(0.5, 9);

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parsed_at).not.toBeNull();
    expect(raw.parse_error).toBeNull(); // nothing tracked was lost, so nothing to record
  });

  it("never writes Infinity or NaN from an unbounded raw token amount", async () => {
    // Review of 9b. Measured against 4d401fb with a 321-digit tokenAmount on
    // the token leg and on a WSOL leg:
    //   trade{token_amount: Infinity, sol_amount: Infinity, price_sol: NaN},
    //   position dirty, parsed_at SET, parse_error NULL
    // Silent AND unrequeueable — the row was settled with nothing recorded,
    // the only defect in this task with no way back. The token leg alone
    // gave price_sol 0.
    const huge = "9".repeat(321);
    const bothLegs = buildSwapPayload({
      wallet: walletAddress,
      mint: testMint,
      decimals: 6,
      nativeChangeLamports: -5_000,
      tokenChangeRaw: huge,
      feeLamports: 5_000,
      isFeePayer: true,
      extraTokenChanges: [{ mint: WSOL_MINT, decimals: 9, rawTokenAmount: `-${huge}` }],
    });
    await storeRawTx({
      signature: bothLegs.signature,
      blockTime: new Date(),
      slot: 1,
      payload: bothLegs,
      source: "webhook",
    });

    const tokenLegOnly = setOwnRawAmount(goodBuy(), huge);
    await storeRawTx({
      signature: tokenLegOnly.signature,
      blockTime: new Date(),
      slot: 2,
      payload: tokenLegOnly,
      source: "webhook",
    });

    await expect(parsePending()).resolves.toBe(2);

    // Nothing written at all — and in particular no Infinity, no NaN.
    expect(await query("SELECT id FROM trade")).toHaveLength(0);
    expect(await query("SELECT kol_id FROM position")).toHaveLength(0);

    const rows = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(rows.map((r) => r.parse_error)).toEqual(["malformed_payload", "malformed_payload"]);
    // Requeueable, unlike the state this replaces.
    expect(rows.every((r) => r.parsed_at === null)).toBe(true);
  });

  it("keeps a tracked wallet's trade when an untracked account's identity is unreadable", async () => {
    // Helius emits `userAccount: ""` for token accounts it cannot attribute.
    // Failing the row on one would make every delivery containing one
    // `malformed_payload` — the feed goes quiet with nothing reporting it.
    const payload = withPoolAccount(goodBuy(), (entry) => {
      const change = (entry.tokenBalanceChanges as Record<string, unknown>[])[0];
      change.userAccount = "";
      (change.rawTokenAmount as Record<string, unknown>).tokenAmount = "0"; // moved nothing
      entry.account = null;
      entry.nativeBalanceChange = 0; // nothing moved through it, so nothing to attribute
    });
    const second = withPoolAccount(goodBuy(), (entry) => {
      (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = null;
      (((entry.tokenBalanceChanges as Record<string, unknown>[])[0]
        .rawTokenAmount as Record<string, unknown>).tokenAmount = 0);
      entry.account = 42;
      delete entry.nativeBalanceChange;
    });
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });
    await storeRawTx({ signature: second.signature, blockTime: new Date(), slot: 2, payload: second, source: "webhook" });

    await expect(parsePending()).resolves.toBe(2);

    const trades = await query<Record<string, unknown>>("SELECT sol_amount FROM trade");
    expect(trades).toHaveLength(2); // both tracked-wallet trades survive
    expect(trades.every((t) => Number(t.sol_amount) === 1)).toBe(true);

    const rows = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(rows.every((r) => r.parse_error === null)).toBe(true);
    expect(rows.every((r) => r.parsed_at !== null)).toBe(true);
  });

  it("records an unreadable identity on the tracked wallet's own entry rather than skipping it", async () => {
    const bad = setOwnUserAccount(goodBuy(), "");
    await storeRawTx({ signature: bad.signature, blockTime: new Date(), slot: 1, payload: bad, source: "webhook" });

    await expect(parsePending()).resolves.toBe(1);
    expect(await query("SELECT id FROM trade")).toHaveLength(0);

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parse_error).toBe("malformed_payload");
    expect(raw.parsed_at).toBeNull();
  });

  it("records a split SOL side whose ATA identity is unreadable, instead of halving it", async () => {
    // Review of 9b round 2, end to end. Measured against 171a6ea, both
    // directions:
    //   truth                        token_amount 2, sol_amount 1,   price_sol 0.5
    //   userAccount unreadable (ATA) token_amount 2, sol_amount 0.5, price_sol 0.25
    //   parse_error NULL, parsed_at SET, position dirty
    for (const side of ["buy", "sell"] as const) {
      const payload = breakAta(splitSolSideViaAta(walletAddress, side, testMint), (entry) => {
        (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = "";
      });
      await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });
    }

    await expect(parsePending()).resolves.toBe(2);

    expect(await query("SELECT id FROM trade")).toHaveLength(0);
    expect(await query("SELECT kol_id FROM position")).toHaveLength(0);

    const rows = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(rows.map((r) => r.parse_error)).toEqual(["malformed_payload", "malformed_payload"]);
    expect(rows.every((r) => r.parsed_at === null)).toBe(true);

    // The readable ATA shape is still an ordinary 1-SOL trade.
    await query("TRUNCATE raw_tx, trade, position CASCADE");
    const good = splitSolSideViaAta(walletAddress, "buy", testMint);
    await storeRawTx({ signature: good.signature, blockTime: new Date(), slot: 1, payload: good, source: "webhook" });
    await expect(parsePending()).resolves.toBe(1);
    const [trade] = await query<Record<string, unknown>>("SELECT sol_amount, price_sol FROM trade");
    expect(Number(trade.sol_amount)).toBeCloseTo(1, 9);
    expect(Number(trade.price_sol)).toBeCloseTo(0.5, 9);
  });

  it("records a half-hidden token side end to end, instead of halving the token amount", async () => {
    // Measured against 171a6ea: token_amount 1, price_sol 1 against a truth
    // of token_amount 2, price_sol 0.5.
    const payload = breakAta(splitTokenSide(walletAddress, testMint), (entry) => {
      (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = "";
    });
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    await expect(parsePending()).resolves.toBe(1);
    expect(await query("SELECT id FROM trade")).toHaveLength(0);
    expect(await query("SELECT kol_id FROM position")).toHaveLength(0);

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parse_error).toBe("malformed_payload");
    expect(raw.parsed_at).toBeNull();
  });

  it("records a split SOL side whose account is unreadable, instead of pricing it 2x wrong", async () => {
    // Review of 9b round 1, end to end. Measured against 5787ed9:
    //   buy  -> trade{token_amount 2, sol_amount 0.499995, price_sol 0.2499975}
    //   sell -> trade{token_amount 2, sol_amount 0.500005, price_sol 0.2500025}
    // both with parse_error NULL, parsed_at SET and position dirty, against
    // a truth of sol_amount 1 / price_sol 0.5.
    for (const side of ["buy", "sell"] as const) {
      const payload = setOwnAccount(splitSolSide(walletAddress, side, testMint), "");
      await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });
    }

    await expect(parsePending()).resolves.toBe(2);

    expect(await query("SELECT id FROM trade")).toHaveLength(0);
    expect(await query("SELECT kol_id FROM position")).toHaveLength(0);

    const rows = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(rows.map((r) => r.parse_error)).toEqual(["malformed_payload", "malformed_payload"]);
    expect(rows.every((r) => r.parsed_at === null)).toBe(true); // requeueable, as it was before the leniency

    // And the readable version of the same shape is still a clean 1-SOL trade.
    await query("TRUNCATE raw_tx, trade, position CASCADE");
    const good = splitSolSide(walletAddress, "buy", testMint);
    await storeRawTx({ signature: good.signature, blockTime: new Date(), slot: 1, payload: good, source: "webhook" });
    await expect(parsePending()).resolves.toBe(1);
    const [trade] = await query<Record<string, unknown>>("SELECT sol_amount, price_sol FROM trade");
    expect(Number(trade.sol_amount)).toBeCloseTo(1, 9);
    expect(Number(trade.price_sol)).toBeCloseTo(0.5, 9);
  });

  it("still writes one wallet's trade when another tracked wallet's own leg is unreadable", async () => {
    // The narrowing does not extend to a tracked wallet: if wallet B's own
    // leg cannot be read, that IS recorded on the row (and the row stays
    // requeueable), but wallet A's clean trade is not thrown away with it.
    const kol2 = await makeKol("parse-swap-kol-3");
    const wallet2Address = inventAddress();
    await addWallet(kol2, wallet2Address);

    const payload = goodBuy();
    payload.accountData.push({
      account: wallet2Address,
      nativeBalanceChange: -1_000_005_000,
      tokenBalanceChanges: [
        { userAccount: wallet2Address, mint: testMint, rawTokenAmount: { tokenAmount: "1.5", decimals: 6 } },
      ],
    });
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    await expect(parsePending()).resolves.toBe(1);

    const trades = await query<{ kol_id: string }>("SELECT kol_id FROM trade");
    expect(trades).toHaveLength(1);
    expect(trades[0].kol_id).toBe(kolId); // wallet A's trade survives wallet B's unreadable leg

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(raw.parse_error).toBe("malformed_payload"); // wallet B's loss is not silent
    expect(raw.parsed_at).toBeNull(); // and a parser fix can requeue it: the insert is ON CONFLICT DO NOTHING
  });

  it("lets a database failure propagate instead of recording it as a malformed payload", async () => {
    // The catch must not widen. `parsePending` catches MalformedPayloadError
    // specifically; anything else — a transient Neon outage, a constraint
    // violation — must reach the caller, or an innocent row is permanently
    // stamped `malformed_payload` and the real failure disappears.
    const payload = goodBuy();
    await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

    // A trade insert against this row cannot succeed: `side` only accepts
    // 'buy' and 'sell', so the INSERT raises inside insertTrade, in the same
    // per-wallet loop that catches unreadable payloads.
    await query("ALTER TABLE trade ADD CONSTRAINT trade_9b_probe CHECK (side = 'neither')");
    try {
      await expect(parsePending()).rejects.toThrow(/trade_9b_probe/);
    } finally {
      await query("ALTER TABLE trade DROP CONSTRAINT trade_9b_probe");
    }

    const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    // Untouched: not marked parsed, and NOT stamped malformed_payload.
    expect(raw.parsed_at).toBeNull();
    expect(raw.parse_error).toBeNull();
  });
});

/**
 * Every review round on this task so far introduced a different bug with
 * the exact same signature: a tracked wallet's swap ending as neither a
 * written trade nor a recorded `parse_error` — invisible in the feed and
 * invisible in the error log. Rather than keep adding one more specific
 * regression test per incident, this asserts the property directly, driven
 * over every payload shape the rounds have touched.
 *
 * Round 3 carved two shapes out of this table — a SOL<->USDC rotation and a
 * payload with no SOL/WSOL leg — because both legitimately end as neither a
 * trade nor an error. The rotation carve-out was right; the other was not.
 * "No SOL leg" is reached *after* dust filtering, so a real trade can land
 * there, and two shapes did: a sole 1-raw-unit leg of a 6- or 9-decimal
 * mint. Worse, the carve-out excluded an *outcome* (`no_trade`) rather than
 * a shape, so anything a future change routed into that outcome was excluded
 * with it, silently.
 *
 * So the table now covers every shape, including those two, and each row
 * asserts the **specific named outcome** it must reach. `no_trade` no longer
 * exists as a type member, and the standing check below is that no shape
 * lands outside the small, individually justified set of outcomes that are
 * silent by design.
 */
describe("invariant: a tracked wallet's swap is never silently dropped", () => {
  let kolId: string;
  let walletAddress: string;

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price CASCADE");
    kolId = await makeKol("invariant-kol");
    walletAddress = inventAddress();
    await addWallet(kolId, walletAddress);
  });

  /**
   * The outcomes that are neither a trade nor a recorded error, each one
   * named and justified. A shape reaching anything outside this set must
   * leave a trade or a non-null `parse_error` behind.
   */
  const SILENT_BY_DESIGN: ReadonlySet<SwapOutcome> = new Set<SwapOutcome>([
    // Spec §4.3: SOL <-> stablecoin rotation is not a trade and is not indexed.
    "stable_rotation",
    // Spec §4.3 again: no SOL/WSOL movement to trade against — a transfer or
    // an airdrop, not a swap.
    "no_sol_leg",
    // Nothing above the mint's own precision floor moved.
    "dust_only",
    // The transaction does not touch this wallet's SPL balances at all.
    "no_token_leg",
  ]);

  type Shape = {
    name: string;
    // The exact outcome this shape must reach. Asserting the specific name
    // is what makes the table catch a real trade being re-routed into a
    // silent outcome — the property the round-3 `no_trade` carve-out lost.
    //
    // `"malformed_payload"` is not a SwapOutcome: it is the state a payload
    // the parser cannot read must leave on the row. It belongs in this
    // table because an unreadable payload used to throw out of
    // `parsePending`, which left the row with neither a trade nor an error
    // — the same silent-drop signature, reached by escaping the function
    // rather than by returning from it.
    outcome: SwapOutcome | "malformed_payload";
    build: () => ReturnType<typeof buildSwapPayload>;
  };

  /** A clean, readable SOL-quoted buy for the tracked wallet: the base every
   *  "one field is unreadable" shape below breaks exactly one field of. */
  const invariantBuy = () =>
    buildSwapPayload({
      wallet: walletAddress,
      mint: inventAddress(),
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });

  const shapes: Shape[] = [
    {
      name: "clean SOL buy",
      outcome: "trade",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: -1_000_005_000,
          tokenChangeRaw: "2000000",
          feeLamports: 5_000,
          isFeePayer: true,
        }),
    },
    {
      name: "clean sell",
      outcome: "trade",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: 1_999_995_000,
          tokenChangeRaw: "-2000000",
          feeLamports: 5_000,
          isFeePayer: true,
        }),
    },
    {
      name: "wrong-direction SOL leg (a tip exceeding sale proceeds)",
      outcome: "sol_leg_wrong_direction",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: -9_005_000,
          tokenChangeRaw: "-2000000",
          feeLamports: 5_000,
          isFeePayer: true,
        }),
    },
    {
      name: "token<->token swap (two comparable real legs)",
      outcome: "unsupported_quote",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: -5_000,
          tokenChangeRaw: "-1000000",
          feeLamports: 5_000,
          isFeePayer: true,
          extraTokenChanges: [{ mint: inventAddress(), decimals: 6, rawTokenAmount: "2000000" }],
        }),
    },
    {
      name: "sole 1-raw-unit leg (the whole trade, not a router remainder)",
      outcome: "trade",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 0,
          nativeChangeLamports: -1_000_005_000,
          tokenChangeRaw: "1",
          feeLamports: 5_000,
          isFeePayer: true,
        }),
    },
    {
      name: "a 1-raw-unit dust remainder alongside a real leg",
      outcome: "trade",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: -1_000_005_000,
          tokenChangeRaw: "2000000",
          feeLamports: 5_000,
          isFeePayer: true,
          extraTokenChanges: [{ mint: inventAddress(), decimals: 6, rawTokenAmount: "1" }],
        }),
    },
    {
      name: "two real legs of lopsided count (no dust involved)",
      outcome: "unsupported_quote",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 0,
          nativeChangeLamports: -(5_000 + 2_039_280),
          tokenChangeRaw: "1000000",
          feeLamports: 5_000,
          isFeePayer: true,
          extraTokenChanges: [{ mint: inventAddress(), decimals: 6, rawTokenAmount: "-500000" }],
        }),
    },
    {
      name: "non-fee-payer sell",
      outcome: "trade",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: 2_000_000_000,
          tokenChangeRaw: "-2000000",
          feeLamports: 5_000,
          isFeePayer: false,
        }),
    },
    {
      name: "persistent-WSOL buy",
      outcome: "trade",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: -5_000,
          tokenChangeRaw: "2000000",
          feeLamports: 5_000,
          isFeePayer: true,
          extraTokenChanges: [{ mint: WSOL_MINT, decimals: 9, rawTokenAmount: "-1000000000" }],
        }),
    },
    {
      // Round 3 excluded this shape from the table. It belongs here: spec
      // §4.3 says a SOL <-> stablecoin rotation is not a trade and is not
      // indexed, so the right assertion is its name, not its absence.
      name: "SOL<->USDC rotation (spec §4.3 exclusion)",
      outcome: "stable_rotation",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: USDC_MINT,
          decimals: 6,
          nativeChangeLamports: -1_000_005_000,
          tokenChangeRaw: "2000000",
          feeLamports: 5_000,
          isFeePayer: true,
        }),
    },
    {
      // Round 3 excluded this one too, and that was the mistake: the branch
      // is reached after dust filtering, so a real trade can land in it.
      name: "no SOL/WSOL leg at all (a transfer, not a swap)",
      outcome: "no_sol_leg",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: 0,
          tokenChangeRaw: "2000000",
          feeLamports: 0,
          isFeePayer: false,
        }),
    },
    {
      // The two shapes that were landing in the excluded region as
      // fabricated trades before the dust floor became decimals-aware.
      name: "sole 1-raw-unit leg of a 6-decimal mint (dust, not a trade)",
      outcome: "dust_only",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: -(2_039_280 + 5_000),
          tokenChangeRaw: "1",
          feeLamports: 5_000,
          isFeePayer: true,
        }),
    },
    {
      name: "sole 1-raw-unit leg of a 9-decimal mint (dust, not a trade)",
      outcome: "dust_only",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 9,
          nativeChangeLamports: -5_000_000,
          tokenChangeRaw: "1",
          feeLamports: 5_000,
          isFeePayer: true,
        }),
    },
    {
      name: "an unreadable raw token amount (recorded, never thrown)",
      outcome: "malformed_payload",
      build: () =>
        buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: -1_000_005_000,
          tokenChangeRaw: "1.5",
          feeLamports: 5_000,
          isFeePayer: true,
        }),
    },
    {
      name: "a missing rawTokenAmount (recorded, never thrown)",
      outcome: "malformed_payload",
      build: () => {
        const payload = buildSwapPayload({
          wallet: walletAddress,
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: -1_000_005_000,
          tokenChangeRaw: "2000000",
          feeLamports: 5_000,
          isFeePayer: true,
        });
        delete (payload.accountData[0].tokenBalanceChanges[0] as Partial<TokenBalanceChange>).rawTokenAmount;
        return payload;
      },
    },
    {
      name: "a transaction that does not touch this wallet",
      outcome: "no_token_leg",
      build: () =>
        buildSwapPayload({
          wallet: inventAddress(),
          mint: inventAddress(),
          decimals: 6,
          nativeChangeLamports: -1_000_005_000,
          tokenChangeRaw: "2000000",
          feeLamports: 5_000,
          isFeePayer: true,
        }),
    },
    // Task 9b: the five fields that were still outside the require*
    // discipline. Each one is a shape here, not just a regression test, so
    // the standing invariant covers it — three of them used to throw out of
    // `parsePending` from inside Postgres or `encrypt()`, and two used to
    // write a wrong number in silence.
    {
      name: "a missing timestamp (was: a permanent stall inside insertTrade)",
      outcome: "malformed_payload",
      build: () => dropField(invariantBuy(), "timestamp"),
    },
    {
      name: "a null timestamp (was: a silent 1970 trade)",
      outcome: "malformed_payload",
      build: () => setField(invariantBuy(), "timestamp", null),
    },
    {
      name: "a non-string signature (was: a TypeError out of encrypt)",
      outcome: "malformed_payload",
      build: () => setField(invariantBuy(), "signature", 12345),
    },
    {
      name: "a non-numeric slot (was: a bigint syntax error from Postgres)",
      outcome: "malformed_payload",
      build: () => setField(invariantBuy(), "slot", "abc"),
    },
    {
      name: "a missing fee (was: silently zero, dropping it from the §4.4 arithmetic)",
      outcome: "malformed_payload",
      build: () => dropField(invariantBuy(), "fee"),
    },
    {
      name: "an unreadable decimals (was: silently zero, a basis a million times wrong)",
      outcome: "malformed_payload",
      build: () => setDecimals(invariantBuy(), -3),
    },
    {
      // The narrowing, as a shape: the tracked wallet's leg is clean and
      // must still become a trade, whatever an untracked pool's leg says.
      name: "an unreadable leg on an untracked account (must not cost this wallet its trade)",
      outcome: "trade",
      build: () => withUnreadablePoolLeg(invariantBuy()),
    },
    // Review of 9b: identity. An identity that cannot be read is not one of
    // ours, so the entry is skipped — Helius emits `userAccount: ""` for
    // token accounts it cannot attribute, and failing the row on one would
    // take the feed quiet with nothing reporting it. The same shapes on the
    // tracked wallet's own entry stay fatal, because there they could be
    // hiding that wallet's own leg.
    {
      // Still lenient, because the dropped change provably moved nothing.
      name: 'an unattributable userAccount ("") on a zero-valued change',
      outcome: "trade",
      build: () =>
        withPoolAccount(invariantBuy(), (entry) => {
          const change = (entry.tokenBalanceChanges as Record<string, unknown>[])[0];
          change.userAccount = "";
          (change.rawTokenAmount as Record<string, unknown>).tokenAmount = "0";
        }),
    },
    {
      // Review of 9b round 2: an unattributable NON-zero change is refused
      // once this wallet has a leg of its own — it may be half of this
      // wallet's SOL or token side, and every check below it survives the
      // loss (see the file header on monotonicity).
      name: 'an unattributable userAccount ("") on a non-zero change',
      outcome: "malformed_payload",
      build: () =>
        withPoolAccount(invariantBuy(), (entry) => {
          (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = "";
        }),
    },
    {
      name: "a missing tokenBalanceChanges on an untracked entry (may hide a leg)",
      outcome: "malformed_payload",
      build: () =>
        withPoolAccount(invariantBuy(), (entry) => {
          delete entry.tokenBalanceChanges;
        }),
    },
    {
      name: "an unreadable userAccount on the ATA holding this wallet's WSOL leg, buy (was: price_sol 0.25)",
      outcome: "malformed_payload",
      build: () =>
        breakAta(splitSolSideViaAta(walletAddress, "buy", inventAddress()), (entry) => {
          (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = "";
        }),
    },
    {
      name: "an unreadable userAccount on the ATA holding this wallet's WSOL leg, sell (was: price_sol 0.25)",
      outcome: "malformed_payload",
      build: () =>
        breakAta(splitSolSideViaAta(walletAddress, "sell", inventAddress()), (entry) => {
          (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = null;
        }),
    },
    {
      name: "a non-array tokenBalanceChanges on the ATA holding this wallet's WSOL leg",
      outcome: "malformed_payload",
      build: () =>
        breakAta(splitSolSideViaAta(walletAddress, "buy", inventAddress()), (entry) => {
          entry.tokenBalanceChanges = "not-an-array";
        }),
    },
    {
      name: "a non-object change on the ATA holding this wallet's WSOL leg",
      outcome: "malformed_payload",
      build: () =>
        breakAta(splitSolSideViaAta(walletAddress, "buy", inventAddress()), (entry) => {
          (entry.tokenBalanceChanges as unknown[])[0] = "not-a-change";
        }),
    },
    {
      name: "a non-object accountData entry where this wallet's WSOL leg belongs",
      outcome: "malformed_payload",
      build: () => {
        const payload = splitSolSideViaAta(walletAddress, "buy", inventAddress());
        (payload.accountData as unknown as unknown[])[payload.accountData.length - 1] = "not-an-account";
        return payload;
      },
    },
    {
      name: "a two-leg swap with one leg's identity unreadable (was: a one-leg trade, tok=2 sol=1)",
      outcome: "malformed_payload",
      build: () =>
        breakAta(twoLegViaAta(walletAddress, inventAddress(), inventAddress()), (entry) => {
          (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = "";
        }),
    },
    {
      name: "a half-hidden token side (was: token_amount 1, price_sol 1)",
      outcome: "malformed_payload",
      build: () =>
        breakAta(splitTokenSide(walletAddress, inventAddress()), (entry) => {
          (entry.tokenBalanceChanges as Record<string, unknown>[])[0].userAccount = "";
        }),
    },
    {
      name: "a numeric account on an untracked pool, with no lamport movement",
      outcome: "trade",
      build: () =>
        withPoolAccount(invariantBuy(), (entry) => {
          entry.account = 42;
          entry.nativeBalanceChange = 0;
        }),
    },
    {
      name: "an unreadable userAccount on the tracked wallet's own entry",
      outcome: "malformed_payload",
      build: () => setOwnUserAccount(invariantBuy(), ""),
    },
    {
      name: "a missing tokenBalanceChanges on the tracked wallet's own entry",
      outcome: "malformed_payload",
      build: () => {
        const payload = invariantBuy();
        delete (payload.accountData[0] as unknown as Record<string, unknown>).tokenBalanceChanges;
        return payload;
      },
    },
    {
      // Review of 9b round 1: the lenient `account` read dropped the native
      // half of a split SOL side and kept the WSOL half, writing a cost
      // basis 2x wrong in silence. Both directions are shapes here.
      name: "an unreadable account over a split SOL side, buy (was: price_sol 0.2499975)",
      outcome: "malformed_payload",
      build: () => setOwnAccount(splitSolSide(walletAddress, "buy", inventAddress()), ""),
    },
    {
      name: "an unreadable account over a split SOL side, sell (was: price_sol 0.2500025)",
      outcome: "malformed_payload",
      build: () => setOwnAccount(splitSolSide(walletAddress, "sell", inventAddress()), null),
    },
    {
      name: "an unreadable account holding the whole native SOL side (was: a silent no_sol_leg)",
      outcome: "malformed_payload",
      build: () =>
        setOwnAccount(
          buildSwapPayload({
            wallet: walletAddress,
            mint: inventAddress(),
            decimals: 6,
            nativeChangeLamports: -1_000_000_000,
            tokenChangeRaw: "2000000",
            feeLamports: 5_000,
            isFeePayer: false,
          }),
          "",
        ),
    },
    {
      name: "an unreadable account with no lamport movement on an untracked pool",
      outcome: "trade",
      build: () =>
        withPoolAccount(invariantBuy(), (entry) => {
          entry.account = "";
          delete entry.nativeBalanceChange;
        }),
    },
    {
      name: "a 321-digit raw token amount (was: Infinity/NaN, settled and unrequeueable)",
      outcome: "malformed_payload",
      build: () => setOwnRawAmount(invariantBuy(), "9".repeat(321)),
    },
    {
      name: "a raw token amount that is a JSON number too large to be exact",
      outcome: "malformed_payload",
      build: () => setOwnRawAmount(invariantBuy(), 12345678901234567890),
    },
  ];

  it.each(shapes)(
    "$name: reaches its named outcome, and never a silent drop outside the justified set",
    async ({ build, outcome }) => {
      const payload = build();
      // The `raw_tx` row's own signature is a separate value from the
      // payload's `signature` field — `storeRawTx` takes it from the
      // delivery envelope — so a payload whose inner field is unreadable is
      // still stored under a real one, which is exactly how such a row
      // arrives. Only this one shape needs the fallback.
      const signature = typeof payload.signature === "string" && payload.signature.length > 0
        ? payload.signature
        : inventSignature();
      await storeRawTx({ signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

      const wallet = { id: "w", kolId: kolId, address: walletAddress };

      // The specific named outcome. This is what makes the table catch a
      // real trade being re-routed into a not-a-trade branch: the previous
      // version excluded a catch-all outcome, so anything that drifted into
      // it drifted out of the test's reach at the same time.
      if (outcome === "malformed_payload") {
        // A typed error, so parsePending can tell an unreadable payload
        // apart from a database failure it must not swallow. Read through
        // `readForWallet`, not `evaluateSwap`: validation is narrow and lazy
        // now, so an unreadable `timestamp`, `signature` or `slot` is only
        // reached by a payload that produces a trade, and `evaluateSwap`
        // alone would return that trade without ever touching them.
        expect(() => readForWallet(payload, wallet)).toThrow(MalformedPayloadError);
      } else {
        expect(readForWallet(payload, wallet).outcome).toBe(outcome);
      }

      // parsePending must never throw, whatever the shape: an escaping error
      // leaves the row untouched and stalls every delivery behind it.
      await expect(parsePending()).resolves.toBe(1);

      const trades = await query<{ id: string }>("SELECT id FROM trade WHERE kol_id = $1", [kolId]);
      const [raw] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
        "SELECT parsed_at, parse_error FROM raw_tx",
      );

      const expectedError = outcome === "malformed_payload" ? "malformed_payload" : parseErrorFor(outcome);
      const wroteTrade = trades.length > 0;
      const hasError = raw.parse_error !== null;

      // An unreadable payload stays requeueable; everything else is settled.
      expect(raw.parsed_at === null).toBe(outcome === "malformed_payload");

      // The standing invariant: a shape ends as a trade, or as a recorded
      // error, or in one of the few outcomes that are silent by design and
      // individually justified above. Nothing else.
      expect(wroteTrade || hasError || SILENT_BY_DESIGN.has(outcome as SwapOutcome)).toBe(true);

      expect(wroteTrade).toBe(outcome === "trade");
      expect(hasError).toBe(expectedError !== null);
      expect(raw.parse_error).toBe(expectedError);
    },
  );

  it("covers every outcome the parser can produce", () => {
    // A shape can only be asserted if the table has one. If a future change
    // adds an outcome, this fails until a shape for it is added, so the
    // table cannot quietly stop covering the parser.
    // Exhaustive at compile time: adding a member to SwapOutcome breaks
    // `tsc` here until it is listed, and breaks this test until the table
    // has a shape that reaches it.
    const ALL_OUTCOMES: Record<SwapOutcome, true> = {
      trade: true,
      no_token_leg: true,
      dust_only: true,
      stable_rotation: true,
      no_sol_leg: true,
      unsupported_quote: true,
      sol_leg_wrong_direction: true,
    };
    const covered = new Set<string>(shapes.map((s) => s.outcome));
    expect((Object.keys(ALL_OUTCOMES) as SwapOutcome[]).filter((o) => !covered.has(o))).toEqual([]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { buildSwapPayload } from "./fixtures/swap";
import { inventAddress, inventSignature } from "./ids";
import { addWallet } from "./wallets";
import {
  USDC_MINT,
  WSOL_MINT,
  evaluateSwap,
  parseErrorFor,
  parsePending,
  parseSwap,
  type SwapOutcome,
} from "./parse-swap";
import { storeRawTx } from "./raw-tx";

const wallet = { id: "w-1", kolId: "k-1", address: inventAddress() };
const mint = inventAddress();

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
    // mint. That is the only case DUST_RAW_UNITS exists for: a leg this
    // small, in absolute raw terms, regardless of what the other leg is.
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
    outcome: SwapOutcome;
    build: () => ReturnType<typeof buildSwapPayload>;
  };

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
  ];

  it.each(shapes)(
    "$name: reaches its named outcome, and never a silent drop outside the justified set",
    async ({ build, outcome }) => {
      const payload = build();
      await storeRawTx({ signature: payload.signature, blockTime: new Date(), slot: 1, payload, source: "webhook" });

      // The specific named outcome. This is what makes the table catch a
      // real trade being re-routed into a not-a-trade branch: the previous
      // version excluded a catch-all outcome, so anything that drifted into
      // it drifted out of the test's reach at the same time.
      expect(evaluateSwap(payload, { id: "w", kolId: kolId, address: walletAddress }).outcome).toBe(outcome);

      await parsePending();

      const trades = await query<{ id: string }>("SELECT id FROM trade WHERE kol_id = $1", [kolId]);
      const [raw] = await query<{ parse_error: string | null }>("SELECT parse_error FROM raw_tx");

      const wroteTrade = trades.length > 0;
      const hasError = raw.parse_error !== null;

      // The standing invariant: a shape ends as a trade, or as a recorded
      // error, or in one of the few outcomes that are silent by design and
      // individually justified above. Nothing else.
      expect(wroteTrade || hasError || SILENT_BY_DESIGN.has(outcome)).toBe(true);

      expect(wroteTrade).toBe(outcome === "trade");
      expect(hasError).toBe(parseErrorFor(outcome) !== null);
      expect(raw.parse_error).toBe(parseErrorFor(outcome));
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
    const covered = new Set(shapes.map((s) => s.outcome));
    expect((Object.keys(ALL_OUTCOMES) as SwapOutcome[]).filter((o) => !covered.has(o))).toEqual([]);
  });
});

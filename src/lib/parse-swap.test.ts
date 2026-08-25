import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { buildSwapPayload } from "./fixtures/swap";
import { inventAddress, inventSignature } from "./ids";
import { addWallet } from "./wallets";
import { USDC_MINT, WSOL_MINT, evaluateSwap, parsePending, parseSwap } from "./parse-swap";
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
    expect(evaluateSwap(payload, wallet).outcome).toBe("no_trade");
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
    // Review round 1, finding 4: a router can leave a tiny remainder on an
    // intermediate mint. 1 raw unit at 6 decimals (0.000001 tokens) against
    // a real 2-token leg is a ratio of 2,000,000 — comfortably past
    // DUST_RATIO — so the real leg should still win and parse normally.
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

  it("still flags two comparably-sized legs as an unsupported quote despite the dust filter", () => {
    const otherMint = inventAddress();
    const payload = buildSwapPayload({
      wallet: wallet.address,
      mint,
      decimals: 6,
      nativeChangeLamports: -5_000,
      tokenChangeRaw: "-1000000",
      feeLamports: 5_000,
      isFeePayer: true,
      // Same order of magnitude as the first leg: not dust.
      extraTokenChanges: [{ mint: otherMint, decimals: 6, rawTokenAmount: "1500000" }],
    });
    expect(evaluateSwap(payload, wallet).outcome).toBe("unsupported_quote");
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

import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { buildSwapPayload } from "./fixtures/swap";
import { inventAddress, inventSignature } from "./ids";
import { addWallet } from "./wallets";
import { USDC_MINT, WSOL_MINT, isUnsupportedQuote, parsePending, parseSwap } from "./parse-swap";
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
    expect(isUnsupportedQuote(payload, wallet.address)).toBe(true);
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
    expect(isUnsupportedQuote(payload, wallet.address)).toBe(false);
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
  let testMint: string;

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price CASCADE");
    kolId = await makeKol("parse-swap-kol");
    walletAddress = inventAddress();
    await addWallet(kolId, walletAddress);
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

  it("leaves a malformed row retryable: parse_error is set but parsed_at stays null", async () => {
    // Inserted directly rather than through storeRawTx, to force a payload
    // that fails to decrypt/parse — storeRawTx always produces a valid one.
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
    expect(raw.parsed_at).toBeNull(); // still in the unparsed queue for a fix to reprocess
    expect(raw.parse_error).toBe("malformed_payload");
  });
});

/**
 * Turns a stored Helius enhanced transaction into a normalised trade row.
 * Spec §4.3 (what counts as a trade) and §4.4 (fees) are the binding
 * authority for the arithmetic here.
 *
 * Batch 1 parses SOL-quoted swaps only. A swap whose non-token side is not
 * SOL/WSOL is recorded on the `raw_tx` row as `parse_error = 'unsupported_quote'`
 * rather than guessed at (stablecoin- and token-to-token-quoted swaps get their
 * own task).
 */
import { aadFor, decrypt, encrypt } from "./crypto";
import { query } from "./db";
import { findWalletByAddress, type WalletRow } from "./wallets";

/**
 * Wrapped SOL mint. Spec §4.3: "A trade is a swap where the wallet's SOL/WSOL
 * balance moves against a SPL token balance" — WSOL is treated as part of the
 * SOL side, never as the traded token. Public well-known mint address,
 * allowlisted in hygiene.ts.
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * USDC mint. Spec §4.3: "SOL ↔ stablecoin rotation is not a trade and is not
 * indexed" — a wallet swapping SOL directly for USDC (or back) is excluded
 * entirely, not recorded even as `unsupported_quote`. Public well-known mint
 * address, allowlisted in hygiene.ts.
 */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type TokenBalanceChange = {
  userAccount: string;
  mint: string;
  rawTokenAmount: { tokenAmount: string; decimals: number };
};

export type AccountData = {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges: TokenBalanceChange[];
};

/** The subset of Helius's Enhanced Transaction shape this parser reads. */
export type EnhancedTx = {
  signature: string;
  slot: number | null;
  timestamp: number; // unix seconds
  type: string;
  fee: number; // lamports
  feePayer: string;
  accountData: AccountData[];
};

export type ParsedTrade = {
  mint: string;
  side: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
  feeSol: number;
  instructionIndex: number;
};

type TokenLeg = { mint: string; raw: bigint; decimals: number };

/**
 * Every non-zero SPL token leg this wallet held in the transaction, excluding
 * WSOL. Multiple token accounts of the same mint are summed together.
 */
function tokenLegsFor(payload: EnhancedTx, address: string): TokenLeg[] {
  const byMint = new Map<string, { raw: bigint; decimals: number }>();
  for (const account of payload.accountData) {
    for (const change of account.tokenBalanceChanges) {
      if (change.userAccount !== address) continue;
      const raw = BigInt(change.rawTokenAmount.tokenAmount);
      const existing = byMint.get(change.mint);
      byMint.set(change.mint, {
        raw: (existing?.raw ?? 0n) + raw,
        decimals: change.rawTokenAmount.decimals,
      });
    }
  }
  return [...byMint.entries()]
    .filter(([mint, { raw }]) => mint !== WSOL_MINT && raw !== 0n)
    .map(([mint, { raw, decimals }]) => ({ mint, raw, decimals }));
}

/** This wallet's net WSOL balance change (signed, raw units), 0n if none. */
function wsolLegFor(payload: EnhancedTx, address: string): bigint {
  let total = 0n;
  for (const account of payload.accountData) {
    for (const change of account.tokenBalanceChanges) {
      if (change.userAccount === address && change.mint === WSOL_MINT) {
        total += BigInt(change.rawTokenAmount.tokenAmount);
      }
    }
  }
  return total;
}

/** This wallet's net native (lamports) balance change, 0 if the payload has no entry for it. */
function nativeChangeFor(payload: EnhancedTx, address: string): number {
  return payload.accountData
    .filter((a) => a.account === address)
    .reduce((sum, a) => sum + a.nativeBalanceChange, 0);
}

/**
 * True when this wallet's swap moved two or more non-SOL SPL tokens against
 * each other — a token↔token swap, or a stablecoin-quoted swap (the
 * stablecoin itself is a second SPL leg distinct from the traded mint).
 * Batch 1 does not parse these; the caller (`parsePending`) records
 * `parse_error = 'unsupported_quote'` on the `raw_tx` row instead of
 * guessing at a SOL value.
 */
export function isUnsupportedQuote(payload: EnhancedTx, address: string): boolean {
  return tokenLegsFor(payload, address).length >= 2;
}

/**
 * Reads one wallet's leg of a SOL-quoted swap out of a Helius enhanced
 * transaction. Returns null when:
 * - the transaction does not touch this wallet at all;
 * - this wallet moved zero or more-than-one non-SOL SPL token (not a single
 *   SOL-quoted swap — see `isUnsupportedQuote` for the multi-token case);
 * - the only counter-asset is USDC (a SOL↔stablecoin rotation, not a trade
 *   at all per spec §4.3);
 * - there is no SOL/WSOL leg once the transaction fee is accounted for (a
 *   plain token transfer, an airdrop, or the wrap/unwrap side of an
 *   unrelated instruction — not a trade).
 *
 * `nativeBalanceChange` already includes the transaction fee for the fee
 * payer (spec §4.4), so the fee is added back before taking the magnitude:
 * for a buy (native change negative) that cancels part of the fee's
 * negative contribution; for a sell (native change positive) it adds the
 * fee back on top of what was received. Both directions reduce to the same
 * one-line formula.
 */
export function parseSwap(
  payload: EnhancedTx,
  wallet: { id: string; kolId: string; address: string },
): ParsedTrade | null {
  const legs = tokenLegsFor(payload, wallet.address);
  if (legs.length !== 1) return null;

  const { mint, raw, decimals } = legs[0];
  if (mint === USDC_MINT) return null; // SOL<->stablecoin rotation: not a trade (spec §4.3)

  const side: "buy" | "sell" = raw > 0n ? "buy" : "sell";
  const tokenAmount = Number(raw < 0n ? -raw : raw) / 10 ** decimals;

  const isFeePayer = wallet.address === payload.feePayer;
  const fee = payload.fee ?? 0;
  const nativeChange = nativeChangeFor(payload, wallet.address);
  const feeAdjustedNative = isFeePayer ? nativeChange + fee : nativeChange;

  let solAmountLamports = Math.abs(feeAdjustedNative);
  if (solAmountLamports === 0) {
    // No native SOL leg (or it was exactly the fee, and nothing else). The
    // swap may still have moved a persistent WSOL token account instead.
    const wsol = wsolLegFor(payload, wallet.address);
    if (wsol !== 0n) solAmountLamports = Math.abs(Number(wsol));
  }
  if (solAmountLamports <= 0) return null;

  return {
    mint,
    side,
    tokenAmount,
    solAmount: solAmountLamports / 1e9,
    feeSol: isFeePayer ? fee / 1e9 : 0,
    // A Helius "SWAP" enhanced transaction is transaction-level, not
    // per-instruction, so every wallet's leg of it is instruction 0. This is
    // still safe against the (kol_id, mint) fan-out of a multi-wallet
    // transaction: the unique index is (signature_hmac, instruction_index,
    // wallet_id), and wallet_id differs per wallet.
    instructionIndex: 0,
  };
}

/** Every address this transaction mentions, as a candidate wallet to resolve. */
function candidateAddresses(payload: EnhancedTx): string[] {
  const addresses = new Set<string>();
  for (const account of payload.accountData) {
    addresses.add(account.account);
    for (const change of account.tokenBalanceChanges) addresses.add(change.userAccount);
  }
  return [...addresses];
}

async function insertTrade(
  signatureHmac: Buffer,
  payload: EnhancedTx,
  wallet: WalletRow,
  trade: ParsedTrade,
): Promise<void> {
  const id = crypto.randomUUID();
  const signatureEnc = encrypt(payload.signature, aadFor("trade", "signature", id));
  const blockTime = new Date(payload.timestamp * 1000);
  const priceSol = trade.solAmount / trade.tokenAmount;

  const [rate] = await query<{ usd: string }>(
    `SELECT usd FROM sol_price WHERE minute <= date_trunc('minute', $1::timestamptz)
     ORDER BY minute DESC LIMIT 1`,
    [blockTime],
  );
  const solUsd = rate ? Number(rate.usd) : null;
  const usdAmount = solUsd === null ? null : trade.solAmount * solUsd;
  const priceUsd = solUsd === null ? null : priceSol * solUsd;

  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                        mint, side, token_amount, sol_amount, usd_amount, sol_usd, price_sol,
                        price_usd, fee_sol, block_time, slot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (signature_hmac, instruction_index, wallet_id) DO NOTHING`,
    [
      id,
      signatureHmac,
      signatureEnc,
      trade.instructionIndex,
      wallet.kol_id,
      wallet.id,
      trade.mint,
      trade.side,
      trade.tokenAmount,
      trade.solAmount,
      usdAmount,
      solUsd,
      priceSol,
      priceUsd,
      trade.feeSol,
      blockTime,
      payload.slot,
    ],
  );

  await query(
    `INSERT INTO position (kol_id, mint, dirty) VALUES ($1, $2, TRUE)
     ON CONFLICT (kol_id, mint) DO UPDATE SET dirty = TRUE`,
    [wallet.kol_id, trade.mint],
  );
}

/**
 * Parses up to `limit` unparsed `raw_tx` rows into `trade` rows.
 *
 * For each row: decrypt the payload, resolve every address it mentions
 * through `findWalletByAddress`, and run `parseSwap` for each match. A
 * genuine parse failure (the ciphertext or the JSON is malformed) records
 * `parse_error` but leaves `parsed_at` null, so the row stays in the
 * unparsed queue for a parser fix to reprocess without spending another
 * Helius credit (spec §5.2) — a bad row can spin forever until fixed, which
 * is the accepted cost of that design. An out-of-scope quote sets
 * `parse_error = 'unsupported_quote'` and `parsed_at`, a deliberate
 * exception: batch 1 will never support it, so leaving it in the retry
 * queue forever would be pure waste, not a chance at a future fix.
 *
 * Returns the number of `raw_tx` rows this call examined.
 */
export async function parsePending(limit = 100): Promise<number> {
  const rows = await query<{ signature_hmac: Buffer; payload_enc: Buffer }>(
    `SELECT signature_hmac, payload_enc FROM raw_tx WHERE parsed_at IS NULL
     ORDER BY received_at LIMIT $1`,
    [limit],
  );

  for (const row of rows) {
    const hmacHex = row.signature_hmac.toString("hex");

    let payload: EnhancedTx;
    try {
      payload = JSON.parse(decrypt(row.payload_enc, aadFor("raw_tx", "payload", hmacHex))) as EnhancedTx;
    } catch {
      // Never log the ciphertext or any decrypted fragment: it may contain
      // an address or signature.
      console.warn("parsePending: failed to decrypt or parse a raw_tx payload");
      await query(`UPDATE raw_tx SET parse_error = $2 WHERE signature_hmac = $1`, [
        row.signature_hmac,
        "malformed_payload",
      ]);
      continue;
    }

    let wroteTrade = false;
    let unsupported = false;

    for (const address of candidateAddresses(payload)) {
      const walletRow = await findWalletByAddress(address);
      if (!walletRow) continue;

      const trade = parseSwap(payload, { id: walletRow.id, kolId: walletRow.kol_id, address });
      if (trade) {
        await insertTrade(row.signature_hmac, payload, walletRow, trade);
        wroteTrade = true;
      } else if (isUnsupportedQuote(payload, address)) {
        unsupported = true;
      }
    }

    const parseError = !wroteTrade && unsupported ? "unsupported_quote" : null;
    await query(`UPDATE raw_tx SET parsed_at = now(), parse_error = $2 WHERE signature_hmac = $1`, [
      row.signature_hmac,
      parseError,
    ]);
  }

  return rows.length;
}

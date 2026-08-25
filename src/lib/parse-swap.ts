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

/**
 * A leg's raw amount at or below this floor is treated as router noise (the
 * 1-unit remainder a router can leave on an intermediate mint), not a real
 * leg (review round 2, finding: the round-1 fix compared raw *counts* across
 * mints using a ratio, which conflates count with value — a token↔token
 * swap of 1,000,000 units against 0.5 units is an entirely ordinary trade,
 * not one where the smaller count is "dust", and dropping it fabricated a
 * near-zero cost basis on a real position). This is an absolute floor
 * instead: only a raw amount this small is dust, regardless of what the
 * other leg's raw amount is. The parser has no price data, so it cannot
 * judge which of two genuine legs matters more; if more than one leg clears
 * this floor, the swap is `unsupported_quote`, never guessed at.
 */
const DUST_RAW_UNITS = 1n;

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

/**
 * The full result of evaluating one wallet's role in a transaction, not just
 * whether it produced a trade — `parsePending` needs the distinction to
 * record a specific, honest `parse_error` instead of a silent drop.
 *
 * - `no_trade`: nothing to record and no error — the transaction doesn't
 *   touch this wallet, moved no SPL token, or is a SOL↔USDC rotation (spec
 *   §4.3, not a trade at all).
 * - `unsupported_quote`: a real swap this batch does not parse (stablecoin-
 *   or token-to-token-quoted), or two-or-more genuine legs the parser has no
 *   price data to arbitrate between — see `DUST_RAW_UNITS` for the narrow
 *   case (a router's literal 1-unit remainder) that does not count as a
 *   second leg.
 * - `sol_leg_wrong_direction`: the SOL/WSOL leg moved the same way as the
 *   token leg (review round 1, finding 2) — e.g. a sell whose proceeds were
 *   more than eaten by a priority-fee tip, so the net SOL delta is still
 *   negative. Booking that as a positive `solAmount` would manufacture
 *   realized profit out of a loss, so it is rejected rather than guessed at.
 */
export type SwapOutcome = "trade" | "no_trade" | "unsupported_quote" | "sol_leg_wrong_direction";

export type SwapEvaluation =
  | { outcome: "trade"; trade: ParsedTrade }
  | { outcome: Exclude<SwapOutcome, "trade"> };

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

/**
 * Drops any leg whose raw amount is at or below `DUST_RAW_UNITS`. Everything
 * above that floor is a real leg, judged absolutely — never against another
 * leg's size, which would compare counts across mints as if they were
 * values.
 */
function dropDust(legs: TokenLeg[]): TokenLeg[] {
  // A dust floor exists to remove a router's leftover leg *alongside* a
  // surviving real leg. Applied to a sole leg it would delete the trade
  // outright: a 1-raw-unit balance change can be the entire, genuine swap
  // (a 0-decimal mint bought/sold as exactly one whole unit), not a router
  // remainder. Every directed case for this filter (round 2) has two or
  // more legs before filtering, so this guard changes none of them.
  if (legs.length <= 1) return legs;
  return legs.filter((leg) => (leg.raw < 0n ? -leg.raw : leg.raw) > DUST_RAW_UNITS);
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
 * Evaluates one wallet's role in a Helius enhanced transaction. This is the
 * single source of truth for the SOL-quoted-swap arithmetic; `parseSwap`
 * below is a thin projection of it onto its historical `ParsedTrade | null`
 * contract.
 *
 * The SOL/WSOL side is spec §4.3's "one quantity": native lamports and a
 * persistent WSOL token account are always summed, never treated as
 * alternatives (review round 1, finding 1) — a transaction can legitimately
 * move both (e.g. gas and ATA rent through native lamports, the swap itself
 * through a standing WSOL account).
 *
 * `nativeBalanceChange` already includes the transaction fee for the fee
 * payer (spec §4.4), so the fee is added back before the direction check —
 * for a buy (native change negative) that cancels part of the fee's negative
 * contribution; for a sell (native change positive) it adds the fee back on
 * top of what was received.
 *
 * The combined SOL delta must move opposite the token leg — a buy spends SOL
 * (delta < 0), a sell receives it (delta > 0). Taking `Math.abs` without
 * checking this would silently flip a net outflow into "proceeds" whenever a
 * tip or a fee ate more than a sell returned, or a rent refund into a
 * "purchase" (review round 1, finding 2); that case is rejected instead of
 * guessed at.
 */
export function evaluateSwap(
  payload: EnhancedTx,
  wallet: { id: string; kolId: string; address: string },
): SwapEvaluation {
  const legs = dropDust(tokenLegsFor(payload, wallet.address));
  if (legs.length === 0) return { outcome: "no_trade" };
  if (legs.length >= 2) return { outcome: "unsupported_quote" };

  const { mint, raw, decimals } = legs[0];
  if (mint === USDC_MINT) return { outcome: "no_trade" }; // SOL<->stablecoin rotation (spec §4.3)

  const side: "buy" | "sell" = raw > 0n ? "buy" : "sell";
  const tokenAmount = Number(raw < 0n ? -raw : raw) / 10 ** decimals;

  const isFeePayer = wallet.address === payload.feePayer;
  const fee = payload.fee ?? 0;
  const nativeChange = nativeChangeFor(payload, wallet.address);
  const feeAdjustedNative = isFeePayer ? nativeChange + fee : nativeChange;
  const wsol = wsolLegFor(payload, wallet.address);
  const solDelta = feeAdjustedNative + Number(wsol); // spec §4.3: SOL and WSOL are one quantity

  if (solDelta === 0) return { outcome: "no_trade" }; // no SOL/WSOL leg at all

  const wrongDirection = side === "buy" ? solDelta >= 0 : solDelta <= 0;
  if (wrongDirection) return { outcome: "sol_leg_wrong_direction" };

  return {
    outcome: "trade",
    trade: {
      mint,
      side,
      tokenAmount,
      solAmount: Math.abs(solDelta) / 1e9,
      feeSol: isFeePayer ? fee / 1e9 : 0,
      // A Helius "SWAP" enhanced transaction is transaction-level, not
      // per-instruction, so every wallet's leg of it is instruction 0. This is
      // still safe against the (kol_id, mint) fan-out of a multi-wallet
      // transaction: the unique index is (signature_hmac, instruction_index,
      // wallet_id), and wallet_id differs per wallet.
      instructionIndex: 0,
    },
  };
}

/** Reads one wallet's leg of a SOL-quoted swap. See `evaluateSwap` for the full classification. */
export function parseSwap(
  payload: EnhancedTx,
  wallet: { id: string; kolId: string; address: string },
): ParsedTrade | null {
  const result = evaluateSwap(payload, wallet);
  return result.outcome === "trade" ? result.trade : null;
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
 * Priority used when two different tracked wallets in the same transaction
 * hit two different non-trade outcomes: a wrong-direction leg is a rejected
 * trade with real money on it, which matters more to surface than a quote
 * this batch simply doesn't parse yet.
 */
function higherPriorityError(
  a: "unsupported_quote" | "sol_leg_wrong_direction" | null,
  b: "unsupported_quote" | "sol_leg_wrong_direction",
): "unsupported_quote" | "sol_leg_wrong_direction" {
  if (a === "sol_leg_wrong_direction" || b === "sol_leg_wrong_direction") return "sol_leg_wrong_direction";
  return "unsupported_quote";
}

/**
 * Parses up to `limit` unparsed `raw_tx` rows into `trade` rows.
 *
 * For each row: decrypt the payload, resolve every address it mentions
 * through `findWalletByAddress`, and evaluate each *active* tracked wallet's
 * leg independently (spec §9: a withdrawn wallet stops being indexed, so its
 * status is checked here rather than in `findWalletByAddress`, whose
 * contract other callers rely on). A transaction can carry more than one
 * tracked wallet with different outcomes — one wallet's clean trade must not
 * hide another wallet's dropped swap (review round 1, finding 3), so every
 * non-`no_trade` outcome across the whole row is tracked and the row's
 * `parse_error` reflects it even when a trade was also written.
 *
 * A genuine parse failure (the ciphertext or the JSON is malformed) records
 * `parse_error` but leaves `parsed_at` null, so the row stays eligible for a
 * parser fix to reprocess without spending another Helius credit (spec
 * §5.2). `unsupported_quote` and `sol_leg_wrong_direction` are the opposite:
 * both are cases this parser version deliberately never guesses at, not bugs
 * a future deploy might fix on retry, so they also set `parsed_at`. Either
 * way, the pending-rows query below excludes any row with `parse_error` set,
 * so a run of bad rows cannot crowd a later good delivery out of the queue
 * (review round 1, finding 5) — clearing `parse_error` is what makes a row
 * reprocessable again, independent of `parsed_at`.
 *
 * Returns the number of `raw_tx` rows this call examined.
 */
export async function parsePending(limit = 100): Promise<number> {
  const rows = await query<{ signature_hmac: Buffer; payload_enc: Buffer }>(
    `SELECT signature_hmac, payload_enc FROM raw_tx WHERE parsed_at IS NULL AND parse_error IS NULL
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

    let rowError: "unsupported_quote" | "sol_leg_wrong_direction" | null = null;

    for (const address of candidateAddresses(payload)) {
      const walletRow = await findWalletByAddress(address);
      if (!walletRow || walletRow.status !== "active") continue; // spec §9: withdrawal stops indexing

      const wallet = { id: walletRow.id, kolId: walletRow.kol_id, address };
      const result = evaluateSwap(payload, wallet);

      if (result.outcome === "trade") {
        await insertTrade(row.signature_hmac, payload, walletRow, result.trade);
      } else if (result.outcome === "unsupported_quote" || result.outcome === "sol_leg_wrong_direction") {
        rowError = higherPriorityError(rowError, result.outcome);
      }
    }

    await query(`UPDATE raw_tx SET parsed_at = now(), parse_error = $2 WHERE signature_hmac = $1`, [
      row.signature_hmac,
      rowError,
    ]);
  }

  return rows.length;
}

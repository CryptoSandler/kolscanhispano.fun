/**
 * Turns a stored Helius enhanced transaction into a normalised trade row.
 * Spec §4.3 (what counts as a trade) and §4.4 (fees) are the binding
 * authority for the arithmetic here.
 *
 * Batch 1 parses SOL-quoted swaps only. A swap whose non-token side is not
 * SOL/WSOL is recorded on the `raw_tx` row as `parse_error = 'unsupported_quote'`
 * rather than guessed at (stablecoin- and token-to-token-quoted swaps get their
 * own task).
 *
 * **The one rule this file keeps getting wrong.** Three review rounds in a row
 * introduced a defect by comparing two quantities that are not in the same
 * unit: a token *count* against a ratio as if it were a value, then raw units
 * across mints whose decimals differ by nine orders of magnitude. Every
 * comparison and every sum below is therefore annotated with the unit it is
 * in, and anything that crosses units goes through an explicit, exact
 * integer conversion (`powTen`, `toLamports`) instead of being added
 * directly. Two numbers may only be compared or summed here once they are
 * demonstrably in the same unit: lamports with lamports, token quantities
 * with token quantities.
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

/** SOL, and therefore WSOL, has 9 decimals: one raw WSOL unit is one lamport. */
const LAMPORT_DECIMALS = 9;

/**
 * Upper bound on a payload-reported `decimals` before it is treated as
 * nonsense. Guards `powTen` against being handed a huge exponent by a
 * malformed payload; no SPL mint exceeds 9 in practice.
 */
const MAX_DECIMALS = 32;

/**
 * The dust floor, expressed as a **token quantity** (`raw / 10**decimals`),
 * never as a raw unit count and never as a ratio between two legs.
 *
 * Why not raw units (the round-3 rule this replaces): one raw unit of a
 * 9-decimal mint is a billionth of a token, and one raw unit of a 0-decimal
 * mint is a whole token. A floor stated in raw units therefore compares
 * quantities that are not in the same unit, and it let a sole 1-raw-unit leg
 * of a 6- or 9-decimal mint be booked as a real trade priced off ATA rent
 * residue (`price_sol` 2,039.28 and 4,995,000 respectively — a fabricated
 * cost basis written into `trade` and `position`).
 *
 * Why not a ratio between legs (the round-1 rule): the parser has no price
 * data, so a count 200,000× smaller than another count says nothing about
 * which leg matters. See `evaluateSwap`: two surviving legs are
 * `unsupported_quote`, never arbitrated.
 *
 * **The threshold: one millionth of a token, inclusive.** A leg at or below
 * 1/1,000,000 of a token is router noise. That is exactly one raw unit of a
 * 6-decimal mint (the smallest amount such a mint can even express, and the
 * literal remainder a router leaves on an intermediate mint) and up to 1,000
 * raw units of a 9-decimal mint. It is below the smallest expressible amount
 * of any mint with 5 or fewer decimals, so a 0-decimal mint's single unit —
 * a whole token, and possibly the entire trade — is never dust. Two raw
 * units of a 6-decimal mint (2/1,000,000) are above the floor and stay a
 * real leg: the floor removes only what a mint's own precision makes
 * indistinguishable from zero, and nothing larger.
 *
 * Kept as an exact rational so the comparison can be done in integer
 * arithmetic (see `isDust`); 1e-6 as a float would reintroduce rounding at
 * exactly the boundary the constant exists to define.
 */
const DUST_MAX_TOKENS_NUMERATOR = 1n;
const DUST_MAX_TOKENS_DENOMINATOR = 1_000_000n;

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
 * There is deliberately **no bare `no_trade` member**. It used to collect
 * four unrelated situations under one name, and the invariant test then had
 * to exclude that whole outcome to accommodate the two of them that are
 * genuine spec exclusions — which meant a real trade routed into the same
 * outcome by a later change (and one was, by the dust floor) was excluded
 * along with them, silently. Every non-trade result is named, so a test can
 * assert the *specific* one a shape must reach.
 *
 * - `no_token_leg`: this wallet moved no SPL token at all — usually the
 *   transaction simply does not touch it. Not a trade, no error.
 * - `dust_only`: every token leg this wallet moved is below the dust floor
 *   (see `DUST_MAX_TOKENS_NUMERATOR`). Not a trade, no error.
 * - `stable_rotation`: the sole leg is a stablecoin, i.e. a SOL ↔ stablecoin
 *   rotation, which spec §4.3 says is *not a trade and is not indexed*. Not
 *   an error: it is correct behaviour, not a gap.
 * - `no_sol_leg`: a real token leg moved, but the wallet's net SOL/WSOL
 *   delta is exactly zero, so spec §4.3's "SOL/WSOL balance moves against a
 *   SPL token balance" is not satisfied — a transfer or an airdrop, not a
 *   swap. Not a trade, no error.
 * - `unsupported_quote`: a real swap this batch does not parse (stablecoin-
 *   or token-to-token-quoted), or two-or-more genuine legs the parser has no
 *   price data to arbitrate between.
 * - `sol_leg_wrong_direction`: the SOL/WSOL leg moved the same way as the
 *   token leg (review round 1, finding 2) — e.g. a sell whose proceeds were
 *   more than eaten by a priority-fee tip, so the net SOL delta is still
 *   negative. Booking that as a positive `solAmount` would manufacture
 *   realized profit out of a loss, so it is rejected rather than guessed at.
 */
export type SwapOutcome =
  | "trade"
  | "no_token_leg"
  | "dust_only"
  | "stable_rotation"
  | "no_sol_leg"
  | "unsupported_quote"
  | "sol_leg_wrong_direction";

/** The outcomes that are recorded on the `raw_tx` row rather than passed over in silence. */
export type SwapParseError = "unsupported_quote" | "sol_leg_wrong_direction";

/**
 * The single mapping from an outcome to the `parse_error` it records, so the
 * set of silent-by-design outcomes is stated once and can be asserted
 * directly by tests instead of being re-derived at each call site.
 */
export function parseErrorFor(outcome: SwapOutcome): SwapParseError | null {
  return outcome === "unsupported_quote" || outcome === "sol_leg_wrong_direction" ? outcome : null;
}

export type SwapEvaluation =
  | { outcome: "trade"; trade: ParsedTrade }
  | { outcome: Exclude<SwapOutcome, "trade"> };

type TokenLeg = { mint: string; raw: bigint; decimals: number };

/** Exact 10**n as a bigint. `n` must already have been through `normalizeDecimals`. */
function powTen(n: number): bigint {
  return 10n ** BigInt(n);
}

/** A payload-reported `decimals`, clamped to something `powTen` can safely raise. */
function normalizeDecimals(decimals: number): number {
  if (!Number.isFinite(decimals) || decimals <= 0) return 0;
  return Math.min(Math.trunc(decimals), MAX_DECIMALS);
}

/** A payload-reported lamports figure as an exact integer, 0 if it is not a finite number. */
function lamports(value: number): bigint {
  return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
}

/**
 * Converts a raw WSOL amount to lamports using the decimals the payload
 * reports for that balance change, rather than assuming one raw unit is one
 * lamport. WSOL is 9 decimals on chain, so this is normally the identity —
 * but "normally the identity" is precisely how a unit mismatch hides: a
 * balance change reporting any other scale would otherwise be added straight
 * into a lamports total.
 */
function toLamports(raw: bigint, decimals: number): bigint {
  if (decimals === LAMPORT_DECIMALS) return raw;
  if (decimals < LAMPORT_DECIMALS) return raw * powTen(LAMPORT_DECIMALS - decimals);
  return raw / powTen(decimals - LAMPORT_DECIMALS); // truncates toward zero
}

/**
 * Every non-zero SPL token leg this wallet held in the transaction, excluding
 * WSOL. Multiple token accounts of the same mint are summed together — after
 * being brought to a common scale, since two balance changes of one mint that
 * report different decimals are not addable as they stand.
 */
function tokenLegsFor(payload: EnhancedTx, address: string): TokenLeg[] {
  const byMint = new Map<string, { raw: bigint; decimals: number }>();
  for (const account of payload.accountData) {
    for (const change of account.tokenBalanceChanges) {
      if (change.userAccount !== address) continue;
      const decimals = normalizeDecimals(change.rawTokenAmount.decimals);
      const raw = BigInt(change.rawTokenAmount.tokenAmount);
      const existing = byMint.get(change.mint);
      if (!existing) {
        byMint.set(change.mint, { raw, decimals });
        continue;
      }
      // Scale both to the finer of the two before adding: 1 raw unit at 6
      // decimals and 1 raw unit at 9 decimals are different quantities of
      // the same token, and summing them as they stand would overstate the
      // coarser one by 1000x.
      const scale = Math.max(existing.decimals, decimals);
      byMint.set(change.mint, {
        raw: existing.raw * powTen(scale - existing.decimals) + raw * powTen(scale - decimals),
        decimals: scale,
      });
    }
  }
  return [...byMint.entries()]
    .filter(([mint, { raw }]) => mint !== WSOL_MINT && raw !== 0n)
    .map(([mint, { raw, decimals }]) => ({ mint, raw, decimals }));
}

/**
 * Whether a leg's **token quantity** is at or below the dust floor. The
 * comparison `|raw| / 10**decimals <= NUMERATOR / DENOMINATOR` is
 * cross-multiplied into `|raw| * DENOMINATOR <= NUMERATOR * 10**decimals`
 * so it stays exact integer arithmetic: dividing first would round a
 * 9-decimal leg to zero in double precision and make the floor's boundary
 * depend on the mint's scale, which is the bug this whole rule replaces.
 */
function isDust(leg: TokenLeg): boolean {
  const magnitude = leg.raw < 0n ? -leg.raw : leg.raw;
  return magnitude * DUST_MAX_TOKENS_DENOMINATOR <= DUST_MAX_TOKENS_NUMERATOR * powTen(leg.decimals);
}

/**
 * Drops every leg whose token quantity is at or below the dust floor.
 *
 * There is no arity guard here. Round 3 added `if (legs.length <= 1) return
 * legs` so that a sole 1-raw-unit leg of a 0-decimal mint — a whole token,
 * and the entire trade — would not be filtered away, which was a real
 * problem with a raw-unit floor. A decimals-aware floor solves that case on
 * its own (one whole token is nowhere near 1/1,000,000 of a token), and
 * keeping the guard would exempt a sole leg from the floor entirely,
 * re-opening exactly the fabricated-cost-basis case this rule exists to
 * close. A sole leg that really is dust yields `dust_only`, which is a
 * named, testable outcome rather than a silent one.
 */
function dropDust(legs: TokenLeg[]): TokenLeg[] {
  return legs.filter((leg) => !isDust(leg));
}

/** This wallet's net WSOL balance change, **in lamports**, 0n if none. */
function wsolLamportsFor(payload: EnhancedTx, address: string): bigint {
  let total = 0n;
  for (const account of payload.accountData) {
    for (const change of account.tokenBalanceChanges) {
      if (change.userAccount === address && change.mint === WSOL_MINT) {
        total += toLamports(
          BigInt(change.rawTokenAmount.tokenAmount),
          normalizeDecimals(change.rawTokenAmount.decimals),
        );
      }
    }
  }
  return total;
}

/** This wallet's net native balance change, **in lamports**, 0n if the payload has no entry for it. */
function nativeLamportsFor(payload: EnhancedTx, address: string): bigint {
  return payload.accountData
    .filter((a) => a.account === address)
    .reduce((sum, a) => sum + lamports(a.nativeBalanceChange), 0n);
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
 * through a standing WSOL account). Both terms are converted to lamports
 * first; the sum is kept in bigint so a large delta cannot lose its low bits
 * to double precision before the sign is checked.
 *
 * `nativeBalanceChange` already includes the transaction fee for the fee
 * payer (spec §4.4), so the fee is added back before the direction check —
 * for a buy (native change negative) that cancels part of the fee's negative
 * contribution; for a sell (native change positive) it adds the fee back on
 * top of what was received.
 *
 * The combined SOL delta must move opposite the token leg — a buy spends SOL
 * (delta < 0), a sell receives it (delta > 0). Taking the magnitude without
 * checking this would silently flip a net outflow into "proceeds" whenever a
 * tip or a fee ate more than a sell returned, or a rent refund into a
 * "purchase" (review round 1, finding 2); that case is rejected instead of
 * guessed at.
 */
export function evaluateSwap(
  payload: EnhancedTx,
  wallet: { id: string; kolId: string; address: string },
): SwapEvaluation {
  const allLegs = tokenLegsFor(payload, wallet.address);
  const legs = dropDust(allLegs);
  if (legs.length === 0) {
    return { outcome: allLegs.length === 0 ? "no_token_leg" : "dust_only" };
  }
  if (legs.length >= 2) return { outcome: "unsupported_quote" };

  const { mint, raw, decimals } = legs[0];
  if (mint === USDC_MINT) return { outcome: "stable_rotation" }; // spec §4.3: not a trade

  const side: "buy" | "sell" = raw > 0n ? "buy" : "sell";
  const tokenAmount = Number(raw < 0n ? -raw : raw) / 10 ** decimals;

  const isFeePayer = wallet.address === payload.feePayer;
  const fee = lamports(payload.fee ?? 0);
  const nativeChange = nativeLamportsFor(payload, wallet.address);
  const feeAdjustedNative = isFeePayer ? nativeChange + fee : nativeChange;
  // Both terms are lamports by construction; spec §4.3 treats SOL and WSOL as one quantity.
  const solDelta = feeAdjustedNative + wsolLamportsFor(payload, wallet.address);

  if (solDelta === 0n) return { outcome: "no_sol_leg" };

  const wrongDirection = side === "buy" ? solDelta > 0n : solDelta < 0n;
  if (wrongDirection) return { outcome: "sol_leg_wrong_direction" };

  return {
    outcome: "trade",
    trade: {
      mint,
      side,
      tokenAmount,
      solAmount: Number(solDelta < 0n ? -solDelta : solDelta) / 1e9,
      feeSol: isFeePayer ? Number(fee) / 1e9 : 0,
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
function higherPriorityError(a: SwapParseError | null, b: SwapParseError): SwapParseError {
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
 * outcome that `parseErrorFor` names as an error is tracked across the whole
 * row and the row's `parse_error` reflects it even when a trade was also
 * written.
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

    let rowError: SwapParseError | null = null;

    for (const address of candidateAddresses(payload)) {
      const walletRow = await findWalletByAddress(address);
      if (!walletRow || walletRow.status !== "active") continue; // spec §9: withdrawal stops indexing

      const wallet = { id: walletRow.id, kolId: walletRow.kol_id, address };
      const result = evaluateSwap(payload, wallet);

      if (result.outcome === "trade") {
        await insertTrade(row.signature_hmac, payload, walletRow, result.trade);
        continue;
      }
      const error = parseErrorFor(result.outcome);
      if (error) rowError = higherPriorityError(rowError, error);
    }

    await query(`UPDATE raw_tx SET parsed_at = now(), parse_error = $2 WHERE signature_hmac = $1`, [
      row.signature_hmac,
      rowError,
    ]);
  }

  return rows.length;
}

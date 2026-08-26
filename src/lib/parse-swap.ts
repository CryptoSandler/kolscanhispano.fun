/**
 * Turns a stored Helius enhanced transaction into a normalised trade row.
 * Spec §4.3 (what counts as a trade) and §4.4 (fees) are the binding
 * authority for the arithmetic here.
 *
 * Batch 1 parsed SOL-quoted swaps only. Batch 2 task 7 adds spec §4.3's
 * **stablecoin-quoted** swap: a USDC leg against a token leg is normalised to
 * SOL at the SOL/USD rate recorded for the block's own minute, and from there
 * it is the same trade a SOL-quoted swap of equal value would have been.
 * Everything else with two or more legs is still refused rather than guessed
 * at, each with its own named reason (see `SwapOutcome`).
 *
 * **The rate that valuation is allowed to use, and the one it is not.** It
 * comes from `prices.ts`'s `solUsdForMinute` — the row for the block's
 * *containing* minute, spec §5.7's own words — never from `solUsdAt`, whose
 * `minute <= …` bound answers with whatever row happened to be most recent.
 * The difference is what the number becomes: `solUsdAt` feeds `usd_amount`, a
 * second rendering of a SOL figure already measured exactly, where a stale
 * rate is slightly off and nothing else moves; here the rate *is* the SOL
 * figure, and a stale one writes a cost basis, a `price_sol`, a position and
 * a leaderboard rank off a price no source reported for that block. So a
 * missing row is a refusal (`unsupported_quote_no_rate`), left requeueable so
 * a later per-minute series can fill it in. Nothing is written from a rate
 * this parser had to reach backwards in time for.
 *
 * **Token ↔ token stays declined, and not for want of trying.** Spec §4.3
 * would have it close leg A and open leg B at the implied SOL value, and two
 * independent things block that here. There is no price for either leg *at
 * the block*: this project stores one mutable current price per mint
 * (`token.price_sol`, with an `updated_at` that moves), no history, so valuing
 * an old block from it would make the same row parse to different numbers
 * depending on when the parser happened to run — a guess that also breaks the
 * idempotent reparse. And the two trades it would produce cannot both be
 * stored: the unique index is `(signature_hmac, instruction_index, wallet_id)`
 * and task 6 measured that the payload carries no per-instruction detail to
 * index by, so the second row would either collide and be silently dropped by
 * `ON CONFLICT DO NOTHING` or be written under an invented index. Recorded as
 * `unsupported_quote_token_token`, which is a distinct, countable reason
 * rather than a shrug.
 *
 * **Read this first: every classification in this file is monotone under
 * dropped data, so no check anywhere can substitute for measuring the
 * number.** If part of a payload is skipped, what remains still looks like a
 * valid, self-consistent trade — and every guard below will agree that it is:
 *
 * - The **direction** check survives it. Half a SOL side has the same sign as
 *   the whole of it, so a buy stays a buy: the check catches a wrong sign,
 *   never a wrong magnitude. A dropped half was written as `sol_amount 0.5,
 *   price_sol 0.25` against a truth of `1` and `0.5` — a cost basis 2x wrong,
 *   with `parse_error` NULL.
 * - The **arity** check survives it. A genuine two-leg swap with one leg's
 *   identity unreadable is a perfectly ordinary one-leg trade,
 *   `tok=2 sol=1 price=0.5`, and never reaches `unsupported_quote`.
 * - The **dust floor** survives it. Half a token leg hidden gives
 *   `token_amount 1, price_sol 1` against a truth of `0.5`; both are far above
 *   the floor, so nothing is filtered and nothing is flagged.
 * - `solDelta === 0 -> no_sol_leg` survives it too, in the other direction:
 *   drop the only entry carrying the SOL side and a real trade resolves to a
 *   silent, spec-sanctioned "not a swap".
 *
 * Every review round that tried to make this file *more* available — skip the
 * unreadable part, keep the readable part — reintroduced the same defect,
 * because the surviving data always passes. The only safe response to data
 * this parser cannot read is to refuse the row: a refusal is recorded and
 * requeueable, a halved cost basis is neither. Where refusing is not
 * warranted, it is because the dropped data provably could not have moved a
 * number (a zero-valued change, a wallet with no leg in the transaction) —
 * never because a later check would have caught it.
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
 *
 * **Reading the payload is total.** Every field access and every integer
 * parse goes through a `require*` guard that raises `MalformedPayloadError`,
 * which `parsePending` records on the row. Nothing reachable from payload
 * data may raise a bare `TypeError` or `SyntaxError`, and no payload field
 * may become a number by coercion or by a default.
 *
 * Three stalls and one wrong number came from a field left outside that
 * discipline. `BigInt("1.5")` threw a bare `SyntaxError` out of
 * `parsePending` with the row still `parsed_at NULL, parse_error NULL`, and
 * since the pending query orders by `received_at` it was re-selected and
 * threw again forever. A missing `timestamp` reached the same permanent
 * stall one door over, through Postgres (`invalid input syntax for type
 * timestamp with time zone: "0NaN-NaN-NaN…"`), as did a non-string
 * `signature` and a non-numeric `slot`. A `timestamp: null` was worse than a
 * stall: it coerced to `1970-01-01` and wrote a trade with a 1970 block time
 * and a 1970 SOL/USD lookup, with nothing recorded anywhere. And a
 * `decimals` that silently became `0` wrote a cost basis wrong by a factor
 * of a million.
 *
 * **Validation is narrow, not payload-wide.** A malformed field on an
 * account belonging to no tracked wallet — an untracked liquidity pool, say
 * — must not cost a tracked wallet its trade, so nothing is validated until
 * it is actually read, for a specific wallet.
 *
 * Values (`fee`, `nativeBalanceChange`, `rawTokenAmount`, `decimals`,
 * `mint`, `feePayer`) are read only for the wallet under evaluation, and the
 * transaction header (`signature`, `timestamp`, `slot`) only when a trade is
 * about to be written.
 *
 * *Identity* (`account`, `userAccount`) is narrower still: an identity that
 * cannot be read is **not one of ours**, because `""`, `null` and a number
 * can none of them equal a tracked address. Such an entry is skipped, not
 * fatal — Helius is documented to emit `userAccount: ""` for token accounts
 * it cannot attribute, and failing the row on one would turn every delivery
 * containing one into `malformed_payload` and take the feed quiet with
 * nothing anywhere reporting it. The fail-closed reading is kept for the
 * case that earns it: an entry that demonstrably belongs to the wallet being
 * evaluated (`account === address`), where an unreadable
 * `tokenBalanceChanges` or `userAccount` really could be hiding that
 * wallet's own leg.
 *
 * The leniency stops short wherever dropped data could have moved a number,
 * which by the monotonicity above is anywhere it was non-zero. The two
 * identities are not interchangeable: the native leg is keyed off `account`,
 * while the token and WSOL legs are keyed off `userAccount` — and in the
 * real ATA shape the WSOL leg sits on a separate entry whose `account` is
 * the token account, not the wallet. So an unreadable `account` over a
 * non-zero `nativeBalanceChange` raises (see `nativeLamportsFor`), and an
 * unattributable non-zero *balance change* raises whenever the wallet being
 * evaluated has an attributable leg of its own (see `balanceChangesFor`).
 * What stays skipped is only what provably moved nothing: a zero-valued
 * change, an `account` with no lamport movement, and a row where this wallet
 * has neither a leg nor any net SOL movement of its own.
 *
 * The single fatal structural check left is `accountData` itself being an
 * array: a payload with nothing readable there mentions no addresses at all,
 * so skipping it would settle the row as "touches no tracked wallet" — a
 * silent drop, and not requeueable.
 */
import { aadFor, decrypt, encrypt } from "./crypto";
import { ONE, formatDecimal, mulDiv, parseDecimal } from "./decimal";
import { query, withTransaction } from "./db";
import { USDC_MINT, WSOL_MINT } from "./mints";
import { solUsdAt, solUsdForMinute, valueTrade } from "./prices";
import { findWalletByAddress, type WalletRow } from "./wallets";

/**
 * Re-exported so every existing importer of `WSOL_MINT`/`USDC_MINT` keeps
 * working. The definitions moved to `mints.ts` when this file began importing
 * `prices.ts`: `prices.ts` needs both mints, and reading them from here would
 * have made the two modules a cycle.
 */
export { USDC_MINT, WSOL_MINT } from "./mints";

/** SOL, and therefore WSOL, has 9 decimals: one raw WSOL unit is one lamport. */
const LAMPORT_DECIMALS = 9;

/** Lamports in one SOL, as an exact integer. Every SOL quantity here is lamports. */
const LAMPORTS_PER_SOL = 10n ** BigInt(LAMPORT_DECIMALS);

/**
 * Upper bound on a payload-reported `decimals` before it is treated as
 * nonsense. Guards `powTen` against being handed a huge exponent by a
 * malformed payload; no SPL mint exceeds 9 in practice, so 32 is already
 * generous. A `decimals` outside `[0, MAX_DECIMALS]` is malformed, not
 * clamped — see `requireDecimals`.
 */
const MAX_DECIMALS = 32;

/**
 * Bounds on a payload-reported unix-seconds `timestamp`. The floor is years
 * before Solana mainnet-beta existed, so no transaction this project can
 * index falls below it; the ceiling is the year 2100. The point is not to
 * date-check a real transaction but to reject the values that are not a
 * timestamp at all — `0`, `null` coerced to `0`, or a millisecond figure —
 * before one of them becomes a 1970 `block_time` and a 1970 `sol_usd`
 * lookup.
 */
const MIN_UNIX_SECONDS = 1_500_000_000; // 2017-07-14
const MAX_UNIX_SECONDS = 4_102_444_800; // 2100-01-01

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
 * - `unsupported_quote`: three or more genuine legs, which no rule here can
 *   arbitrate between; or a stablecoin leg whose normalised value is under
 *   one lamport, so the only SOL left to price the swap with would be
 *   residue. The catch-all of the refusals, and deliberately the *narrowest*
 *   of them now that the two shapes below have names of their own.
 * - `unsupported_quote_no_rate`: a stablecoin-quoted swap at a block whose
 *   minute has no `sol_price` row, so §4.3's "normalised to SOL at the rate
 *   of that block" has no rate to normalise at. **Requeueable** (see
 *   `REQUEUEABLE_ERRORS`): unlike every other refusal here, the missing
 *   ingredient can still arrive.
 * - `unsupported_quote_token_token`: a two-leg swap where neither leg is
 *   SOL/WSOL or a stablecoin. Spec §4.3 asks for a close and an open at the
 *   implied SOL value; this project has no price for either mint *at the
 *   block* (only a mutable current one), and the unique index
 *   `(signature_hmac, instruction_index, wallet_id)` has nothing to
 *   distinguish the two rows with. Declined rather than half-written.
 * - `sol_leg_wrong_direction`: the SOL/WSOL leg moved the same way as the
 *   token leg (review round 1, finding 2) — e.g. a sell whose proceeds were
 *   more than eaten by a priority-fee tip, so the net SOL delta is still
 *   negative. Booking that as a positive `solAmount` would manufacture
 *   realized profit out of a loss, so it is rejected rather than guessed at.
 *   A stablecoin-quoted swap reaches the same check against the same
 *   quantity, since its normalised stable value is summed into the SOL side
 *   before the sign is looked at.
 */
export type SwapOutcome =
  | "trade"
  | "no_token_leg"
  | "dust_only"
  | "stable_rotation"
  | "no_sol_leg"
  | "unsupported_quote"
  | "unsupported_quote_no_rate"
  | "unsupported_quote_token_token"
  | "sol_leg_wrong_direction";

/** The outcomes that are recorded on the `raw_tx` row rather than passed over in silence. */
export type SwapParseError =
  | "unsupported_quote"
  | "unsupported_quote_no_rate"
  | "unsupported_quote_token_token"
  | "sol_leg_wrong_direction";

/**
 * The single mapping from an outcome to the `parse_error` it records, so the
 * set of silent-by-design outcomes is stated once and can be asserted
 * directly by tests instead of being re-derived at each call site.
 *
 * A `switch` rather than a boolean chain so the compiler narrows `outcome`
 * to `SwapParseError` on the way out: the name recorded on the row is the
 * outcome's own name, with no cast that a later renamed member could slip
 * through.
 */
export function parseErrorFor(outcome: SwapOutcome): SwapParseError | null {
  switch (outcome) {
    case "unsupported_quote":
    case "unsupported_quote_no_rate":
    case "unsupported_quote_token_token":
    case "sol_leg_wrong_direction":
      return outcome;
    default:
      return null;
  }
}

export type SwapEvaluation =
  | { outcome: "trade"; trade: ParsedTrade }
  | { outcome: Exclude<SwapOutcome, "trade"> };

type TokenLeg = { mint: string; raw: bigint; decimals: number };

/** Exact 10**n as a bigint. `n` must already have been through `requireDecimals`. */
function powTen(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Raised when the stored payload cannot be read at all — a raw amount that
 * is not an integer, a `rawTokenAmount` that is absent, an `accountData`
 * that is not an array. `parsePending` catches it and records
 * `parse_error = 'malformed_payload'` on the row.
 *
 * It has to be a distinct class rather than any thrown error: a database
 * failure inside the same loop must propagate, not poison the row it
 * happened to be working on.
 *
 * Before this existed, `BigInt("1.5")` threw a bare `SyntaxError` out of
 * `parsePending` with the row still `parsed_at NULL, parse_error NULL`. The
 * pending query orders by `received_at`, so that row was re-selected and
 * threw again on every later run — a permanent head-of-line stall with
 * every good delivery behind it unparsed and nothing recorded anywhere.
 */
export class MalformedPayloadError extends Error {
  constructor(field: string) {
    // Only the field's name goes in the message. A payload value can be an
    // address or a signature and must never reach a log line.
    super(`malformed enhanced transaction: ${field}`);
    this.name = "MalformedPayloadError";
  }
}

function requireArray<T>(value: readonly T[] | undefined | null, field: string): readonly T[] {
  if (!Array.isArray(value)) throw new MalformedPayloadError(field);
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object") throw new MalformedPayloadError(field);
  return value as Record<string, unknown>;
}

/**
 * A non-empty string field: a mint, an account, a fee payer, a signature.
 * `route.ts` only checks `!event?.signature`, so a numeric `signature`
 * (`12345`) is truthy there and reaches this parser; it then reached
 * `encrypt()` and threw a bare `TypeError` out of `parsePending`, leaving
 * the row `parsed_at NULL, parse_error NULL` and stalling every delivery
 * behind it.
 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new MalformedPayloadError(field);
  return value;
}

/**
 * Exclusive upper bound on the magnitude of a raw token amount. An SPL token
 * amount **is a u64** on chain, so this is the domain, not a heuristic.
 *
 * Without it, `requireRawAmount` bounded the number of digits at nothing —
 * the seventh instance of this file's one recurring defect, and the
 * worst-behaved of them. A 321-digit `tokenAmount` on a token leg and on a
 * WSOL leg both became `Infinity` at `Number()`, so `priceSol = Infinity /
 * Infinity = NaN`, and the row was written as
 * `trade{token_amount Infinity, sol_amount Infinity, price_sol NaN}` with
 * `position` marked dirty, `parsed_at` SET and `parse_error` NULL. Unlike
 * every other defect in this task it was **not requeueable**: nothing was
 * recorded, and the row was settled. (The token leg alone gave
 * `price_sol 0`.) An unbounded bigint forced into a double is the same
 * family as the six before it — two numbers of different kinds meeting.
 */
const MAX_RAW_AMOUNT = 2n ** 64n;

/**
 * A raw token amount as an exact integer. Helius reports base units as a
 * decimal string; anything that is not a whole number of base units is a
 * payload this parser cannot read, not a value to round.
 *
 * The number branch requires a **safe** integer, like every sibling guard
 * here: `12345678901234567890` as a JSON number is not one integer but a
 * double that silently stands for `12345678901234567000`, and accepting it
 * would re-round the amount without a word. The same digits as a *string*
 * are exact and under the u64 bound, so they are read as written — the
 * distinction is between a value JavaScript can carry exactly and one it
 * cannot.
 */
function requireRawAmount(value: unknown, field: string): bigint {
  let raw: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new MalformedPayloadError(field);
    raw = BigInt(value);
  } else {
    if (typeof value !== "string" || !/^[+-]?\d+$/.test(value)) throw new MalformedPayloadError(field);
    raw = BigInt(value);
  }
  if ((raw < 0n ? -raw : raw) >= MAX_RAW_AMOUNT) throw new MalformedPayloadError(field);
  return raw;
}

/**
 * A payload-reported lamports figure as an exact integer. Absent means zero
 * (the field is simply not reported for that account); anything present but
 * not a whole number of lamports is malformed rather than coerced, since
 * coercing it to 0 would turn an unreadable SOL leg into a silent
 * `no_sol_leg`.
 */
function requireLamports(value: unknown, field: string): bigint {
  if (value === undefined || value === null) return 0n;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new MalformedPayloadError(field);
  return BigInt(value);
}

/**
 * The transaction fee, in lamports. **Required**, unlike
 * `nativeBalanceChange`, and that asymmetry is the point: spec §4.4 makes
 * the fee material ("at the 0.25–3 SOL ticket sizes visible in the reference
 * data, fees are material") and Helius always sends it, so an absent `fee`
 * means this is not the payload shape the parser reads. An account with no
 * `nativeBalanceChange`, by contrast, legitimately means that account's
 * native balance did not move. Defaulting the fee to zero would silently
 * misreport the SOL side of every fee-payer trade in the row — an
 * unreadable field becoming a number, which is exactly what this file's
 * guards exist to prevent.
 */
function requireFee(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MalformedPayloadError("fee");
  }
  return BigInt(value);
}

/**
 * A mint's `decimals`: the **scale** every token quantity in this file is
 * divided by.
 *
 * This replaces `normalizeDecimals`, which mapped anything unreadable to `0`
 * while every neighbouring field raised. `decimals` is the last field that
 * turns unreadable payload data into a trade *number*, and reading a broken
 * one as zero is the same "two numbers of different kinds" defect that has
 * run through this whole file: `decimals: -3` (or `NaN`) on a 2,000,000-raw
 * leg wrote `tokenAmount 2000000, price_sol 5e-7` into `trade` and
 * `position` — a cost basis wrong by a factor of a million, on the number
 * the leaderboard ranks. There is no safe default for a scale: a payload
 * that cannot say what scale its number is in is a payload this parser
 * cannot read.
 *
 * Must be a non-negative integer no greater than `MAX_DECIMALS`. A negative,
 * fractional, `NaN`, absent or non-numeric value is malformed, and so is one
 * past the ceiling — `powTen` would otherwise be handed an absurd exponent.
 */
function requireDecimals(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_DECIMALS) {
    throw new MalformedPayloadError(field);
  }
  return value;
}

/**
 * A unix-seconds timestamp. Absent is **not** zero here: `new Date(undefined
 * * 1000)` is an Invalid Date, which Postgres rejects with `invalid input
 * syntax for type timestamp with time zone: "0NaN-NaN-NaN…"` from inside
 * `insertTrade`, past every guard, leaving the row `parsed_at NULL,
 * parse_error NULL` to be re-selected and to throw again forever. And
 * `null` is worse: it coerces to `0` and silently writes a 1970 trade.
 */
function requireUnixSeconds(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_UNIX_SECONDS ||
    value > MAX_UNIX_SECONDS
  ) {
    throw new MalformedPayloadError(field);
  }
  return value;
}

/**
 * The slot. Genuinely nullable (task decision 1: `trade.slot` is nullable
 * and the payload may not carry one), so absent means `null` — but present
 * and not a non-negative whole number is malformed, not coerced: Postgres
 * rejects a non-numeric slot on a `bigint` column, from inside `insertTrade`
 * and past every guard.
 */
function requireSlot(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MalformedPayloadError("slot");
  }
  return value;
}

/**
 * The transaction-level fields `insertTrade` writes onto every trade row.
 * Read once, and only when a trade is actually about to be written: a row
 * that produces no trade has no use for them, and a malformed one must not
 * cost a row that never reads it.
 */
export type TradeHeader = { signature: string; blockTime: Date; slot: number | null };

export function readTradeHeader(payload: EnhancedTx): TradeHeader {
  return {
    signature: requireString(payload?.signature, "signature"),
    blockTime: new Date(requireUnixSeconds(payload?.timestamp, "timestamp") * 1000),
    slot: requireSlot(payload?.slot),
  };
}

/** A validated SPL balance change: the only shape the arithmetic below reads. */
type BalanceChange = { mint: string; raw: bigint; decimals: number };

function readBalanceChange(record: Record<string, unknown>): BalanceChange {
  const amount = requireObject(record.rawTokenAmount, "tokenBalanceChange.rawTokenAmount");
  return {
    mint: requireString(record.mint, "tokenBalanceChange.mint"),
    raw: requireRawAmount(amount.tokenAmount, "rawTokenAmount.tokenAmount"),
    decimals: requireDecimals(amount.decimals, "rawTokenAmount.decimals"),
  };
}

/**
 * One `accountData` entry, read structurally. Nothing here raises: an
 * identity that cannot be read becomes `null`, and a container that is not
 * an array becomes `null`, for the caller to interpret against the wallet it
 * is evaluating.
 *
 * **An identity that cannot be read is not one of ours.** `""`, `null`, a
 * number — none of them can equal a tracked address, so an entry carrying
 * one is skipped rather than failing the whole row. Helius is documented to
 * emit `userAccount: ""` for token accounts it cannot attribute; treating
 * that as fatal would turn every delivery containing one into
 * `malformed_payload` and take the feed quiet with nothing reporting it.
 * This mirrors what already happens one level up for *values*: an unreadable
 * field on wallet B's leg records the error and still writes wallet A's
 * trade.
 *
 * The fail-closed behaviour is kept for exactly the case that earns it — an
 * entry that **demonstrably belongs** to the wallet being evaluated
 * (`account === address`). There, an unreadable `tokenBalanceChanges`, an
 * unreadable change, or an unreadable `userAccount` really could be hiding
 * that wallet's own leg, so the row is recorded and requeued instead of
 * quietly reporting less than the wallet did.
 */
type ChangeEntry = { userAccount: string | null; record: Record<string, unknown> | null };
type AccountEntry = {
  account: string | null;
  record: Record<string, unknown> | null;
  /** `null` when `tokenBalanceChanges` is not an array at all. */
  changes: ChangeEntry[] | null;
};

/** An address as an identity, or `null` if it cannot be read as one. Never raises. */
function readAddress(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The payload's `accountData`, read structurally. This is the single
 * traversal of the payload's shape: `candidateAddresses`,
 * `balanceChangesFor` and `nativeLamportsFor` all read through it, so there
 * is one place where an unreadable structure becomes either a skipped entry
 * or a typed error — never a `TypeError` escaping the caller.
 *
 * `accountData` itself must still be an array, and that one *is* fatal: a
 * payload with nothing readable there mentions no addresses at all, so
 * skipping it would settle the row as "touches no tracked wallet" — a
 * silent drop, and not requeueable.
 */
function accountEntries(payload: EnhancedTx): AccountEntry[] {
  const entries: AccountEntry[] = [];
  for (const account of requireArray((payload as EnhancedTx | undefined | null)?.accountData, "accountData")) {
    if (account === null || typeof account !== "object") {
      entries.push({ account: null, record: null, changes: null });
      continue;
    }
    const record = account as unknown as Record<string, unknown>;
    const rawChanges = record.tokenBalanceChanges;
    entries.push({
      account: readAddress(record.account),
      record,
      changes: Array.isArray(rawChanges)
        ? rawChanges.map((change) =>
            change === null || typeof change !== "object"
              ? { userAccount: null, record: null }
              : {
                  userAccount: readAddress((change as Record<string, unknown>).userAccount),
                  record: change as Record<string, unknown>,
                },
          )
        : null,
    });
  }
  return entries;
}

/**
 * Every SPL balance change the payload reports for `address`, validated.
 * Only this wallet's own changes are read, so a malformed `rawTokenAmount`,
 * `decimals` or `mint` on somebody else's leg cannot cost this wallet its
 * trade.
 *
 * **An unattributable non-zero balance change makes the row malformed
 * whenever this wallet has at least one attributable leg.** That rule is
 * deliberately blunt, and it is the second half of the `account` lesson
 * above. The SOL side of a trade is spread across two different keys: the
 * native leg is keyed off `account`, while the token and WSOL legs are keyed
 * off `userAccount` — and in the real ATA shape the WSOL leg sits on a
 * *separate* `accountData` entry whose `account` is the token account, not
 * the wallet. Skipping such an entry because its identity is unreadable
 * dropped the WSOL half and kept the native half:
 *
 *     truth                         token_amount 2, sol_amount 1,   price_sol 0.5
 *     userAccount unreadable (ATA)  token_amount 2, sol_amount 0.5, price_sol 0.25
 *                                   parse_error NULL, parsed_at SET, position dirty
 *
 * The token side has it too: half a token leg hidden gives `token_amount 1,
 * price_sol 1` against a truth of `0.5`. Both in the documented Helius
 * `userAccount: ""` shape — the very shape the leniency exists for. The
 * leniency bought availability and paid for it with a silently halved cost
 * basis on the most likely payload in production.
 *
 * A narrower rule (refuse only when the unattributable change is WSOL, or a
 * mint this wallet trades) was considered and rejected: every way of
 * stating it depends on knowing which mints the wallet trades, which is
 * exactly what the dropped change would have told us.
 *
 * What stays lenient, so the feed does not go quiet for nothing: an
 * unattributable change of **zero**, and a payload where this wallet has no
 * attributable leg *and* no net SOL movement — that row does not concern
 * it. A wallet with no readable leg but a real net SOL movement is a
 * different thing entirely, and `evaluateSwap` refuses it: the payload says
 * plainly that this wallet moved lamports, and a wallet the transaction
 * never touched has no such entry.
 *
 * An unreadable *container* (a `tokenBalanceChanges` that is not an array, a
 * change that is not an object, an `accountData` element that is not an
 * object) counts as unattributable too: it may hold a non-zero change, and
 * nothing in it can be shown to be zero. From the parser's side it is
 * indistinguishable from an unreadable ATA carrying this wallet's WSOL leg.
 */
type WalletChanges = {
  changes: BalanceChange[];
  /**
   * Whether the payload carries a non-zero balance change this parser could
   * not attribute to anyone. Returned rather than acted on here, because
   * what it means depends on what else this wallet has: with a leg of its
   * own it is refused immediately below; with no leg but a real native
   * movement it is refused in `evaluateSwap`; with neither, it is nobody's
   * business.
   */
  unattributable: boolean;
};

function balanceChangesFor(payload: EnhancedTx, address: string): WalletChanges {
  const changes: BalanceChange[] = [];
  let unattributable = false;

  for (const account of accountEntries(payload)) {
    const isOurs = account.account === address;
    if (account.changes === null) {
      if (isOurs) throw new MalformedPayloadError("tokenBalanceChanges");
      unattributable = true; // may hold a non-zero change we cannot see
      continue;
    }
    for (const change of account.changes) {
      if (change.record === null) {
        if (isOurs) throw new MalformedPayloadError("tokenBalanceChange");
        unattributable = true;
        continue;
      }
      if (change.userAccount === null) {
        if (isOurs) throw new MalformedPayloadError("tokenBalanceChange.userAccount");
        // Readable amount, unreadable owner: only a zero change is harmless,
        // since a zero moves no side of any trade. An unreadable amount
        // cannot be shown to be zero, so it counts as non-zero.
        if (unattributableIsNonZero(change.record)) unattributable = true;
        continue;
      }
      if (change.userAccount !== address) continue;
      changes.push(readBalanceChange(change.record));
    }
  }

  // "At least one attributable leg" is what makes the dropped change this
  // wallet's problem: with no leg of its own, the transaction does not
  // concern it and nothing is being reported short.
  if (changes.length > 0 && unattributable) {
    throw new MalformedPayloadError("tokenBalanceChange.userAccount");
  }
  return { changes, unattributable };
}

/**
 * Whether an unattributable change moved anything. Read defensively — this
 * change belongs to nobody we can name, so an unreadable amount here must
 * not raise on its own account; it is simply not provably zero.
 */
function unattributableIsNonZero(record: Record<string, unknown>): boolean {
  const amount = record.rawTokenAmount;
  if (amount === null || typeof amount !== "object") return true;
  const raw = (amount as Record<string, unknown>).tokenAmount;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string" || !/^[+-]?\d+$/.test(raw)) return true;
  return BigInt(raw) !== 0n;
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
 * Every non-zero SPL token leg in a validated set of balance changes,
 * excluding WSOL. Multiple token accounts of the same mint are summed
 * together — after being brought to a common scale, since two balance
 * changes of one mint that report different decimals are not addable as
 * they stand.
 */
function tokenLegsIn(changes: readonly BalanceChange[]): TokenLeg[] {
  const byMint = new Map<string, { raw: bigint; decimals: number }>();
  for (const change of changes) {
    const existing = byMint.get(change.mint);
    if (!existing) {
      byMint.set(change.mint, { raw: change.raw, decimals: change.decimals });
      continue;
    }
    // Scale both to the finer of the two before adding: 1 raw unit at 6
    // decimals and 1 raw unit at 9 decimals are different quantities of
    // the same token, and summing them as they stand would overstate the
    // coarser one by 1000x.
    const scale = Math.max(existing.decimals, change.decimals);
    byMint.set(change.mint, {
      raw: existing.raw * powTen(scale - existing.decimals) + change.raw * powTen(scale - change.decimals),
      decimals: scale,
    });
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

/** The net WSOL balance change in a validated set of changes, **in lamports**, 0n if none. */
function wsolLamportsIn(changes: readonly BalanceChange[]): bigint {
  let total = 0n;
  for (const change of changes) {
    if (change.mint === WSOL_MINT) total += toLamports(change.raw, change.decimals);
  }
  return total;
}

/**
 * This wallet's net native balance change, **in lamports**, 0n if the
 * payload has no entry for it. Only this wallet's own entries are read: an
 * unreadable `nativeBalanceChange` on another account is not this wallet's
 * problem. Absent on this wallet's own entry *is* zero — an account whose
 * native balance did not move is a normal thing for a payload to say — but
 * present and not a whole number of lamports is malformed rather than
 * coerced, since coercing it to 0 would turn an unreadable SOL leg into a
 * silent `no_sol_leg`.
 */
function nativeLamportsFor(payload: EnhancedTx, address: string): bigint {
  let total = 0n;
  for (const account of accountEntries(payload)) {
    if (account.record === null) continue; // not an object: no native field to read at all

    if (account.account === null) {
      // An unattributable entry that moved no lamports costs nothing, so it
      // stays skipped — the documented Helius `userAccount: ""` shape and
      // ordinary pool entries are unaffected. But lamports that *did* move
      // belong to somebody, and this is the one field that says whom, so an
      // unreadable `account` over a non-zero `nativeBalanceChange` is fatal.
      //
      // Without this, the leniency dropped half of one wallet's SOL side and
      // kept the other: the native leg is keyed off `account`, while the
      // token and WSOL legs are keyed off `userAccount`. A wallet buying 2
      // tokens with 0.5 SOL through a standing WSOL account plus 0.5 SOL
      // natively, with its own entry's `account` unreadable, was written as
      // `buy tok=2 sol=0.499995 price_sol=0.2499975` against a truth of
      // `sol=1 price_sol=0.5` — right direction, plausible magnitude,
      // `parse_error` NULL, `parsed_at` SET. A cost basis wrong by 2x, in
      // silence, on the number the leaderboard ranks.
      //
      // A present-but-unreadable `nativeBalanceChange` raises through
      // `requireLamports` for the same reason: it cannot be shown to be zero.
      if (requireLamports(account.record.nativeBalanceChange, "nativeBalanceChange") !== 0n) {
        throw new MalformedPayloadError("accountData[].account");
      }
      continue;
    }

    if (account.account === address) {
      total += requireLamports(account.record.nativeBalanceChange, "nativeBalanceChange");
    }
  }
  return total;
}

/**
 * This wallet's net SOL/WSOL movement, in lamports, and the fee terms behind
 * it. Spec §4.3 treats SOL and WSOL as one quantity, so both are summed
 * here; spec §4.4's fee is added back for the fee payer, whose
 * `nativeBalanceChange` already contains it.
 *
 * Factored out because `evaluateSwap` needs the same number in two places:
 * once to price a trade, and once — the branch below — to decide whether a
 * wallet with no readable token leg was nevertheless doing something.
 *
 * Every read here can refuse, so it is reached only once this wallet is
 * known to be involved: it has a token leg, or (via `readableNativeFor`) its
 * own lamports demonstrably moved. The order is `feePayer` -> `fee` ->
 * `nativeBalanceChange`, and it is load-bearing for which field a malformed
 * payload is reported against.
 */
function solSideFor(
  payload: EnhancedTx,
  address: string,
  changes: readonly BalanceChange[],
): { isFeePayer: boolean; fee: bigint; solDelta: bigint } {
  // `feePayer` is required as a string rather than compared loosely — an
  // absent or non-string one would silently make every wallet a
  // non-fee-payer and drop the fee out of the §4.4 arithmetic without a word.
  const isFeePayer = address === requireString(payload?.feePayer, "feePayer");
  const fee = requireFee(payload?.fee);
  const feeAdjustedNative = isFeePayer ? nativeLamportsFor(payload, address) + fee : nativeLamportsFor(payload, address);
  // Both terms are lamports by construction.
  return { isFeePayer, fee, solDelta: feeAdjustedNative + wsolLamportsIn(changes) };
}

/**
 * This wallet's own native movement, read **leniently**: an unreadable value
 * is "not known to have moved", never an error, and no other account's entry
 * is consulted.
 *
 * It exists only as the *trigger* for the no-token-leg refusal in
 * `evaluateSwap`. Reading the strict `nativeLamportsFor` there — or the fee
 * terms, which need it — would make a genuinely uninvolved wallet raise on a
 * field it has no business reading: measured, a payload with no leg, an
 * unattributable change and no SOL movement of this wallet's own was refused
 * for an absent `feePayer`, an absent `fee`, its own unreadable
 * `nativeBalanceChange`, and a *third party's* unreadable `account` over 1
 * SOL. Fail-closed and requeueable, but wrong: nothing on that path is this
 * wallet's problem.
 *
 * So the order matters. Establish, without raising, that this wallet's own
 * lamports moved; only then read the fields that price the movement, which
 * may legitimately refuse.
 */
function readableNativeFor(payload: EnhancedTx, address: string): bigint {
  let total = 0n;
  for (const account of accountEntries(payload)) {
    if (account.record === null || account.account !== address) continue;
    const value = account.record.nativeBalanceChange;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) continue;
    total += BigInt(value);
  }
  return total;
}

/**
 * A stablecoin leg's value **in lamports**, at a SOL/USD rate.
 *
 * Spec §4.3: a USDC-quoted swap is "normalised to SOL at the `sol_usd` rate
 * of that block". USDC *is* the unit `sol_usd` is quoted in — `prices.ts`
 * reads it from the solana SOL/**USDC** pair specifically, filtered to that
 * quote before ranking — so `raw / 10**decimals` is a USD figure by
 * construction, not by an assumption about the peg holding.
 *
 * One exact integer division, not three. `raw / 10**d` USD, divided by
 * `solUsd / ONE` SOL-per-USD, times `LAMPORTS_PER_SOL`, is
 * `raw * ONE * LAMPORTS_PER_SOL / (10**d * solUsd)` — and doing it as one
 * division is what keeps this off the "two numbers of different kinds" list
 * in the header. Dividing step by step would truncate a 6-decimal USDC
 * amount to whole USD before it ever reached the rate.
 *
 * BigInt division truncates toward zero, so the magnitude only ever rounds
 * *down*, symmetrically for a buy and a sell. `solUsd` is required positive
 * by the caller; `decimals` has already been through `requireDecimals`.
 */
function stableLamportsFor(leg: TokenLeg, solUsd: bigint): bigint {
  return (leg.raw * ONE * LAMPORTS_PER_SOL) / (powTen(leg.decimals) * solUsd);
}

/**
 * The last step of every trade: one token leg against a SOL side, in
 * lamports, with the direction check between them.
 *
 * `quoteLamports` is the part of the SOL side that the payload did not state
 * natively — `0n` for a SOL-quoted swap, and a stablecoin leg's normalised
 * value for a stablecoin-quoted one. It is **summed** with the wallet's real
 * native+WSOL delta rather than replacing it, for two reasons. Spec §4.4
 * makes the SOL side the wallet's actual net delta, which is why an ATA rent
 * payment is already part of a SOL-quoted trade's cost (the persistent-WSOL
 * buy that sums to 1.00203928). And a wallet that paid partly in SOL and
 * partly in USDC has both halves in the payload: taking only the stable one
 * would halve the cost basis exactly the way the header's monotonicity note
 * describes, with every check below still agreeing.
 *
 * Because the sum happens before the sign is looked at, a stablecoin-quoted
 * swap gets the identical `no_sol_leg` and `sol_leg_wrong_direction` rules a
 * SOL-quoted one does, against the identical quantity. There is no second
 * copy of the direction rule to drift.
 */
function settleTrade(
  payload: EnhancedTx,
  address: string,
  changes: readonly BalanceChange[],
  leg: TokenLeg,
  quoteLamports: bigint,
): SwapEvaluation {
  const { mint, raw, decimals } = leg;
  const side: "buy" | "sell" = raw > 0n ? "buy" : "sell";
  const tokenAmount = Number(raw < 0n ? -raw : raw) / 10 ** decimals;

  // Read at the point of use, once this wallet is known to have a leg: a
  // wallet with no leg and no lamport movement of its own never touches
  // these, so a malformed one cannot cost it anything. Order on this path is
  // `feePayer` -> `fee` -> `nativeBalanceChange`, unchanged since the fields
  // were first guarded.
  const { isFeePayer, fee, solDelta } = solSideFor(payload, address, changes);

  // Both terms are lamports by construction: `solDelta` from
  // `nativeLamportsFor`/`toLamports`, `quoteLamports` from
  // `stableLamportsFor`.
  const solSide = solDelta + quoteLamports;

  if (solSide === 0n) return { outcome: "no_sol_leg" };

  const wrongDirection = side === "buy" ? solSide > 0n : solSide < 0n;
  if (wrongDirection) return { outcome: "sol_leg_wrong_direction" };

  return {
    outcome: "trade",
    trade: {
      mint,
      side,
      tokenAmount,
      solAmount: Number(solSide < 0n ? -solSide : solSide) / 1e9,
      feeSol: isFeePayer ? Number(fee) / 1e9 : 0,
      // **Always 0, and measured rather than assumed.** The unique index is
      // (signature_hmac, instruction_index, wallet_id), so a constant here is
      // only safe if one wallet can produce at most one trade per transaction.
      // It can, for two independent reasons.
      //
      // First, the payload has no per-instruction detail to index by. Measured
      // against six real mainnet enhanced transactions (four `SWAP`, from
      // `JUPITER` and `PUMP_AMM`): `accountData` carries one entry per unique
      // account address, and each entry's `tokenBalanceChanges` carries one
      // change per (token account, mint). In one `PUMP_AMM` swap a token
      // account touched by *four* separate `tokenTransfers` produced exactly
      // one balance-change entry whose raw value was the exact net of those
      // four (-228412 at 9 decimals, against a transfer net of -0.000228412);
      // a `JUPITER` swap did the same for four transfers (-90326) and for two
      // (9307). `instructions[]` exists but carries only `accounts`, base58
      // `data`, `programId` and `innerInstructions` — no amounts, and no link
      // from a balance change to an instruction. `tokenTransfers` and
      // `nativeTransfers` carry no index either, and `events.swap` is one
      // object for the whole transaction. (The one Helius surface that does
      // carry `instructionIdx` is `getTransfersByAddress`, a different RPC
      // endpoint, not the enhanced payload this project ingests.) A derived
      // index would therefore be invented, and an invented index that looks
      // authoritative is worse than an honest constant.
      //
      // Second, nothing upstream can call this twice for one wallet.
      // `evaluateSwap` returns a single evaluation, and `parsePending`
      // resolves a deduplicated address set against a UNIQUE `address_hmac`,
      // so `insertTrade` runs at most once per (wallet, transaction). The
      // (kol_id, mint) fan-out of a multi-wallet transaction is safe for the
      // same reason it always was: `wallet_id` differs per wallet.
      //
      // The stablecoin-quoted path added by task 7 keeps both reasons intact:
      // it produces one trade, on the token leg, with the stable leg folded
      // into that trade's SOL side. A token↔token swap is the one shape that
      // would need two rows for one wallet, and it is exactly the shape that
      // stays declined — `unsupported_quote_token_token` — rather than being
      // given a second, invented index to be stored under. Had it been
      // written, `ON CONFLICT (signature_hmac, instruction_index, wallet_id)
      // DO NOTHING` would have swallowed the second row in silence.
      //
      // What this does *not* fix, because no index could: Helius nets a buy
      // and a sell of one mint in the same transaction before delivery, so a
      // round trip arrives as a single net token amount (exactly zero for a
      // full one, which lands as `no_token_leg`) and the realized leg is
      // invisible. See the `two swaps of one mint in one transaction` block in
      // the tests, which pins both halves.
      instructionIndex: 0,
    },
  };
}

/**
 * Evaluates one wallet's role in a Helius enhanced transaction. This is the
 * single source of truth for the swap arithmetic; `parseSwap` below is a thin
 * projection of it onto its historical `ParsedTrade | null` contract.
 *
 * **`solUsd` is the block's own rate, or `null`.** Scaled 18 decimals, as
 * `decimal.ts` defines it. It is a parameter rather than a lookup because
 * this function is synchronous, total and pure, and every test in the suite
 * depends on it staying that way. The contract on the caller is precise: pass
 * the rate `prices.ts`'s `solUsdForMinute` returns for this transaction's
 * *containing* minute, or `null`. Passing `solUsdAt`'s answer instead would
 * satisfy the type and silently build cost bases out of a rate from another
 * minute. `parsePending` reads it only once a first, rate-free evaluation has
 * said the row actually contains a stablecoin-quoted swap for this wallet,
 * which is what keeps the header read (and its `MalformedPayloadError`) off
 * rows that never needed it.
 *
 * A `null`, zero or negative rate is not a rate: the swap is declined as
 * `unsupported_quote_no_rate`, never valued at some default.
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
  solUsd: bigint | null = null,
): SwapEvaluation {
  const { changes, unattributable } = balanceChangesFor(payload, wallet.address);
  const allLegs = tokenLegsIn(changes);
  const legs = dropDust(allLegs);
  if (legs.length === 0) {
    if (allLegs.length > 0) return { outcome: "dust_only" };

    // No readable token leg. That is silent by design — but only because it
    // normally means the transaction does not concern this wallet. When the
    // payload also carries an unattributable non-zero change, the two
    // possibilities are not the same thing at all, and the payload says
    // which is which: a wallet the transaction never touched has no entry
    // moving its lamports. So a real net SOL movement here (after the §4.4
    // fee) plus a change nobody could be attributed to is a trade whose
    // token side may simply have been the part we could not read, and it is
    // refused rather than passed over.
    //
    // Measured before this branch existed: own entry readable,
    // `nativeBalanceChange -1_000_005_000`, fee 5,000, fee payer, plus one
    // unattributable non-zero change on an ATA -> `no_token_leg`, silent,
    // `parsed_at` SET. The payload states outright that this wallet moved a
    // net 1 SOL after fees.
    //
    // All three conditions are required. No unattributable change, or no
    // native movement, and the wallet is genuinely uninvolved — the ordinary
    // case, still silent. The false positive left is a tracked wallet's
    // plain SOL transfer sharing a delivery with an unattributable change;
    // the webhook is filtered to SWAP, so that shape should barely exist,
    // and a refusal is recorded and requeueable where a dropped trade is
    // neither.
    // Native first, leniently, and the fee terms only once it is non-zero:
    // a wallet whose own lamports did not move is uninvolved, and must not
    // be made to raise on a `feePayer`, a `fee`, or a third party's
    // `account` that it never needed. Once its lamports have moved, the
    // strict read decides whether anything is left after the §4.4 fee — a
    // wallet that only paid gas nets to zero and stays silent.
    if (unattributable && readableNativeFor(payload, wallet.address) + wsolLamportsIn(changes) !== 0n) {
      if (solSideFor(payload, wallet.address, changes).solDelta !== 0n) {
        throw new MalformedPayloadError("tokenBalanceChange.userAccount");
      }
    }
    return { outcome: "no_token_leg" };
  }
  // Three or more genuine legs: no rule here can say which pair of them is
  // the swap, and the parser has no price data to arbitrate with. Refused,
  // exactly as it was before task 7 — nothing below widens this.
  if (legs.length > 2) return { outcome: "unsupported_quote" };

  if (legs.length === 2) {
    // Spec §4.3's two remaining quote shapes, told apart by one question:
    // is one of the legs the stablecoin `sol_usd` is quoted in?
    const stableIndex = legs.findIndex((leg) => leg.mint === USDC_MINT);

    // Neither leg is SOL/WSOL (those never reach `tokenLegsIn`) nor the
    // stablecoin. §4.3 would close leg A and open leg B at the implied SOL
    // value; see the file header for the two independent reasons that cannot
    // be done honestly here — no price for either mint *at the block*, and no
    // second index to store the second row under. Declined with its own name
    // so it can be counted, rather than folded into the catch-all.
    if (stableIndex === -1) return { outcome: "unsupported_quote_token_token" };

    const stable = legs[stableIndex];
    const token = legs[1 - stableIndex];

    // No rate for this block's own minute, or a rate that is not a positive
    // number: §4.3's normalisation has nothing to normalise at. Never a
    // default, never the last rate that happened to be lying around.
    if (solUsd === null || solUsd <= 0n) return { outcome: "unsupported_quote_no_rate" };

    const stableLamports = stableLamportsFor(stable, solUsd);

    // The stable leg is worth less than one lamport, so normalising it gives
    // nothing and the SOL side would be whatever native residue the payload
    // happens to carry — ATA rent, a tip. That is the exact fabrication
    // review round 2 removed (`price_sol` off 0.00203928 of rent), reached
    // through a different door, so it is refused rather than settled.
    // Unreachable at any real SOL price: the dust floor already puts the
    // smallest surviving USDC leg at 2/1,000,000 USDC, which is 8 lamports at
    // a few hundred dollars a SOL. It is cheap, and it is the door.
    if (stableLamports === 0n) return { outcome: "unsupported_quote" };

    return settleTrade(payload, wallet.address, changes, token, stableLamports);
  }

  const sole = legs[0];
  // spec §4.3: a SOL <-> stablecoin rotation is not a trade and is not
  // indexed. Checked on the *sole* leg only — a stablecoin leg with a token
  // leg beside it is a quote, handled above, not a rotation.
  if (sole.mint === USDC_MINT) return { outcome: "stable_rotation" };

  return settleTrade(payload, wallet.address, changes, sole, 0n);
}

/**
 * Reads one wallet's leg of a swap. A thin projection of `evaluateSwap` onto
 * its historical `ParsedTrade | null` contract — see there for the full
 * classification.
 *
 * It takes the optional rate for the same reason `evaluateSwap` does, and
 * with the same contract: the block's *containing* minute or nothing.
 * Omitting it collapses every stablecoin-quoted swap to `null`, which is a
 * silent drop — which is why `parsePending` does not go through this function
 * and nothing that records outcomes should.
 */
export function parseSwap(
  payload: EnhancedTx,
  wallet: { id: string; kolId: string; address: string },
  solUsd: bigint | null = null,
): ParsedTrade | null {
  const result = evaluateSwap(payload, wallet, solUsd);
  return result.outcome === "trade" ? result.trade : null;
}

/**
 * Every address this transaction mentions, as a candidate wallet to resolve.
 * Reads identities only — no value in the payload is touched here, so a
 * malformed leg cannot stop the row's tracked wallets from being found.
 */
function candidateAddresses(payload: EnhancedTx): string[] {
  const addresses = new Set<string>();
  for (const account of accountEntries(payload)) {
    if (account.account !== null) addresses.add(account.account);
    for (const change of account.changes ?? []) {
      if (change.userAccount !== null) addresses.add(change.userAccount);
    }
  }
  return [...addresses];
}

/**
 * Writes one trade row. Takes an already-validated `TradeHeader` rather than
 * the payload: `signature`, `timestamp` and `slot` used to be read straight
 * off the payload here, past every guard in this file, and a missing or
 * non-numeric one threw out of `parsePending` from inside Postgres with the
 * row left `parsed_at NULL, parse_error NULL` — the same permanent stall,
 * one door over, and reached only by rows that hold a real trade for a
 * tracked wallet.
 *
 * **The USD side, and the two things it must never do.** The rate comes from
 * `solUsdAt` — the one place that lookup is written — and the arithmetic from
 * `valueTrade`, on the exact 18-decimal grid.
 *
 * 1. When `solUsdAt` returns `null` there is no rate, and `usd_amount`,
 *    `sol_usd` and `price_usd` are all written NULL. **Never `0`.** A zero is
 *    a number the leaderboard sums and the feed renders; it is
 *    indistinguishable from a trade that really was worth nothing, and spec
 *    §4.1's honest gap (an unpriced buy understates `costUsd` while a priced
 *    sell still removes a share of it, so `realized_usd` is *overstated*)
 *    would become invisible instead of merely known. `priced_at` is stamped
 *    on both paths, which is what keeps "we looked and there was no rate"
 *    distinguishable from "nothing has ever looked at this row" — the
 *    distinction `scripts/backfill-prices.ts` reports on.
 * 2. Nothing on this path goes through a double. `Number(rate.usd)` and
 *    `solAmount * solUsd` were the previous implementation and they wrote
 *    values like `23.170000000000002` into a `numeric` column.
 *
 * `token_amount`, `sol_amount` and `fee_sol` are still `number`s on
 * `ParsedTrade`, which is batch 1's shape and is not this task's to change;
 * they are converted here, once, at the boundary, so at least nothing
 * *downstream* of this write compounds them.
 */
async function insertTrade(
  signatureHmac: Buffer,
  header: TradeHeader,
  wallet: WalletRow,
  trade: ParsedTrade,
): Promise<void> {
  const id = crypto.randomUUID();
  const signatureEnc = encrypt(header.signature, aadFor("trade", "signature", id));
  const blockTime = header.blockTime;

  const tokenAmount = parseDecimal(String(trade.tokenAmount));
  const solAmount = parseDecimal(String(trade.solAmount));
  // `evaluateSwap`'s dust floor keeps `tokenAmount` above 1e-6 of a token, so
  // a zero here is unreachable — but `mulDiv` throws on a zero divisor and an
  // uncaught throw out of `parsePending` is the permanent head-of-line stall
  // this whole file is written against. A row with no per-token price is a
  // recorded, readable trade; a stalled queue is not.
  const priceSol = tokenAmount === 0n ? null : mulDiv(solAmount, ONE, tokenAmount);

  const rate = await solUsdAt(blockTime);
  const valued = rate === null ? null : valueTrade(solAmount, priceSol, rate);

  // Both writes or neither. The trade is the source of truth and the dirty
  // mark is the only thing that will ever cause it to be read: a crash
  // between them leaves a trade that no replay is ever told to look at, so
  // the position it belongs to silently stops matching its own trade log.
  // Nothing recovers that on its own, because the recovery is driven by the
  // flag that went missing.
  await withTransaction(async (tx) => {
    await tx(
      `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                          mint, side, token_amount, sol_amount, usd_amount, sol_usd, price_sol,
                          price_usd, fee_sol, block_time, slot, priced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
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
        formatDecimal(tokenAmount),
        formatDecimal(solAmount),
        valued?.usdAmount ?? null,
        valued?.solUsd ?? null,
        priceSol === null ? null : formatDecimal(priceSol),
        valued?.priceUsd ?? null,
        trade.feeSol,
        blockTime,
        header.slot,
      ],
    );

    await tx(
      `INSERT INTO position (kol_id, mint, dirty) VALUES ($1, $2, TRUE)
       ON CONFLICT (kol_id, mint) DO UPDATE SET dirty = TRUE`,
      [wallet.kol_id, trade.mint],
    );
  });
}

/** What can end up in `raw_tx.parse_error`: a swap outcome, or an unreadable payload. */
export type RowParseError = SwapParseError | "malformed_payload";

/**
 * Priority used when two different tracked wallets in the same transaction
 * hit two different non-trade outcomes.
 *
 * **Every requeueable error outranks every settled one**, which is the rule
 * the ordering below is derived from rather than a coincidence of it. A
 * requeueable error losing to a settled one would stamp `parsed_at` on a row
 * whose missing ingredient can still arrive, dropping that wallet's leg for
 * good. So `malformed_payload` (a parser fix can read it later) and
 * `unsupported_quote_no_rate` (a `sol_price` row for that minute can still
 * land) take the top two places, in that order — an unreadable payload is the
 * stronger statement, since the row cannot even be classified.
 *
 * Below them, among the settled refusals: a wrong-direction leg outranks the
 * unsupported quotes, being a rejected trade with real money on it, and
 * `unsupported_quote_token_token` outranks the bare `unsupported_quote`
 * because it names a specific shape where the catch-all names none.
 */
const ERROR_PRIORITY: Record<RowParseError, number> = {
  malformed_payload: 5,
  unsupported_quote_no_rate: 4,
  sol_leg_wrong_direction: 3,
  unsupported_quote_token_token: 2,
  unsupported_quote: 1,
};

/**
 * The errors that leave `parsed_at` NULL, so a later fix can reprocess the
 * row without spending another Helius credit (spec §5.2). Clearing
 * `parse_error` is what actually requeues a row — the pending query filters
 * on `parse_error IS NULL` — so this set is about honesty in the column
 * rather than about the loop: a row marked `parsed_at` says the parser is
 * finished with it, and for these two that is not true.
 *
 * - `malformed_payload`: a parser fix may be able to read it.
 * - `unsupported_quote_no_rate`: nothing about the payload is wrong. The
 *   `sol_price` row for its minute simply did not exist when it was read,
 *   and one can still arrive — from a per-minute series (spec §5.7) or a
 *   historical import. Settling it would throw a readable, valuable swap
 *   away over a table's contents at one moment.
 *
 * Everything else is a decision about the payload itself, which no later
 * data changes.
 */
const REQUEUEABLE_ERRORS: ReadonlySet<RowParseError> = new Set<RowParseError>([
  "malformed_payload",
  "unsupported_quote_no_rate",
]);

function higherPriorityError(a: RowParseError | null, b: RowParseError): RowParseError {
  if (a === null) return b;
  return ERROR_PRIORITY[a] >= ERROR_PRIORITY[b] ? a : b;
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
 * A genuine parse failure records `parse_error = 'malformed_payload'` but
 * leaves `parsed_at` null, so the row stays eligible for a
 * parser fix to reprocess without spending another Helius credit (spec
 * §5.2). That covers both an undecryptable ciphertext or unparseable JSON
 * and a payload that decrypts cleanly but cannot be read field by field
 * (`MalformedPayloadError`) — the latter used to escape this function
 * entirely and stall the queue behind it forever.
 *
 * That reading happens **per wallet**, not once over the whole payload: a
 * malformed field is recorded against the row only if some tracked wallet
 * actually had to read it. A wallet whose own leg is unreadable is skipped
 * and the row is marked `malformed_payload`, while any other tracked
 * wallet in the same transaction still gets its trade — and the reparse
 * that follows a parser fix will not duplicate it, since the trade insert
 * is `ON CONFLICT DO NOTHING`.
 * `unsupported_quote`, `unsupported_quote_token_token` and
 * `sol_leg_wrong_direction` are the opposite: all three are cases this parser
 * deliberately never guesses at, not bugs a future deploy might fix on retry,
 * so they also set `parsed_at`. `unsupported_quote_no_rate` sits with
 * `malformed_payload` instead and leaves `parsed_at` null, because the thing
 * it is waiting for is a row in `sol_price`, not a code change — see
 * `REQUEUEABLE_ERRORS`. Either way, the pending-rows query below excludes
 * any row with `parse_error` set,
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

    let rowError: RowParseError | null = null;
    let addresses: string[];
    try {
      // Identity only — enough to know whose leg is whose. Every value is
      // read per wallet below, at the point of use, so a malformed field on
      // an account belonging to no tracked wallet cannot cost a tracked
      // wallet its trade.
      addresses = candidateAddresses(payload);
    } catch (error) {
      if (!(error instanceof MalformedPayloadError)) throw error;
      // Never log the field's value, only that the row could not be read.
      console.warn("parsePending: a raw_tx payload is structurally unreadable");
      // parse_error set, parsed_at left NULL: the pending query filters on
      // `parse_error IS NULL`, so the row stops being re-selected (it can no
      // longer stall every delivery behind it) while still being requeued by
      // a later parser fix that clears parse_error.
      await query(`UPDATE raw_tx SET parse_error = $2 WHERE signature_hmac = $1`, [
        row.signature_hmac,
        "malformed_payload",
      ]);
      continue;
    }

    // Read once, lazily, and only if some wallet actually produces a trade.
    // The header is transaction-level: if it reads for one wallet it reads
    // for every wallet in the row, so no trade is ever written against a
    // header that a later wallet would have found unreadable.
    let header: TradeHeader | null = null;

    for (const address of addresses) {
      const walletRow = await findWalletByAddress(address);
      if (!walletRow || walletRow.status !== "active") continue; // spec §9: withdrawal stops indexing

      const wallet = { id: walletRow.id, kolId: walletRow.kol_id, address };
      let result: SwapEvaluation;
      try {
        // Two passes, and only for the one shape that needs a second.
        //
        // `evaluateSwap` is synchronous and pure, and the SOL/USD rate a
        // stablecoin-quoted swap normalises at lives in Postgres, keyed by the
        // block time — which is in the transaction *header*, behind a
        // `readTradeHeader` that raises on an unreadable `timestamp`,
        // `signature` or `slot`. Reading the header up front to break that
        // circle would make an unreadable one fatal for rows that never
        // needed it: today a payload with a broken header that produces no
        // trade for any tracked wallet is parsed without complaint, and it
        // must stay that way.
        //
        // So: classify first with no rate at all. `unsupported_quote_no_rate`
        // is precisely the answer "this is a stablecoin-quoted swap for this
        // wallet and I was given no rate" — the only outcome that a rate can
        // change — and only then is the header worth reading and the rate
        // worth a round trip. Re-evaluating is free of side effects because
        // the function is pure, and the second pass is skipped entirely when
        // the lookup comes back empty, so the refusal is preserved verbatim.
        result = evaluateSwap(payload, wallet);
        if (result.outcome === "unsupported_quote_no_rate") {
          header ??= readTradeHeader(payload);
          // `solUsdForMinute`, never `solUsdAt`: the containing minute's own
          // row, or nothing. See its doc comment for why a cost basis may not
          // be built from the `<=` lookup that `usd_amount` uses.
          const solUsd = await solUsdForMinute(header.blockTime);
          if (solUsd !== null) result = evaluateSwap(payload, wallet, solUsd);
        }
        if (result.outcome === "trade") header ??= readTradeHeader(payload);
      } catch (error) {
        // Only an unreadable payload is recorded. A database failure raised
        // anywhere in this loop must propagate: swallowing it would turn a
        // transient outage into a permanent `malformed_payload` on an
        // innocent row.
        if (!(error instanceof MalformedPayloadError)) throw error;
        // Never log the field's value: it can be an address or a signature.
        console.warn("parsePending: a tracked wallet's leg of a raw_tx payload is unreadable");
        rowError = higherPriorityError(rowError, "malformed_payload");
        continue;
      }

      if (result.outcome === "trade" && header) {
        await insertTrade(row.signature_hmac, header, walletRow, result.trade);
        continue;
      }
      const error = parseErrorFor(result.outcome);
      if (error) rowError = higherPriorityError(rowError, error);
    }

    if (rowError !== null && REQUEUEABLE_ERRORS.has(rowError)) {
      // Requeueable: parse_error set so the row stops being re-selected and
      // cannot stall the queue, parsed_at left NULL so clearing parse_error
      // after a parser fix — or after a `sol_price` row for the missing
      // minute arrives — reprocesses it without spending another Helius
      // credit (spec §5.2). A trade already written for another wallet in
      // the same row survives that reparse untouched — the insert is
      // ON CONFLICT DO NOTHING.
      await query(`UPDATE raw_tx SET parse_error = $2 WHERE signature_hmac = $1`, [
        row.signature_hmac,
        rowError,
      ]);
      continue;
    }

    await query(`UPDATE raw_tx SET parsed_at = now(), parse_error = $2 WHERE signature_hmac = $1`, [
      row.signature_hmac,
      rowError,
    ]);
  }

  return rows.length;
}

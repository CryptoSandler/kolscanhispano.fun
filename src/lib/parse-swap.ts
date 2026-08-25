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
 * The one exception is *identity*: `accountData` must be an array of
 * objects, each with a string `account`, whose `tokenBalanceChanges` is an
 * array of objects each with a string `userAccount`. Those are the fields
 * that decide *whose* leg a value belongs to, so an unreadable one may be
 * hiding the tracked wallet's own leg; failing the row closed is the only
 * answer there that cannot silently drop a trade. Values (`fee`,
 * `nativeBalanceChange`, `rawTokenAmount`, `decimals`, `mint`, `feePayer`)
 * are read only for the wallet under evaluation, and the transaction header
 * (`signature`, `timestamp`, `slot`) only when a trade is about to be
 * written.
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
 * A raw token amount as an exact integer. Helius reports base units as a
 * decimal string; anything that is not a whole number of base units is a
 * payload this parser cannot read, not a value to round.
 */
function requireRawAmount(value: unknown, field: string): bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new MalformedPayloadError(field);
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value)) throw new MalformedPayloadError(field);
  return BigInt(value);
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
 * One `accountData` entry, with its *identity* validated and its values left
 * untouched.
 *
 * The split is the whole point (see the file header): `account` and
 * `userAccount` say whose leg a value belongs to, so an unreadable one may
 * be hiding the tracked wallet's own leg and the row fails closed. The
 * values hanging off them are read only if the identity turns out to be a
 * wallet we are evaluating, so an untracked liquidity pool's broken
 * `decimals` costs nobody a trade.
 */
type AccountEntry = {
  account: string;
  record: Record<string, unknown>;
  changes: { userAccount: string; record: Record<string, unknown> }[];
};

/**
 * The payload's `accountData`, with every entry's identity validated. This
 * is the single traversal of the payload's structure: `candidateAddresses`,
 * `balanceChangesFor` and `nativeLamportsFor` all read through it, so there
 * is one place where an unreadable structure becomes a typed error instead
 * of a `TypeError` escaping the caller.
 */
function accountEntries(payload: EnhancedTx): AccountEntry[] {
  const entries: AccountEntry[] = [];
  for (const account of requireArray((payload as EnhancedTx | undefined | null)?.accountData, "accountData")) {
    const record = requireObject(account, "accountData[]");
    const changes = requireArray(record.tokenBalanceChanges as readonly unknown[] | undefined, "tokenBalanceChanges");
    entries.push({
      account: requireString(record.account, "accountData[].account"),
      record,
      changes: changes.map((change) => {
        const changeRecord = requireObject(change, "tokenBalanceChange");
        return {
          userAccount: requireString(changeRecord.userAccount, "tokenBalanceChange.userAccount"),
          record: changeRecord,
        };
      }),
    });
  }
  return entries;
}

/**
 * Every SPL balance change the payload reports for `address`, validated.
 * Only this wallet's own changes are read: a malformed `rawTokenAmount`,
 * `decimals` or `mint` on somebody else's leg is never touched, so it cannot
 * cost this wallet its trade.
 */
function balanceChangesFor(payload: EnhancedTx, address: string): BalanceChange[] {
  const changes: BalanceChange[] = [];
  for (const account of accountEntries(payload)) {
    for (const change of account.changes) {
      if (change.userAccount !== address) continue;
      changes.push(readBalanceChange(change.record));
    }
  }
  return changes;
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
    if (account.account === address) {
      total += requireLamports(account.record.nativeBalanceChange, "nativeBalanceChange");
    }
  }
  return total;
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
  const changes = balanceChangesFor(payload, wallet.address);
  const allLegs = tokenLegsIn(changes);
  const legs = dropDust(allLegs);
  if (legs.length === 0) {
    return { outcome: allLegs.length === 0 ? "no_token_leg" : "dust_only" };
  }
  if (legs.length >= 2) return { outcome: "unsupported_quote" };

  const { mint, raw, decimals } = legs[0];
  if (mint === USDC_MINT) return { outcome: "stable_rotation" }; // spec §4.3: not a trade

  const side: "buy" | "sell" = raw > 0n ? "buy" : "sell";
  const tokenAmount = Number(raw < 0n ? -raw : raw) / 10 ** decimals;

  // Read at the point of use, once this wallet is known to have a leg: a
  // wallet the transaction does not trade for never touches these, so a
  // malformed one cannot cost it anything. `feePayer` is required as a
  // string rather than compared loosely — an absent or non-string one would
  // silently make every wallet a non-fee-payer and drop the fee out of the
  // §4.4 arithmetic without a word.
  const isFeePayer = wallet.address === requireString(payload?.feePayer, "feePayer");
  const fee = requireFee(payload?.fee);
  const nativeChange = nativeLamportsFor(payload, wallet.address);
  const feeAdjustedNative = isFeePayer ? nativeChange + fee : nativeChange;
  // Both terms are lamports by construction; spec §4.3 treats SOL and WSOL as one quantity.
  const solDelta = feeAdjustedNative + wsolLamportsIn(changes);

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

/**
 * Every address this transaction mentions, as a candidate wallet to resolve.
 * Reads identities only — no value in the payload is touched here, so a
 * malformed leg cannot stop the row's tracked wallets from being found.
 */
function candidateAddresses(payload: EnhancedTx): string[] {
  const addresses = new Set<string>();
  for (const account of accountEntries(payload)) {
    addresses.add(account.account);
    for (const change of account.changes) addresses.add(change.userAccount);
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
      header.slot,
    ],
  );

  await query(
    `INSERT INTO position (kol_id, mint, dirty) VALUES ($1, $2, TRUE)
     ON CONFLICT (kol_id, mint) DO UPDATE SET dirty = TRUE`,
    [wallet.kol_id, trade.mint],
  );
}

/** What can end up in `raw_tx.parse_error`: a swap outcome, or an unreadable payload. */
export type RowParseError = SwapParseError | "malformed_payload";

/**
 * Priority used when two different tracked wallets in the same transaction
 * hit two different non-trade outcomes.
 *
 * `malformed_payload` outranks both, because it is the only one that leaves
 * the row requeueable (`parsed_at` NULL): losing it to a lower-priority
 * error would settle the row for good and drop that wallet's leg forever. A
 * wrong-direction leg then outranks an unsupported quote — it is a rejected
 * trade with real money on it, which matters more to surface than a quote
 * this batch simply doesn't parse yet.
 */
const ERROR_PRIORITY: Record<RowParseError, number> = {
  malformed_payload: 3,
  sol_leg_wrong_direction: 2,
  unsupported_quote: 1,
};

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
 * `unsupported_quote` and `sol_leg_wrong_direction` are the opposite:
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
        result = evaluateSwap(payload, wallet);
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

    if (rowError === "malformed_payload") {
      // Requeueable: parse_error set so the row stops being re-selected and
      // cannot stall the queue, parsed_at left NULL so clearing parse_error
      // after a parser fix reprocesses it without spending another Helius
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

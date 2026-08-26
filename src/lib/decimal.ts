/**
 * Exact fixed-point decimal arithmetic, for money and token quantities.
 *
 * Spec §3: *all money is `numeric`, never float*. `pg` hands a `numeric`
 * back as a **string**, so the only way to lose that guarantee is to convert
 * it — `Number(row.sol_amount)`, `parseFloat`, or any `+`/`*` on a `number`
 * holding a price or an amount. A double carries 15–17 significant decimal
 * digits; a cost basis accumulated over a few hundred trades drifts, and the
 * drift is invisible because the result still looks like a number.
 *
 * Everything here is `bigint` scaled by 10^{@link DECIMALS}, and the only two
 * doors between that and the outside world are {@link parseDecimal} (string
 * from Postgres in) and {@link formatDecimal} (string to Postgres out). No
 * `number` appears in this module at all, so no caller can pick one up by
 * accident.
 *
 * **Why 18 decimals.** Every quantity this project stores is a lamport count
 * (9 decimals), an SPL token amount (at most 9 decimals), or a product of one
 * with a USD rate. 18 leaves nine spare digits below the smallest unit that
 * exists on chain, so an intermediate division truncates well under a
 * lamport. It is not enough for an *arbitrary* decimal, which is why
 * {@link parseDecimal} rounds rather than pretending: see its own note.
 */

/** Digits kept after the decimal point. */
export const DECIMALS = 18;

/** 1, in the scaled representation. Multiply to scale up, divide to scale down. */
export const ONE = 10n ** BigInt(DECIMALS);

/**
 * Widest value accepted, as a power of ten. Total SOL in existence is under
 * 10^9 and a USD amount under 10^12, so 10^60 is far past anything real and
 * reaching it means the input is corrupt rather than large. Rejecting bounds
 * the cost of `10n ** shift` below, which is otherwise attacker-controlled.
 */
const MAX_EXPONENT = 60n;

// Sign, integer digits, optional fraction, optional exponent. Deliberately
// strict: no whitespace inside, no leading `.`-only form without digits, no
// `Infinity`/`NaN`, no thousands separators. Anything Postgres can emit for a
// `numeric` matches; almost nothing else does.
const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Parses a decimal string into the scaled representation, exactly.
 *
 * Accepts what Postgres emits for `numeric` (plain digits, any scale) and
 * also exponent notation, because a JS `number` passed as a query parameter
 * is serialised by `pg` with `String()` — which produces `1e-8` for small
 * values — and Postgres stores that faithfully.
 *
 * More than {@link DECIMALS} fractional digits is **rounded** (half away from
 * zero), not rejected: refusing would leave the position permanently dirty
 * and re-replayed forever, and no value this system writes has more than 9
 * fractional digits, so the rounding is unreachable in practice and bounded
 * by 5·10^-19 — eleven orders of magnitude below one lamport — if it is ever
 * reached anyway.
 */
export function parseDecimal(text: string): bigint {
  const match = DECIMAL_PATTERN.exec(text.trim());
  if (!match) throw new Error("not a decimal number");

  // A group that did not participate is `undefined` at runtime even though
  // TypeScript types every element of a match as `string`; `?? ""` is what
  // makes the two agree.
  const sign = match[1] ?? "";
  const integerDigits = match[2] ?? "";
  const fractionDigits = match[3] ?? "";
  const exponentDigits = match[4] ?? "";
  if (integerDigits === "" && fractionDigits === "") throw new Error("not a decimal number");

  // BigInt, not Number: an exponent is not money, but keeping the whole
  // module free of `number` means no later edit can quietly widen its use.
  const exponent = exponentDigits === "" ? 0n : BigInt(exponentDigits);
  if (exponent > MAX_EXPONENT || exponent < -MAX_EXPONENT) throw new Error("decimal out of range");

  const digits = BigInt(integerDigits + fractionDigits);
  // How far the value has to move to land on the fixed-point grid.
  const shift = BigInt(DECIMALS) + exponent - BigInt(fractionDigits.length);
  const magnitude = shift >= 0n ? digits * 10n ** shift : roundedDivision(digits, 10n ** -shift);
  if (magnitude >= 10n ** (MAX_EXPONENT + BigInt(DECIMALS))) throw new Error("decimal out of range");

  return sign === "-" ? -magnitude : magnitude;
}

/** `numerator / divisor` for non-negative inputs, rounded half away from zero. */
function roundedDivision(numerator: bigint, divisor: bigint): bigint {
  return (numerator * 2n + divisor) / (divisor * 2n);
}

/**
 * Renders the scaled representation as a plain decimal string for a `numeric`
 * column. Canonical: no exponent, no trailing fractional zeros, no `-0`. Two
 * equal values always produce the same string, which is what makes
 * `position` and `pnl_daily` rows comparable byte for byte across replays.
 */
export function formatDecimal(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const fraction = (magnitude % ONE).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  const whole = (magnitude / ONE).toString();
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/**
 * `(a × b) / c`, scale-preserving and computed as **one** division.
 *
 * This is the shape spec §4.2's sell rule is written in here. The obvious
 * transcription — `avg = cost / qty` once, then `avg * sold` — divides twice
 * and leaves the position's remaining `cost_sol` inconsistent with the amount
 * that was actually taken out of it: the residue of the first rounding is
 * multiplied by the sold quantity in the second step. Doing it as one
 * multiply and one divide keeps `cost_sol` exactly equal to what remains, and
 * makes a full exit (`sold === qty`) land on exactly `0`.
 *
 * Truncates toward zero. All three arguments carry the same scale; the extra
 * factor of {@link ONE} introduced by the multiplication is removed by the
 * division, so the result is back on the same grid.
 */
export function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new Error("division by zero");
  return (a * b) / c;
}

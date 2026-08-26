/**
 * `es-ES` rendering for everything the UI shows: `1.802,4`, `+18,42 SOL`,
 * `hace 4 min`.
 *
 * Every amount arrives as the **string** Postgres emitted for a `numeric`,
 * and none of it is converted to a `number` on the way to the screen —
 * `decimal.ts` explains why at length, and a formatter is exactly the kind of
 * place where `Number(row.sol_amount)` looks harmless and is not. Amounts are
 * parsed into `decimal.ts`'s scaled `bigint`, rounded there, and rendered
 * digit by digit.
 *
 * `Intl.NumberFormat("es-ES")` would be the obvious tool and is not used: it
 * only takes a `number`, so reaching it means passing money through a double
 * first. The grouping and decimal marks it would have produced are three
 * lines below instead.
 *
 * The module is imported by a client component, so it stays free of anything
 * that is not portable JavaScript.
 */
import { DECIMALS, ONE, parseDecimal } from "./decimal";

/** U+2212, the typographic minus: it aligns with digits, the hyphen does not. */
const MINUS = "−";

/** Rounds the scaled value to `fractionDigits`, half away from zero. */
function roundTo(value: bigint, fractionDigits: number): bigint {
  const divisor = 10n ** BigInt(DECIMALS - fractionDigits);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const rounded = (magnitude * 2n + divisor) / (divisor * 2n);
  return negative ? -rounded : rounded;
}

/**
 * Renders a value already scaled by `10^fractionDigits` as `es-ES`: `.` every
 * three integer digits, `,` before the fraction.
 */
function renderEs(scaled: bigint, fractionDigits: number): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(fractionDigits + 1, "0");
  const cut = digits.length - fractionDigits;
  const integerPart = digits.slice(0, cut).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = digits.slice(cut);
  return `${negative ? MINUS : ""}${integerPart}${fraction === "" ? "" : `,${fraction}`}`;
}

/** Base-10 exponent of the leading digit; `null` for zero. */
function exponentOf(value: bigint): number | null {
  if (value === 0n) return null;
  const magnitude = value < 0n ? -value : value;
  return magnitude.toString().length - 1 - DECIMALS;
}

/**
 * The shared rule for every amount the UI prints: `significant` significant
 * digits, never fewer than two decimals, trailing fractional zeros dropped
 * back to that floor.
 *
 * A fixed number of decimals cannot serve this product. Prices here span
 * `0,0000071` to four figures and SOL amounts span dust to hundreds; two
 * decimals renders a real 0,004 SOL trade as `0,00` — nothing at all — while
 * nine decimals turns `US$1.802,40` into noise. The two-decimal floor is what
 * keeps a value at or above one reading as money (`US$12,00`, not `US$12`).
 */
function formatAmount(text: string, significant: number, minimumFraction = 2): string {
  return renderAmount(parseDecimal(text), significant, minimumFraction);
}

function renderAmount(value: bigint, significant: number, minimumFraction: number): string {
  const exponent = exponentOf(value);
  const fractionDigits =
    exponent === null
      ? minimumFraction
      : Math.min(Math.max(significant - 1 - exponent, minimumFraction), DECIMALS);

  let rendered = renderEs(roundTo(value, fractionDigits), fractionDigits);
  // The comma check is load-bearing once `minimumFraction` can be zero: with
  // no fraction at all the loop would otherwise eat integer digits.
  while (
    rendered.includes(",") &&
    rendered.endsWith("0") &&
    rendered.length - rendered.indexOf(",") - 1 > minimumFraction
  ) {
    rendered = rendered.slice(0, -1);
  }
  return rendered.endsWith(",") ? rendered.slice(0, -1) : rendered;
}

/**
 * A SOL amount, as it appears inside a feed sentence.
 *
 * The precision is not fixed. DESIGN.md's rule that a column of figures
 * aligns on the decimal governs the leaderboard's fixed columns; the feed row
 * is a sentence, so the amount can afford to be honest about its size instead.
 */
export function formatSol(text: string): string {
  return formatAmount(text, 2);
}

/**
 * A USD price. Four significant digits, so `US$0,0000071` and `US$123,46` are
 * both readable under one rule.
 */
export function formatUsdPrice(text: string): string {
  return `US$${formatAmount(text, 4)}`;
}

/** Scaled by 10^18, so dividing the scaled value by these divides the real one. */
const MILLION = 10n ** 6n;
const TRILLION = 10n ** 12n;

/**
 * A token quantity, compacted: `16,9M`, `1.690M`, `847`.
 *
 * Spec §2 puts this in the row and DESIGN.md's `row-feed` originally left it
 * out. The row needs it: without a quantity there is no way to check the SOL
 * amount against the price, which is the one arithmetic a reader can do from
 * a feed line, and at 1280px the sentence otherwise trails half the row in
 * empty space.
 *
 * `M` for millions and `B` for billions (10^12, `billón`), which is what
 * `es-ES` means by those letters — not the English short scale. Below a
 * million the plain grouped figure is shorter than any abbreviation of it, so
 * there is no `mil` tier.
 */
export function formatTokenAmount(text: string): string {
  const value = parseDecimal(text);
  const magnitude = value < 0n ? -value : value;

  if (magnitude >= ONE * TRILLION) return `${renderAmount(value / TRILLION, 3, 0)}B`;
  if (magnitude >= ONE * MILLION) return `${renderAmount(value / MILLION, 3, 0)}M`;
  return renderAmount(value, 4, 0);
}

/**
 * `hace 4 min`, in neutral Spanish and in the abbreviated form DESIGN.md's
 * feed row uses. `Intl.RelativeTimeFormat` produces `hace 4 minutos`, which
 * is the same information in three times the column width.
 *
 * A block time slightly ahead of the reader's clock is normal — the two
 * clocks are not the same clock — and renders as `ahora` rather than as a
 * negative age or a time in the future.
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const seconds = Math.floor((now - Date.parse(iso)) / 1000);
  if (seconds < 10) return "ahora";
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

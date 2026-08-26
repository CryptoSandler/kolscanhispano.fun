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
import { DECIMALS, parseDecimal } from "./decimal";

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
function formatAmount(text: string, significant: number): string {
  const value = parseDecimal(text);
  const exponent = exponentOf(value);
  const fractionDigits =
    exponent === null ? 2 : Math.min(Math.max(significant - 1 - exponent, 2), DECIMALS);

  let rendered = renderEs(roundTo(value, fractionDigits), fractionDigits);
  // `fractionDigits` is never below two, so a comma is always present; the
  // check keeps that assumption from becoming a silent digit-eater if it ever
  // stops holding.
  while (
    rendered.includes(",") &&
    rendered.endsWith("0") &&
    rendered.length - rendered.indexOf(",") - 1 > 2
  ) {
    rendered = rendered.slice(0, -1);
  }
  return rendered;
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

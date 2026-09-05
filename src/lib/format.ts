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

/** `+`, the typographic minus, or nothing at all for zero. */
function signOf(value: bigint): string {
  if (value > 0n) return "+";
  return value < 0n ? MINUS : "";
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * A leaderboard total in SOL: `+18,42 SOL`, `−3,10 SOL`, `0,00 SOL`.
 *
 * **Exactly two decimals, always** — unlike {@link formatSol}, which lets a
 * feed row be honest about the size of one trade. DESIGN.md's rule is that a
 * column of figures aligns on the decimal for its whole height, and a variable
 * number of decimals cannot do that. A window's realized total is also never
 * dust: it is the sum of a day's or a month's round trips.
 *
 * The sign is explicit on a gain because the leaderboard's whole subject is
 * direction, and `18,42` next to `−3,10` reads as an absolute value until the
 * eye finds the colour.
 */
export function formatSignedSol(text: string): string {
  const value = parseDecimal(text);
  return `${signOf(value)}${renderEs(roundTo(absolute(value), 2), 2)} SOL`;
}

/** The same total in USD: `+US$1.802,40`. The sign goes outside the symbol. */
export function formatSignedUsd(text: string): string {
  const value = parseDecimal(text);
  return `${signOf(value)}US$${renderEs(roundTo(absolute(value), 2), 2)}`;
}

/**
 * The same figure with **no leading `+`**, for the ranking row's parenthesised
 * total.
 *
 * Measured on the mould at 1440 on 2026-09-05: their totals read
 * `(R$148.253,0)`, with no sign on a gain — the sign lives on the per-chain
 * amounts beside it, where direction is the information. A loss keeps its minus,
 * as theirs does (`R$-123` on their cabals list).
 *
 * It is not only a convention. Their fiat track is **exactly 140px** and their
 * string fits it; ours carried one glyph more and overflowed leftward into the
 * SOL slot, which is what produced `+12.50 SOL(+US$7.275,00)` with no gap on the
 * wide rows and a gap on the narrow ones. Dropping the sign both matches them
 * and fits the track they sized.
 */
/**
 * `+12,50 SOL`, `-0,30 BNB` — a signed native amount in any unit.
 *
 * **Spanish decimals, like every other figure here.** The chain columns were
 * built with `toFixed`, which prints `+12.50 SOL` with a dot, on a site whose
 * every other number uses a comma — caught by an existing test that expected
 * `+18,42 SOL` and got the dot. The mould prints a dot because it is formatted
 * for a different locale; copying its geometry does not mean copying its
 * number formatting.
 *
 * Two decimals and trailing zeros trimmed: a list is read at a glance and
 * `+12 SOL` is easier than `+12,00 SOL`.
 */
export function formatSignedAmount(text: string, unit: string): string {
  const value = parseDecimal(text);
  const rendered = renderEs(roundTo(absolute(value), 2), 2).replace(/,00$/, "");
  return `${signOf(value)}${rendered} ${unit}`;
}

export function formatUnsignedUsd(text: string): string {
  const value = parseDecimal(text);
  const sign = signOf(value) === "-" ? "-" : "";
  return `${sign}US$${renderEs(roundTo(absolute(value), 2), 2)}`;
}

/**
 * The same total in pesos: `+AR$2.784.708`.
 *
 * **No decimals, unlike every other money figure here.** At the rates this
 * product converts through — 1.545 ARS to the dollar, measured 2026-09-02 — one
 * peso is six thousandths of a US cent, so a decimal place would be printing
 * the rounding of a rate rather than anything about the trade. The figure is
 * already an approximation of an approximation; two more digits would dress it
 * as a measurement.
 */
export function formatSignedArs(text: string): string {
  const value = parseDecimal(text);
  return `${signOf(value)}AR$${renderEs(roundTo(absolute(value), 0), 0)}`;
}

/**
 * The rate itself, as the qualifier line prints it: `1.545`, `1.533,9`. Six
 * significant digits with no decimal floor — the source publishes whole pesos
 * for some casas and one decimal for others, and neither is padded.
 */
export function formatArsRate(text: string): string {
  return formatAmount(text, 6, 0);
}

/**
 * A win rate: `68,4 %`, `100 %`, `0 %`. Three significant digits with no
 * decimal floor, so a whole percentage is not padded to `100,0 %`.
 *
 * The space before `%` is `es-ES`, not a typo.
 */
export function formatPercent(text: string): string {
  return `${renderAmount(parseDecimal(text), 3, 0)} %`;
}

/**
 * Plain magnitudes, deliberately *not* scaled by {@link DECIMALS}: they are
 * used as `ONE * MILLION` and `value / MILLION`, so they multiply and divide a
 * scaled value without knowing what the scale is. That is why they survived
 * `DECIMALS` moving from 18 to 27 untouched.
 */
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

/**
 * The direction a signed amount points, as the class name that colours it.
 *
 * DESIGN.md: *"Green and red are direction of money and nothing else"*, and a
 * window in which nothing was realized is neither — so `0`, `0.00` and `-0` all
 * come out empty and the figure stays ink.
 *
 * Read off the string rather than parsed into anything: a leading `-` is the
 * only thing Postgres puts in front of a negative `numeric`.
 *
 * It lives here rather than in either component because the leaderboard row,
 * the modal's header and the modal's calendar all colour by the same rule, and
 * three copies of it would eventually disagree about what a zero is.
 */
export function amountDirection(text: string): "gain" | "loss" | "" {
  if (/^-0*(\.0*)?$/.test(text)) return "";
  if (text.startsWith("-")) return "loss";
  return /^0*(\.0*)?$/.test(text) ? "" : "gain";
}

/**
 * A block's instant, fixed and in UTC: `25/08 14:32 UTC`.
 *
 * The feed row prints a relative age because it is a live surface and the row
 * is about *how recently*; the modal's trade list is a period's record, where
 * "hace 3 d" is worse than the date. Fixed also means it does not depend on a
 * clock, so it renders identically on the server and in the browser.
 *
 * `UTC` is stated because it is the boundary every window in this product is
 * cut on (spec §4.9), and an unlabelled time would be read as local.
 * `Intl.DateTimeFormat` is not used: it would take the *runner's* zone unless
 * told otherwise, which is the failure `windows.ts` exists to prevent, and the
 * ISO string already holds the fields in order.
 */
export function formatUtcMoment(iso: string): string {
  const [date, time] = iso.split("T");
  const [, month, day] = date.split("-");
  return `${day}/${month} ${time.slice(0, 5)} UTC`;
}

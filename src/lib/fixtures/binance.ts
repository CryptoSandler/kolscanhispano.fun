/**
 * Builds the subset of Binance's `/api/v3/klines` response that `prices.ts`
 * reads: a JSON array of arrays, one per minute, positional rather than
 * keyed.
 *
 * Only two of the twelve positions are load-bearing here — `[0]` the candle's
 * open time in milliseconds and `[4]` its close as a decimal *string* — so
 * those are the two this builder takes. The rest are filled with
 * shape-accurate placeholders rather than omitted, because a parser that
 * happened to read a different index would then pass against a fixture that
 * does not resemble the wire format at all.
 *
 * Verified against the live endpoint on 2026-08-27 (see the task report):
 *
 *     $ curl "https://api.binance.com/api/v3/klines?symbol=SOLUSDC&interval=1m&limit=1"
 *     [[1787734500000,"96.74000000","96.82000000","96.68000000","96.77000000",
 *       "345.56700000",1787734559999,"33436.84156000",90,"80.58800000",
 *       "7796.95564000","0"]]
 */

/** Milliseconds in one minute — the candle interval this project asks for. */
const MINUTE_MS = 60_000;

/**
 * One candle. `minute` is truncated to its containing minute, the way the
 * real endpoint only ever emits aligned open times.
 */
export function buildKline(minute: Date | number, close: string): unknown[] {
  const openTime = Math.floor((minute instanceof Date ? minute.getTime() : minute) / MINUTE_MS) * MINUTE_MS;
  return [
    openTime,
    close, // open — irrelevant to this project, kept a plausible number
    close, // high
    close, // low
    close, // close: the only value `prices.ts` reads
    "345.56700000", // volume
    openTime + MINUTE_MS - 1, // closeTime
    "33436.84156000", // quote volume
    90, // trades
    "80.58800000", // taker buy base volume
    "7796.95564000", // taker buy quote volume
    "0", // unused, always "0"
  ];
}

/**
 * `count` consecutive candles starting at `from`. `close` is a function of
 * the index so a test can give every minute a distinct, checkable value —
 * which is what makes an off-by-one in the writer visible as a wrong *value*
 * rather than only as a wrong row count.
 */
export function buildKlineSeries(
  from: Date,
  count: number,
  close: (index: number) => string = (index) => String(100 + index),
): unknown[][] {
  const start = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS;
  return Array.from({ length: count }, (_, index) => buildKline(start + index * MINUTE_MS, close(index)));
}

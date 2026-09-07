/**
 * Prices and token metadata. Spec §4.6 (price states) and §5.7 (source
 * decision) are the binding authority here.
 *
 * **The source decision, and why it is not Helius.** The Helius free tier is
 * 1,000,000 credits a month and `getAsset` (DAS) costs 10 credits a call.
 * Pricing SOL once a minute alone would spend `10 * 60 * 24 * 30 = 432,000`
 * credits — 43% of the entire free tier — on one number. DexScreener needs no
 * key, is free, batches up to {@link DEXSCREENER_BATCH_LIMIT} mints per call,
 * and is already the spec's designated source. So: DexScreener first, always,
 * for both the SOL/USD rate and every mint's metadata and price.
 *
 * **Helius DAS is the fallback, and only for a symbol.** A mint DexScreener
 * has never indexed (no pair at all) still needs a name to render in the
 * feed. `getAsset` gives one for 10 credits, rarely — but it never earns a
 * price: `parseHeliusAsset` does not read `token_info.price_info` even when
 * the response carries one, because spec §5.7 forbids Helius as a price
 * source unconditionally, not just as the default. A mint priced this way
 * would be a price nobody asked DexScreener to confirm.
 *
 * **The one property every function here is written to hold**: nothing in
 * this file ever writes a price it did not itself receive from a source, and
 * a source that could not be reached leaves whatever was cached before
 * completely alone — never nulled, never zeroed, never overwritten with a
 * guess. That is the difference §4.6 draws between "we don't know right now"
 * (leave it) and "we know it's nothing" (write `unpriced`, no number). Only a
 * *definitive* answer from a source — a successful response that plainly
 * does not mention this mint — writes the second kind. A network or parse
 * failure writes nothing at all, for exactly the mints it affects.
 *
 * Money handed to `pg` is always a decimal *string*, produced by
 * `decimal.ts`'s `formatDecimal`/`parseDecimal` — see that module for why a
 * `number` is never on this path. One exception is unavoidable:
 * DexScreener's own JSON reports `liquidity.usd` as a float, not a string
 * (`priceUsd` and `priceNative`, the two figures actually stored as prices,
 * are strings). That precision loss happens once, upstream, before this file
 * ever sees the value; nothing here compounds it; and it is used only for a
 * threshold comparison and for display, never added to or multiplied against
 * anything.
 */
import { ONE, formatDecimal, mulDiv, parseDecimal } from "./decimal";
import { query } from "./db";
import { USDC_MINT, WSOL_MINT } from "./mints";

/** DexScreener's own limit on a `/tokens/{mints}` call. Exceeding it 400s the request. */
export const DEXSCREENER_BATCH_LIMIT = 30;

const DEXSCREENER_TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens/";

const BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines";

/**
 * Binance's own cap on candles per `/api/v3/klines` call — ≈16.7 hours of
 * one-minute candles. Verified 2026-08-27: `&limit=1000` returned exactly
 * 1000. Asking for more is not an error, it is silently this.
 */
export const BINANCE_KLINE_PAGE_SIZE = 1000;

/** The book whose denomination `sol_price` already holds. See {@link fillSolPriceMinutes}. */
const SOL_PRICE_SYMBOL = "SOLUSDC";
/** Only for a minute {@link SOL_PRICE_SYMBOL} has no candle for — more liquid, different denomination. */
const SOL_PRICE_FALLBACK_SYMBOL = "SOLUSDT";

/**
 * Default ceiling on Binance requests per {@link fillSolPriceMinutes} call:
 * four pages, ≈2.8 days of minutes, one weight-2 request each. A bound is not
 * optional here — an unbounded loop over a mistyped `--from` would page
 * through years of candles a minute at a time.
 */
export const DEFAULT_KLINE_REQUEST_CAP = 4;

const MINUTE_MS = 60_000;

/** The start of the minute containing `at`, matching what `solUsdForMinute` truncates to. */
function minuteFloor(at: Date): number {
  return Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
}

/** Spec §4.6's default floor, in USD. Overridable so a launch value can be tuned without a deploy. */
const DEFAULT_PRICE_MIN_LIQUIDITY_USD = "1000";

/** Longest symbol/name this file will store, so a pathological upstream string cannot bloat a row. */
const MAX_SYMBOL_LENGTH = 64;
const MAX_NAME_LENGTH = 128;

/** Widest `decimals` this file trusts from Helius DAS. No SPL mint exceeds 9 in practice. */
const MAX_DECIMALS = 20;

function priceMinLiquidityUsd(): bigint {
  const configured = process.env.PRICE_MIN_LIQUIDITY_USD?.trim();
  return parseDecimal(
    configured === undefined || configured === "" ? DEFAULT_PRICE_MIN_LIQUIDITY_USD : configured,
  );
}

export type PriceState = "priced" | "stale" | "unpriced";

// ---------------------------------------------------------------------------
// SOL/USD
// ---------------------------------------------------------------------------

/**
 * The SOL/USD rate in effect for `minute`: the most recent `sol_price` row at
 * or before it. `null` when no row that old exists yet.
 *
 * The `<=` bound, not `=`, is what makes a trade minutes or hours after the
 * last successful `refreshSolPrice` still resolve to a real rate instead of
 * `null` — the exact continuity a cache-miss-tolerant design needs.
 *
 * This is the **only** place that lookup is written. `parse-swap.ts`'s
 * `insertTrade` used to run its own copy inline and `scripts/backfill-prices.ts`
 * would have been a third; a rate lookup written three times is a rule that
 * can disagree with itself, and "which minute's rate" is precisely the kind
 * of off-by-one that produces a plausible wrong number rather than a failure.
 * Both callers now come through here, so one mutation of this query is
 * visible to every test that depends on it.
 *
 * **This bound is for the USD *view* of a trade, never for its cost basis.**
 * `usd_amount`, `sol_usd` and `price_usd` are a second rendering of a SOL
 * figure that was already measured exactly, so a rate a few minutes old
 * makes them slightly off; the SOL side, the leaderboard and every position
 * are untouched. Deriving the SOL side *itself* from a rate is a different
 * question with a different answer — see {@link solUsdForMinute}.
 */
export async function solUsdAt(minute: Date): Promise<bigint | null> {
  const [row] = await query<{ usd: string }>(
    `SELECT usd FROM sol_price
      WHERE minute <= date_trunc('minute', $1::timestamptz)
      ORDER BY minute DESC LIMIT 1`,
    [minute],
  );
  return row ? parseDecimal(row.usd) : null;
}

/**
 * The SOL/USD rate recorded **for the containing minute itself**, or `null`
 * if `sol_price` has no row for that exact minute. Spec §5.7: *"SOL/USD from
 * a single source once per minute into `sol_price`; trades resolve their rate
 * from the containing minute"*.
 *
 * The `=`, and the whole reason this exists beside {@link solUsdAt}: this is
 * the lookup a **cost basis** is allowed to be built from. `parse-swap.ts`
 * normalises a stablecoin-quoted swap to SOL at this rate (spec §4.3), so the
 * rate stops being a display figure and becomes `sol_amount`, `price_sol`,
 * the position's `cost_sol` and the leaderboard's ranking. `solUsdAt`'s `<=`
 * bound would answer that question with whatever row happened to be most
 * recent, which is a rate SOL may have moved arbitrarily far from — unknown
 * and unmeasured — so a basis built on it is a number no source ever reported
 * for that block.
 *
 * **What actually fills the minutes this asks for.** For a long time nothing
 * did: `refreshSolPrice` wrote one row, at the current minute, once per run,
 * and the parse cron runs every five minutes, so four minutes in five had no
 * row *by construction* and every stablecoin-quoted swap landing in one of
 * them was refused. {@link fillSolPriceMinutes} is what changed that — one
 * row per minute from Binance's klines, run *before* the parse (see
 * `scripts/backfill-sol-price.ts`). `refreshSolPrice` is still there and
 * still needed: it is a second, independent source, and it is the only writer
 * of the current minute, which the Binance fill deliberately leaves alone.
 *
 * A miss is still a refusal, not a fallback: `parse-swap.ts` declines the
 * swap and records it requeueably, so a `sol_price` row arriving later — a
 * historical import, a wider `--from` on the fill — can still make it
 * parseable. That is the §4.6 distinction ("we don't know right now" leaves
 * it alone) applied to a rate rather than a token price. Note that
 * "requeueable" is a property of the *row*, not a scheduled behaviour:
 * `parsePending` filters on `parse_error IS NULL`, and nothing in this
 * repository clears that column, so a swap refused once stays refused until
 * something does.
 */
export async function solUsdForMinute(minute: Date): Promise<bigint | null> {
  const [row] = await query<{ usd: string }>(
    `SELECT usd FROM sol_price WHERE minute = date_trunc('minute', $1::timestamptz)`,
    [minute],
  );
  return row ? parseDecimal(row.usd) : null;
}

/**
 * One trade's USD figures at a given SOL/USD rate. Decimal strings, ready for
 * a `numeric` column — never `number`s.
 */
export type TradeValuation = {
  solUsd: string;
  usdAmount: string;
  priceUsd: string | null;
};

/**
 * Values one trade at `solUsd`. Every argument is scaled `BigInt` (see
 * `decimal.ts`) and every result is a decimal string, so no USD figure this
 * project stores passes through a double.
 *
 * That is not a stylistic preference here. The previous implementation lived
 * inline in `insertTrade` and read `Number(rate.usd)` off the `numeric` `pg`
 * hands back, then multiplied two doubles. Measured in node 26:
 * `0.1 * 231.71` is `23.171000000000003` and `0.05 * 231.71` is
 * `11.585500000000001` — both written straight into a `numeric` column, and
 * the leaderboard sums thousands of them. (`0.1 * 231.7`, an earlier draft's
 * example, is exactly `23.17` in doubles; the artefact depends on the
 * operands, which is precisely why "it looked right in the test I tried" is
 * not evidence.) `mulDiv` divides once and truncates on the 18-decimal grid,
 * eleven orders of magnitude below a lamport.
 *
 * `priceSol` is nullable because `price_usd` is derived from it: a trade with
 * no per-token price has no per-token USD price either, and inventing one
 * from `usdAmount` alone would be a fabricated number of exactly the kind
 * `parse-swap.ts`'s header exists to forbid.
 */
export function valueTrade(
  solAmount: bigint,
  priceSol: bigint | null,
  solUsd: bigint,
): TradeValuation {
  return {
    solUsd: formatDecimal(solUsd),
    usdAmount: formatDecimal(mulDiv(solAmount, solUsd, ONE)),
    priceUsd: priceSol === null ? null : formatDecimal(mulDiv(priceSol, solUsd, ONE)),
  };
}

/**
 * Fetches the current SOL/USDC pair from DexScreener and records it against
 * the current minute in `sol_price`. Returns whether DexScreener yielded a
 * usable rate at all — not whether a row was written, which is a different
 * question since the insert became `DO NOTHING`.
 *
 * **The first observation of a minute wins, and this function stopped being
 * the exception to that.** The insert was `ON CONFLICT (minute) DO UPDATE SET
 * usd = EXCLUDED.usd` while {@link fillSolPriceMinutes} — the other writer of
 * this table — has always been `DO NOTHING`. An overwritten minute is not a
 * corrected number: `parse-swap.ts` normalises a stablecoin-quoted swap at
 * `solUsdForMinute`, so a rate this table already handed out may already be
 * some trade's `sol_amount`, `price_sol`, `cost_sol` and leaderboard rank.
 * Rewriting it leaves that trade following from a rate the table no longer
 * claims for its block, with nothing recorded anywhere.
 *
 * That was latent while the only way to read a minute twice was two
 * `backfill-prices` runs landing inside one minute. `requeueNoRate` (see
 * `parse-swap.ts`) makes a mid-flight re-read of a minute an ordinary event,
 * so it is now routine. Both writers of `sol_price` therefore agree: the
 * first observation of a minute is the one that stands.
 *
 * On any failure — the request itself, a non-OK response, unparseable JSON,
 * no solana-chain SOL/USDC pair in the result, or a `priceUsd` this file
 * cannot read as a decimal — nothing is written. `solUsdAt` then still
 * resolves every later minute from the last row that *did* write
 * successfully, via its `<=` bound: a transient DexScreener outage degrades
 * to "slightly stale rate", never to "no rate" or "rate zeroed out".
 */
export async function refreshSolPrice(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<boolean> {
  const pair = await fetchSolUsdcPair(fetchImpl);
  if (!pair) {
    console.warn("refreshSolPrice: no usable SOL/USDC rate; keeping the previous one");
    return false;
  }

  let usd: string;
  try {
    usd = formatDecimal(parseDecimal(pair.priceUsdRaw));
  } catch {
    console.warn("refreshSolPrice: DexScreener's priceUsd was not a decimal; keeping the previous rate");
    return false;
  }

  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  await query(
    `INSERT INTO sol_price (minute, usd) VALUES ($1, $2)
       ON CONFLICT (minute) DO NOTHING`,
    [minute, usd],
  );
  return true;
}

/**
 * Fills `sol_price` with **one row per minute** across `[from, to]`, from
 * Binance's public 1-minute klines. Returns what it did, minute by minute
 * (see {@link SolPriceFill}).
 *
 * **Why this exists beside {@link refreshSolPrice}, and why it is not it.**
 * `refreshSolPrice` writes one row — the current minute — per run, and the
 * parse cron runs every five minutes, so four minutes in five have no row *by
 * construction*. {@link solUsdForMinute} answers with the row for the block's
 * own minute or nothing, because that rate becomes a cost basis rather than a
 * display figure, so every stablecoin-quoted swap landing in one of those four
 * minutes is refused `unsupported_quote_no_rate`. That is not a coverage gap
 * to be chased: it is one writer producing one row where the consumer needs
 * sixty. This function is the sixty.
 *
 * **Binance, and why the Helius credit budget in this file's header does not
 * apply.** Helius sells historical *transactions*, not a price feed; there is
 * no SOL/USD history to buy there at any credit price. DexScreener — the
 * source `refreshSolPrice` uses — serves only the *current* price, which is
 * exactly why it can write only the current minute. Binance's
 * `/api/v3/klines` is public, keyless, free, and returns 1,000 one-minute
 * candles per request (≈16.7 hours). Verified 2026-08-27:
 *
 *     $ curl ".../klines?symbol=SOLUSDC&interval=1m&limit=1000"
 *       -> 1000 candles, 2026-08-26T08:55Z .. 2026-08-27T01:34Z,
 *          0 missing minutes, x-mbx-used-weight-1m: 2
 *     $ ...&startTime=<730 days ago>&limit=1000  -> 1000 candles, 0 missing
 *
 * **`SOLUSDC`, not `SOLUSDT`.** It is the denomination `sol_price` already
 * holds — `refreshSolPrice` filters DexScreener to the SOL/**USDC** pair
 * specifically — so nothing about the column's meaning changes silently. USDT
 * is the more liquid book (367 trades against 37 in the minute checked), so
 * it is the fallback for a minute `SOLUSDC` has no candle for; a gap must
 * never become a silently missing minute. Falling back is counted in
 * {@link SolPriceFill.fromFallback} and warned about, so a run that needed it
 * says so.
 *
 * // ponytail: the fallback is recorded as a count and a log line, not a
 * // `source` column on `sol_price`. Add the column (and a migration) if it
 * // ever matters *per row* which book a rate came from — as it would the day
 * // a third source is added, or the day a USDT-derived rate has to be
 * // re-derived. Across 3,000 minutes sampled from three different eras the
 * // fallback never fired once, so a migration for it today would be a column
 * // that is always the same value.
 *
 * **The candle's close, and not its average.** `refreshSolPrice` records a
 * spot price at an instant; a minute's close is the same kind of quantity at
 * the same kind of instant, so the two writers put the same measure in the
 * same column. An OHLC average or a VWAP would be a different measure quietly
 * sharing it, and `solUsdForMinute`'s caller cannot tell them apart.
 *
 * **`ON CONFLICT DO NOTHING`, never `DO UPDATE`.** A minute already in the
 * table is a real observation — `refreshSolPrice` wrote it from DexScreener,
 * or an earlier run of this wrote it from Binance — and, once
 * `parse-swap.ts` has normalised a swap against it, it is also the cost basis
 * of a trade that already exists. Overwriting it would leave a `trade` row
 * whose `sol_amount` no longer follows from the rate the table claims for its
 * block. Re-running over a filled range therefore changes not one row's
 * value, and errors on nothing.
 *
 * A failure — the request, a non-OK response, unparseable JSON, a close this
 * file cannot read as a decimal — writes fewer rows, never a wrong one, and
 * never throws: the caller is a cron step that must not stand between a
 * webhook and a trade.
 */
export async function fillSolPriceMinutes(
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch,
  maxRequests: number = DEFAULT_KLINE_REQUEST_CAP,
): Promise<SolPriceFill> {
  const startMs = minuteFloor(from);
  const endMs = minuteFloor(to);
  if (endMs < startMs) {
    return { minutesRequested: 0, filled: 0, alreadyPresent: 0, fromFallback: 0, missing: 0, requests: 0, truncated: false };
  }
  const minutesRequested = (endMs - startMs) / MINUTE_MS + 1;

  const primary = await fetchKlineCloses(SOL_PRICE_SYMBOL, startMs, endMs, fetchImpl, maxRequests);
  const closes = primary.closes;
  let requests = primary.requests;
  let fromFallback = 0;

  // Only chase gaps when the primary pass actually covered the whole range.
  // A run that stopped at its request cap (or at a failed request) has a tail
  // of minutes it never asked about, and asking USDT for those would spend
  // the remaining budget on the wrong end of the problem and report a
  // fallback that was really a truncation.
  if (!primary.truncated && requests < maxRequests) {
    const gaps: number[] = [];
    for (let minute = startMs; minute <= endMs; minute += MINUTE_MS) {
      if (!closes.has(minute)) gaps.push(minute);
    }
    if (gaps.length > 0) {
      const fallback = await fetchKlineCloses(
        SOL_PRICE_FALLBACK_SYMBOL,
        gaps[0],
        gaps[gaps.length - 1],
        fetchImpl,
        maxRequests - requests,
      );
      requests += fallback.requests;
      for (const minute of gaps) {
        const close = fallback.closes.get(minute);
        if (close === undefined) continue;
        closes.set(minute, close);
        fromFallback++;
      }
      if (fromFallback > 0) {
        console.warn(
          `fillSolPriceMinutes: ${fromFallback} minute(s) had no ${SOL_PRICE_SYMBOL} candle and were filled from ${SOL_PRICE_FALLBACK_SYMBOL}`,
        );
      }
    }
  }

  // Normalise before writing, so a close this file cannot read as a decimal
  // is a minute left absent rather than a `numeric` the database rejects for
  // the whole batch.
  const minutes: Date[] = [];
  const rates: string[] = [];
  for (let minute = startMs; minute <= endMs; minute += MINUTE_MS) {
    const close = closes.get(minute);
    if (close === undefined) continue;
    let value: bigint;
    try {
      value = parseDecimal(close);
    } catch {
      console.warn("fillSolPriceMinutes: a candle's close was not a decimal; that minute is left unfilled");
      continue;
    }
    // A close of zero or less is not a rate — `evaluateSwap` refuses one, and
    // since migration 009 so does the column. Left absent for the same reason
    // an unreadable close is: this is a single statement for the whole range,
    // so one rejected row would take every good minute with it.
    if (value <= 0n) {
      console.warn("fillSolPriceMinutes: a candle's close was not a positive rate; that minute is left unfilled");
      continue;
    }
    const usd = formatDecimal(value);
    minutes.push(new Date(minute));
    rates.push(usd);
  }

  let filled = 0;
  if (minutes.length > 0) {
    // One statement for the whole range. `RETURNING minute` is what
    // distinguishes a minute this run wrote from one that was already there —
    // the count the workflow log prints, and the assertion idempotency is
    // checked with.
    const inserted = await query<{ minute: Date }>(
      `INSERT INTO sol_price (minute, usd)
       SELECT * FROM unnest($1::timestamptz[], $2::numeric[])
       ON CONFLICT (minute) DO NOTHING
       RETURNING minute`,
      [minutes, rates],
    );
    filled = inserted.length;
  }

  return {
    minutesRequested,
    filled,
    alreadyPresent: minutes.length - filled,
    fromFallback,
    missing: minutesRequested - minutes.length,
    requests,
    truncated: primary.truncated,
  };
}

/** What one {@link fillSolPriceMinutes} run did. Every field counts *minutes*, not rows returned by Binance. */
export type SolPriceFill = {
  /** Minutes in `[from, to]` inclusive. */
  minutesRequested: number;
  /** Minutes this run wrote a row for. */
  filled: number;
  /** Minutes a candle covered that already had a row — left exactly as they were. */
  alreadyPresent: number;
  /** Of the minutes covered, how many came from `SOLUSDT` because `SOLUSDC` had no candle. */
  fromFallback: number;
  /** Minutes no candle covered at all, from either book. */
  missing: number;
  /** Binance requests this run actually made. */
  requests: number;
  /** Whether the run stopped early — at its request cap, or at a failed request. */
  truncated: boolean;
};

/**
 * Pages `symbol`'s 1-minute closes over `[startMs, endMs]`, keyed by the
 * candle's own open minute.
 *
 * Stops and reports `truncated` rather than throwing on any failure, and
 * rather than looping past `maxRequests`: the caller is a cron step, and a
 * partially filled range is a strictly better outcome than a step that fails
 * and stops the parse behind it.
 */
async function fetchKlineCloses(
  symbol: string,
  startMs: number,
  endMs: number,
  fetchImpl: typeof fetch,
  maxRequests: number,
): Promise<{ closes: Map<number, string>; requests: number; truncated: boolean }> {
  const closes = new Map<number, string>();
  let cursor = startMs;
  let requests = 0;

  while (cursor <= endMs) {
    if (requests >= maxRequests) return { closes, requests, truncated: true };

    // `limit` is asked for explicitly rather than left to Binance's default of
    // 500: the page size is 1,000 and discovering that at runtime would mean
    // twice the requests for every range wider than 500 minutes.
    const wanted = Math.min(BINANCE_KLINE_PAGE_SIZE, Math.floor((endMs - cursor) / MINUTE_MS) + 1);
    const url =
      `${BINANCE_KLINES_URL}?symbol=${symbol}&interval=1m` +
      `&startTime=${cursor}&endTime=${endMs}&limit=${wanted}`;

    // Counted *before* the call, not after it: a request that throws is still
    // a request that was made, and a count that only tracks the successful
    // ones would report a run as cheaper than it was — which is the number the
    // request cap and the workflow log both exist to make visible.
    requests++;
    let body: unknown;
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        // Never the body: an error page is a third party's text.
        console.warn(`fillSolPriceMinutes: Binance answered ${response.status} for ${symbol}`);
        return { closes, requests, truncated: true };
      }
      body = await response.json();
    } catch {
      console.warn(`fillSolPriceMinutes: the Binance request for ${symbol} failed`);
      return { closes, requests, truncated: true };
    }

    if (!Array.isArray(body)) {
      console.warn(`fillSolPriceMinutes: Binance's ${symbol} response was not an array of candles`);
      return { closes, requests, truncated: true };
    }
    if (body.length === 0) break; // No candles left in the range: not a failure.

    // Advance past the newest candle this page actually produced, never by a
    // fixed page width: a page that came back short (or partly unreadable)
    // must not cause the minutes after it to be skipped.
    let newest = cursor;
    for (const candle of body) {
      if (!Array.isArray(candle)) continue;
      const openTime = candle[0];
      const close = candle[4];
      if (typeof openTime !== "number" || !Number.isFinite(openTime)) continue;
      if (typeof close !== "string") continue;
      const minute = minuteFloor(new Date(openTime));
      if (minute < startMs || minute > endMs) continue;
      closes.set(minute, close);
      if (minute > newest) newest = minute;
    }
    cursor = newest + MINUTE_MS;
  }

  return { closes, requests, truncated: false };
}

/**
 * The highest-liquidity solana-chain SOL/**USDC** pair DexScreener reports,
 * or `null`. Deliberately filters to the USDC quote *before* ranking by
 * liquidity: WSOL trades against many currencies, and a higher-liquidity
 * pair quoted in something else must not be preferred over a lower-liquidity
 * one that is actually the SOL/USDC pair the brief specifies — a stand-in
 * quoted in a different currency is not the same number.
 */
async function fetchSolUsdcPair(fetchImpl: typeof fetch): Promise<ParsedPair | null> {
  const pairs = await fetchDexscreenerPairs([WSOL_MINT], fetchImpl);
  if (pairs === null) {
    console.warn("refreshSolPrice: DexScreener request failed");
    return null;
  }
  const candidates = (pairs.get(WSOL_MINT) ?? []).filter((pair) => pair.quoteAddress === USDC_MINT);
  return pickBestPair(candidates);
}

// ---------------------------------------------------------------------------
// Token metadata and price
// ---------------------------------------------------------------------------

/**
 * Resolves and upserts `token` rows for every mint given, batching
 * DexScreener calls to {@link DEXSCREENER_BATCH_LIMIT} mints each.
 *
 * For each mint:
 * - DexScreener knows a pair → priced, staled or floored to `unpriced` by
 *   {@link deriveTokenUpdate}, per spec §4.6.
 * - DexScreener's response came back but plainly has no pair for this mint →
 *   `unpriced`, and Helius DAS is asked once for a symbol/name/decimals/image
 *   (only if `HELIUS_API_KEY` is configured; otherwise a documented no-op).
 *   Price fields are always `null` on this branch, unconditionally — DAS is
 *   never consulted for one.
 * - The DexScreener call for a mint's whole batch fails outright → that mint
 *   is left untouched. No Helius fallback is attempted: a transient
 *   DexScreener outage is not the same fact as "this mint has no pair", and
 *   treating it that way would both burn a DAS credit for nothing and could
 *   downgrade a perfectly good cached price to `unpriced` for a reason that
 *   has nothing to do with the mint.
 *
 * Returns the number of `token` rows written (mints touched, not mints
 * given — a deduplicated, chunk-skipped mint is not counted).
 */
export async function tokenMetadata(mints: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  const unique = [...new Set(mints)].filter((mint) => mint.length > 0);
  const minLiquidity = priceMinLiquidityUsd();
  let written = 0;

  for (let i = 0; i < unique.length; i += DEXSCREENER_BATCH_LIMIT) {
    const chunk = unique.slice(i, i + DEXSCREENER_BATCH_LIMIT);
    const found = await fetchDexscreenerPairs(chunk, fetchImpl);
    if (found === null) {
      console.warn("tokenMetadata: DexScreener request failed; leaving this chunk's cached rows untouched");
      continue;
    }

    for (const mint of chunk) {
      const pair = pickBestPair(found.get(mint) ?? []);
      if (pair) {
        await upsertToken(mint, deriveTokenUpdate(pair, minLiquidity));
        written++;
        continue;
      }

      // DexScreener answered and plainly does not know this mint: a
      // definitive, not a transient, negative. Helius DAS is asked once for
      // a symbol only; the price fields below are never sourced from it.
      const fallback = await heliusAssetMetadata(mint, fetchImpl);
      await upsertToken(mint, {
        symbol: fallback?.symbol ?? null,
        name: fallback?.name ?? null,
        decimals: fallback?.decimals ?? null,
        imageUrl: fallback?.imageUrl ?? null,
        priceUsd: null,
        priceSol: null,
        liquidityUsd: null,
        pairUrl: null,
        state: "unpriced",
      });
      written++;
    }
  }

  return written;
}

type TokenUpdate = {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  imageUrl: string | null;
  priceUsd: string | null;
  priceSol: string | null;
  liquidityUsd: string | null;
  pairUrl: string | null;
  state: PriceState;
};

/**
 * Turns one validated DexScreener pair into the fields `token` gets upserted
 * with, applying spec §4.6's state table:
 *
 * - liquidity below the floor (or unreadable) → `unpriced`, no price stored,
 *   regardless of how recently it traded. This is deliberately checked
 *   *before* recency: §4.6 calls the liquidity floor out on the `unpriced`
 *   row specifically, so a thin, illiquid pool that happens to be busy right
 *   now still renders no number.
 * - liquidity at or above the floor, not traded in the last 24h → `stale`,
 *   price still shown (with the "outdated" chip, which is a rendering
 *   concern outside this file).
 * - liquidity at or above the floor and traded in the last 24h → `priced`.
 *
 * A `priceUsd` this file cannot parse as a decimal downgrades the result to
 * `unpriced` even if liquidity and recency both looked fine — this file
 * would rather show nothing than something it could not itself validate.
 */
export function deriveTokenUpdate(pair: ParsedPair, minLiquidity: bigint): TokenUpdate {
  const base = { symbol: pair.symbol, name: pair.name, decimals: null, imageUrl: pair.imageUrl, pairUrl: pair.pairUrl };

  let liquidityScaled: bigint | null = null;
  try {
    liquidityScaled = parseDecimal(String(pair.liquidityUsdRaw));
  } catch {
    // Unreadable liquidity cannot be shown to clear the floor.
  }
  const liquidityUsd = liquidityScaled === null ? null : formatDecimal(liquidityScaled);

  if (liquidityScaled === null || liquidityScaled < minLiquidity) {
    return { ...base, priceUsd: null, priceSol: null, liquidityUsd, state: "unpriced" };
  }

  let priceUsd: string;
  try {
    priceUsd = formatDecimal(parseDecimal(pair.priceUsdRaw));
  } catch {
    return { ...base, priceUsd: null, priceSol: null, liquidityUsd, state: "unpriced" };
  }

  // priceNative is only the SOL price when the pair is actually quoted in
  // SOL/WSOL; anything else (typically USDC) prices a different currency and
  // must not be stored as if it were price_sol.
  let priceSol: string | null = null;
  if (pair.priceNativeRaw !== null && pair.quoteAddress === WSOL_MINT) {
    try {
      priceSol = formatDecimal(parseDecimal(pair.priceNativeRaw));
    } catch {
      priceSol = null; // price_usd alone is still enough to render; this is optional
    }
  }

  return { ...base, priceUsd, priceSol, liquidityUsd, state: pair.tradedRecently ? "priced" : "stale" };
}

async function upsertToken(mint: string, fields: TokenUpdate): Promise<void> {
  // symbol/name/decimals/image_url use COALESCE with the existing row: a
  // response that has a price but happens to omit an image (common —
  // DexScreener does not always carry `info.imageUrl`) must not blank out a
  // real image this project already learned on a previous call. The price
  // fields never COALESCE: this call is only ever made with a definitive
  // answer from a source (see tokenMetadata's docs), so what it says is what
  // gets written, including turning a stale price back to null.
  //
  // **`decimals` is inserted as-is, and NULL means unknown.** It used to be
  // `COALESCE($4, 9)` against a `NOT NULL DEFAULT 9` column, and DexScreener's
  // pair response does not state a mint's decimals at all — so
  // `deriveTokenUpdate` passes NULL every time and every DexScreener-sourced
  // token was stored as 9 whatever it really is. Nothing reads this column for
  // money (the parser takes decimals from the payload's own balance change),
  // so it was a wrong value in a column rather than a wrong number anywhere;
  // it is stopped here rather than after something starts believing it. Only
  // the Helius DAS fallback states a real figure, and it still writes one.
  // See migration 008.
  await query(
    `INSERT INTO token (mint, symbol, name, decimals, image_url, price_usd, price_sol, liquidity_usd, price_state, pair_url, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (chain, mint) DO UPDATE SET
       symbol        = COALESCE(EXCLUDED.symbol, token.symbol),
       name          = COALESCE(EXCLUDED.name, token.name),
       decimals      = COALESCE($4, token.decimals),
       image_url     = COALESCE(EXCLUDED.image_url, token.image_url),
       price_usd     = EXCLUDED.price_usd,
       price_sol     = EXCLUDED.price_sol,
       liquidity_usd = EXCLUDED.liquidity_usd,
       price_state   = EXCLUDED.price_state,
       pair_url      = EXCLUDED.pair_url,
       updated_at    = now()`,
    [
      mint,
      fields.symbol,
      fields.name,
      fields.decimals,
      fields.imageUrl,
      fields.priceUsd,
      fields.priceSol,
      fields.liquidityUsd,
      fields.state,
      fields.pairUrl,
    ],
  );
}

// ---------------------------------------------------------------------------
// DexScreener client
// ---------------------------------------------------------------------------

/** One DexScreener pair, validated down to the fields this file reads. */
export type ParsedPair = {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  /** Decimal string exactly as DexScreener sent it — not yet run through parseDecimal. */
  priceUsdRaw: string;
  priceNativeRaw: string | null;
  quoteAddress: string;
  /** The float DexScreener itself reports. Comparison and display only — see the file header. */
  liquidityUsdRaw: number;
  pairUrl: string | null;
  tradedRecently: boolean;
};

/**
 * Validates one raw pair object from DexScreener's response. Returns `null`
 * for anything this file cannot read with confidence — a missing price, an
 * unreadable liquidity figure, a non-solana chain — rather than guessing:
 * one bad pair among many must not crash the batch, and a mint whose only
 * pair fails validation is correctly treated the same as a mint with no pair
 * at all (it falls through to the Helius-fallback branch in `tokenMetadata`).
 *
 * Only pairs where the queried mint is the **base** token are accepted.
 * DexScreener's `priceUsd`/`priceNative` price the base token, and the
 * queried mint is conventionally the base side whenever it is paired against
 * an established currency (SOL, USDC) — which is every pairing this project
 * prices. A mint that only appears as a pair's *quote* token is skipped
 * rather than having its price derived by inversion, which this file does
 * not attempt.
 */
export function tryParsePair(raw: unknown): ParsedPair | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.chainId !== "solana") return null;

  const base = record.baseToken;
  if (typeof base !== "object" || base === null) return null;
  const baseRecord = base as Record<string, unknown>;
  const mint = baseRecord.address;
  if (typeof mint !== "string" || mint.length === 0) return null;

  const priceUsdRaw = record.priceUsd;
  if (typeof priceUsdRaw !== "string" || priceUsdRaw.length === 0) return null;

  const liquidity = record.liquidity;
  const liquidityRaw =
    typeof liquidity === "object" && liquidity !== null ? (liquidity as Record<string, unknown>).usd : undefined;
  if (typeof liquidityRaw !== "number" || !Number.isFinite(liquidityRaw) || liquidityRaw < 0) return null;

  const quote = record.quoteToken;
  const quoteAddr =
    typeof quote === "object" && quote !== null ? (quote as Record<string, unknown>).address : null;

  const txns = record.txns;
  const h24 = typeof txns === "object" && txns !== null ? (txns as Record<string, unknown>).h24 : undefined;
  let tradedRecently = false;
  if (typeof h24 === "object" && h24 !== null) {
    const h24Record = h24 as Record<string, unknown>;
    const buys = typeof h24Record.buys === "number" ? h24Record.buys : 0;
    const sells = typeof h24Record.sells === "number" ? h24Record.sells : 0;
    tradedRecently = buys + sells > 0;
  }

  const symbolRaw = baseRecord.symbol;
  const nameRaw = baseRecord.name;
  const symbol =
    typeof symbolRaw === "string" && symbolRaw.trim().length > 0 ? symbolRaw.trim().slice(0, MAX_SYMBOL_LENGTH) : null;
  const name =
    typeof nameRaw === "string" && nameRaw.trim().length > 0 ? nameRaw.trim().slice(0, MAX_NAME_LENGTH) : null;

  const info = record.info;
  const imageRaw = typeof info === "object" && info !== null ? (info as Record<string, unknown>).imageUrl : undefined;
  const imageUrl = typeof imageRaw === "string" && imageRaw.startsWith("https://") ? imageRaw : null;

  const priceNativeRaw = typeof record.priceNative === "string" ? record.priceNative : null;
  const pairUrl = typeof record.url === "string" ? record.url : null;

  return {
    mint,
    symbol,
    name,
    imageUrl,
    priceUsdRaw,
    priceNativeRaw,
    quoteAddress: typeof quoteAddr === "string" ? quoteAddr : "",
    liquidityUsdRaw: liquidityRaw,
    pairUrl,
    tradedRecently,
  };
}

/**
 * Calls DexScreener's `/tokens/{mints}` for up to {@link DEXSCREENER_BATCH_LIMIT}
 * mints and returns every valid pair found, grouped by the queried mint it
 * belongs to. Callers pick which pair they want (`pickBestPair`, optionally
 * filtered) — this function does not decide that, because different callers
 * want different things: `tokenMetadata` wants the highest-liquidity pair
 * regardless of quote currency, `refreshSolPrice` wants specifically the
 * SOL/**USDC** one even when a higher-liquidity SOL/other pair exists.
 *
 * Returns `null` on any failure to get a trustworthy answer at all — the
 * request itself, a non-OK status, or unparseable JSON — which callers must
 * treat as "unknown for now", never as "confirmed absent". A mint simply
 * missing from a *successful* response's `pairs` (including a response
 * carrying `pairs: null`) is a real, distinguishable outcome: it comes back
 * as an empty map, not as `null`.
 */
async function fetchDexscreenerPairs(
  mints: string[],
  fetchImpl: typeof fetch,
): Promise<Map<string, ParsedPair[]> | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${DEXSCREENER_TOKENS_URL}${mints.join(",")}`);
  } catch {
    console.warn("fetchDexscreenerPairs: request failed");
    return null;
  }
  if (!response.ok) {
    console.warn(`fetchDexscreenerPairs: non-OK response (${response.status})`);
    return null;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    console.warn("fetchDexscreenerPairs: could not parse the response body");
    return null;
  }
  if (typeof json !== "object" || json === null || !("pairs" in json)) return null;

  const pairs = (json as { pairs: unknown }).pairs;
  const byMint = new Map<string, ParsedPair[]>();
  if (pairs === null) return byMint; // a valid, empty answer: no pair for any queried mint
  if (!Array.isArray(pairs)) return null;

  const targets = new Set(mints);
  for (const raw of pairs) {
    const parsed = tryParsePair(raw);
    if (!parsed || !targets.has(parsed.mint)) continue;
    const existing = byMint.get(parsed.mint);
    if (existing) existing.push(parsed);
    else byMint.set(parsed.mint, [parsed]);
  }
  return byMint;
}

/** The highest-liquidity pair in `pairs`, or `null` if the list is empty. */
function pickBestPair(pairs: ParsedPair[]): ParsedPair | null {
  let best: ParsedPair | null = null;
  for (const pair of pairs) {
    if (best === null || pair.liquidityUsdRaw > best.liquidityUsdRaw) best = pair;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Helius DAS fallback (symbol only — never a price; see the file header)
// ---------------------------------------------------------------------------

export type HeliusMetadata = {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  imageUrl: string | null;
};

/**
 * Extracts a symbol/name/decimals/image from a Helius `getAsset` response.
 *
 * **Deliberately never reads `token_info.price_info`**, even though DAS can
 * return one: spec §5.7 forbids Helius as a price source outright, not
 * conditionally on cost, so a price arriving on this response is not an
 * opportunity, it is a field this function must not look at. This is the
 * property the fallback's own test proves directly, with a fixture that
 * includes a `price_info` block and asserts the result carries no price at
 * all.
 *
 * Returns `null` if every field comes back unreadable — no reason to write a
 * row this call learned nothing from.
 */
export function parseHeliusAsset(json: unknown): HeliusMetadata | null {
  if (typeof json !== "object" || json === null) return null;
  const result = (json as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;

  const content = record.content;
  const metadata =
    typeof content === "object" && content !== null ? (content as Record<string, unknown>).metadata : undefined;
  const symbolRaw = typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>).symbol : undefined;
  const nameRaw = typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>).name : undefined;
  const symbol =
    typeof symbolRaw === "string" && symbolRaw.trim().length > 0 ? symbolRaw.trim().slice(0, MAX_SYMBOL_LENGTH) : null;
  const name =
    typeof nameRaw === "string" && nameRaw.trim().length > 0 ? nameRaw.trim().slice(0, MAX_NAME_LENGTH) : null;

  const links = typeof content === "object" && content !== null ? (content as Record<string, unknown>).links : undefined;
  const imageRaw = typeof links === "object" && links !== null ? (links as Record<string, unknown>).image : undefined;
  const imageUrl = typeof imageRaw === "string" && imageRaw.startsWith("https://") ? imageRaw : null;

  const tokenInfo = record.token_info;
  const decimalsRaw =
    typeof tokenInfo === "object" && tokenInfo !== null ? (tokenInfo as Record<string, unknown>).decimals : undefined;
  const decimals =
    typeof decimalsRaw === "number" && Number.isInteger(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= MAX_DECIMALS
      ? decimalsRaw
      : null;

  if (symbol === null && name === null && decimals === null && imageUrl === null) return null;
  return { symbol, name, decimals, imageUrl };
}

/**
 * Asks Helius DAS for one mint's metadata. Returns `null` — never throws —
 * when `HELIUS_API_KEY` is not configured, on any request failure, on a
 * non-OK response, or when the response cannot be parsed.
 *
 * The no-key branch returns `null` and is exercised directly by this file's
 * test suite. The request-shape and response-parsing branches are exercised
 * against fixtures with a stubbed key, never against a live DAS call — the
 * suite's per-file network guard sees to that, and a DAS call costs 10
 * credits every time it is made.
 *
 * This comment used to assert that the key was absent here and that the
 * no-key branch was therefore what production ran. Both halves were wrong: a
 * key is present in this working tree, and one machine's environment says
 * nothing about production's. Which branch runs where is a deployment fact,
 * not a fact this file can know.
 *
 * Never logs the caught error object on a request failure: a `fetch`
 * rejection's `message` or `cause` can carry the request URL, and the URL
 * carries the API key.
 */
/**
 * Cuántas veces Helius rechazó **la credencial** en este proceso.
 *
 * Un contador de módulo y no un valor devuelto: `tokenMetadata` chunkea adentro
 * y hacer subir el dato por tres capas para un caso de error habría cambiado
 * tres firmas. Se lee una vez por corrida, al final, que es cuando importa.
 */
let heliusRejections = 0;

/** Los rechazos de credencial desde que arrancó el proceso. */
export function heliusCredentialRejections(): number {
  return heliusRejections;
}

async function heliusAssetMetadata(mint: string, fetchImpl: typeof fetch): Promise<HeliusMetadata | null> {
  const apiKey = process.env.HELIUS_API_KEY?.trim();
  if (!apiKey) return null;

  let response: Response;
  try {
    response = await fetchImpl(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "kolscanhispano-prices", method: "getAsset", params: { id: mint } }),
    });
  } catch {
    console.warn("heliusAssetMetadata: request failed");
    return null;
  }
  if (!response.ok) {
    /*
      **Un 401 no es "este mint no existe": es "la clave no sirve".**

      Se contaban igual, y el resultado fue que el paso del cron informó
      `refreshed 29 of 29` mientras las 29 llamadas devolvían 401 — la clave de
      CI llevaba días vencida detrás de un tilde verde (2026-09-07). `written`
      cuenta filas escritas, no respuestas de Helius, así que no podía verlo.

      Se separa el fallo de autenticación del resto para que el llamador pueda
      distinguir "Helius no conoce este token" de "Helius no nos conoce a
      nosotros".
    */
    if (response.status === 401 || response.status === 403) heliusRejections += 1;
    console.warn(`heliusAssetMetadata: non-OK response (${response.status})`);
    return null;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    console.warn("heliusAssetMetadata: could not parse the response body");
    return null;
  }
  return parseHeliusAsset(json);
}

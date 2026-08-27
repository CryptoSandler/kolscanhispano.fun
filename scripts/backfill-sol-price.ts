/**
 * Cron entry point for `fillSolPriceMinutes` (see `../src/lib/prices.ts`):
 * gives `sol_price` a row for every minute in a bounded window, from
 * Binance's public 1-minute klines.
 *
 * Loads `.env.local` for a developer running this by hand; in CI the workflow
 * (`.github/workflows/parse-pending.yml`, **first** step) supplies
 * `DATABASE_URL` directly as job `env`, and `.env.local` does not exist there.
 * `DATABASE_URL` is the only secret this script's import graph can use —
 * env.ts, lock.ts, lock-key.ts, db.ts, prices.ts, decimal.ts and mints.ts,
 * with no wallets.ts on it, so neither `WALLET_*` key is readable by anything
 * it runs.
 *
 * **It runs before the parse, and that is the property, not the arrangement.**
 * `parsePending` refuses a stablecoin-quoted swap whose block minute has no
 * `sol_price` row (`unsupported_quote_no_rate`) and records `parse_error`,
 * which takes the row *out* of the pending queue — and nothing in this
 * repository clears that column, so the refusal is permanent in practice. A
 * fill that ran after the parse would write the very minute the parse just
 * declined, one cycle too late, for a row that is never looked at again.
 * Before the parse, the minutes a run is about to read already have rates.
 *
 * **The window, chosen rather than defaulted into.** {@link DEFAULT_MINUTES}
 * is 180. What it has to cover is not one cron period but the whole spread
 * between a block and the run that parses it: the 5-minute schedule, GitHub's
 * best-effort scheduler running late under load, the lag between a block and
 * Helius delivering its webhook, and — the widest term — `parsePending`'s own
 * `LIMIT 100`, which makes a backlog drain at 100 payloads per run and leaves
 * the rows at the front of it arbitrarily old. 180 minutes is ~36 cron
 * periods, still one Binance request (the page size is 1,000 minutes), and
 * still one `INSERT`. It is a margin, not a measurement; a backlog deeper than
 * three hours needs an explicit `--from`, which is what the flag is for.
 *
 * **The current minute is deliberately outside every window.** Binance's
 * candle for a minute still in progress carries a provisional close that keeps
 * moving until the minute ends, and `ON CONFLICT DO NOTHING` would freeze
 * whichever value this run happened to see. `refreshSolPrice` — which is left
 * exactly where it is, in `backfill-prices.ts`, a second source with a
 * different failure mode — is what covers the current minute, from
 * DexScreener, as a spot price.
 *
 * Takes the `withLock` advisory lock, under its own name, so a scheduled run
 * and a manual `workflow_dispatch` that overlap cannot both page Binance for
 * the same window. The function passed to `withLock` is nothing but pool
 * queries and one HTTP call, which is exactly the shape `lock.ts`'s docstring
 * requires: `withLock` holds its lock on its own dedicated connection
 * precisely so this call is free to use the shared pool without deadlocking
 * against it.
 *
 * "Did nothing" (another run holds the lock) and "failed" are kept
 * distinguishable in both the exit code and the printed line. Neither path
 * ever prints a secret: the only values that reach the console are counts and
 * two ISO minutes.
 */
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { withLock } from "../src/lib/lock";
import { DEFAULT_KLINE_REQUEST_CAP, fillSolPriceMinutes, type SolPriceFill } from "../src/lib/prices";

/** See the header: ~36 cron periods of margin, one Binance request, one INSERT. */
const DEFAULT_MINUTES = 180;

const MINUTE_MS = 60_000;

export type BackfillSolPriceOptions = {
  fetchImpl?: typeof fetch;
  /** Inclusive start. Defaults to `to` minus `minutes - 1`. */
  from?: Date;
  /** Inclusive end, always clamped to the last *closed* minute. Defaults to it. */
  to?: Date;
  /** Width of the default window, in minutes. Ignored when `from` is given. */
  minutes?: number;
  maxRequests?: number;
  /** Injectable only so a test can pin the window; production never passes it. */
  now?: Date;
};

export type BackfillSolPriceResult = SolPriceFill & { from: Date; to: Date };

function minuteFloor(at: Date): Date {
  return new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);
}

/**
 * The `[from, to]` this run will fill, in whole minutes.
 *
 * `to` is clamped to the last closed minute **even when given explicitly** —
 * see the header for why the in-progress minute may not be written. Exported
 * so the clamp is testable on its own rather than only through a fill.
 */
export function resolveWindow(
  options: Pick<BackfillSolPriceOptions, "from" | "to" | "minutes">,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const lastClosed = new Date(minuteFloor(now).getTime() - MINUTE_MS);
  const requestedTo = options.to === undefined ? lastClosed : minuteFloor(options.to);
  const to = requestedTo.getTime() > lastClosed.getTime() ? lastClosed : requestedTo;
  const width = options.minutes ?? DEFAULT_MINUTES;
  const from =
    options.from === undefined ? new Date(to.getTime() - (width - 1) * MINUTE_MS) : minuteFloor(options.from);
  return { from, to };
}

export async function backfillSolPrice(
  options: BackfillSolPriceOptions = {},
): Promise<BackfillSolPriceResult> {
  const { fetchImpl = fetch, maxRequests = DEFAULT_KLINE_REQUEST_CAP, now = new Date() } = options;
  const { from, to } = resolveWindow(options, now);
  const fill = await fillSolPriceMinutes(from, to, fetchImpl, maxRequests);
  return { ...fill, from, to };
}

export type Args = {
  from?: Date;
  to?: Date;
  minutes: number;
  maxRequests: number;
};

/**
 * Reads `--from`, `--to`, `--minutes` and `--max-requests`.
 *
 * Every unreadable value **throws** rather than falling back to a default. A
 * typo'd `--from` that quietly became "the last 180 minutes" would fill a
 * range nobody asked for and report success for it — and the operator running
 * a one-off historical backfill is precisely the person who would not notice.
 */
export function parseArgs(argv: string[]): Args {
  const args: Args = { minutes: DEFAULT_MINUTES, maxRequests: DEFAULT_KLINE_REQUEST_CAP };

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);

    switch (flag) {
      case "--from":
      case "--to": {
        const at = new Date(value);
        if (Number.isNaN(at.getTime())) throw new Error(`${flag} is not a readable date: pass an ISO instant`);
        if (flag === "--from") args.from = at;
        else args.to = at;
        break;
      }
      case "--minutes": {
        const width = Number(value);
        if (!Number.isInteger(width) || width < 1) throw new Error("--minutes must be a positive whole number");
        args.minutes = width;
        break;
      }
      case "--max-requests": {
        const cap = Number(value);
        if (!Number.isInteger(cap) || cap < 1) throw new Error("--max-requests must be a positive whole number");
        args.maxRequests = cap;
        break;
      }
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }

  return args;
}

/**
 * Runs one fill and resolves to the process exit code it implies. Exported
 * (rather than folded into the bottom-of-file shell) so the test suite can
 * call it in-process, exactly as production runs it. `process.exit` is
 * deliberately never called in here: a test importing this module runs inside
 * the same worker as every other test in the file.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    const result = await withLock("backfill-sol-price", () => backfillSolPrice(args));
    if (result === null) {
      console.log("backfill-sol-price: another run holds the lock; did nothing");
      return 0;
    }

    console.log(
      `backfill-sol-price: ${result.from.toISOString()} .. ${result.to.toISOString()} ` +
        `(${result.minutesRequested} minute(s)) -- filled ${result.filled} minute(s), ` +
        `${result.alreadyPresent} already had a rate, ${result.missing} had no candle` +
        (result.fromFallback > 0 ? `, ${result.fromFallback} from the USDT book` : "") +
        `, ${result.requests} Binance request(s)` +
        (result.truncated ? " (stopped early: request cap or a failed request)" : ""),
    );
    return 0;
  } catch (error) {
    console.error(
      `backfill-sol-price: failed -- ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

// Only when this file is the process entry point, not when a test imports it.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}

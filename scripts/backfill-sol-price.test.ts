/**
 * The properties R1 states for the per-minute `sol_price` fill, each written
 * so it fails for the reason it names.
 *
 * The first one is the whole task: a stablecoin-quoted swap whose block minute
 * has no `sol_price` row is refused `unsupported_quote_no_rate` — and the same
 * swap, with the fill run *first*, becomes a trade with a real cost basis.
 * Both halves are asserted in one test so neither can drift from the other.
 *
 * **No network.** `vitest.env.ts` installs a `fetch` that throws naming the
 * host (`src/lib/network-guard.ts`), and every case here passes an injected
 * `fetchImpl` built from `src/lib/fixtures/binance.ts`. Not one test reaches
 * `api.binance.com`; the one case that deliberately does not inject a fetch
 * asserts the guard's own failure path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../src/lib/db";
import { buildKlineSeries } from "../src/lib/fixtures/binance";
import { buildObservedSwapPayload } from "../src/lib/fixtures/swap";
import { inventAddress } from "../src/lib/ids";
import { USDC_MINT } from "../src/lib/mints";
import { parsePending } from "../src/lib/parse-swap";
import { storeRawTx } from "../src/lib/raw-tx";
import { addWallet } from "../src/lib/wallets";
import { backfillSolPrice, main, parseArgs, resolveWindow } from "./backfill-sol-price";

/** A `fetch` that answers every klines call with `candles`, and records the URLs. */
function klineFetch(candles: unknown[][]): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const start = Number(new URL(url).searchParams.get("startTime"));
    const end = Number(new URL(url).searchParams.get("endTime"));
    const limit = Number(new URL(url).searchParams.get("limit") ?? 1000);
    const page = candles
      .filter((c) => Number(c[0]) >= start && (Number.isNaN(end) || Number(c[0]) <= end))
      .slice(0, limit);
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fn, calls };
}

async function makeKol(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    "INSERT INTO kol (id, slug, display_name, x_handle, status) VALUES ($1,$2,$3,$4,'approved')",
    [id, id, id, id],
  );
  return id;
}

async function rateFor(minute: Date): Promise<string | undefined> {
  const [row] = await query<{ usd: string }>("SELECT usd FROM sol_price WHERE minute = $1", [minute]);
  return row?.usd;
}

// ---------------------------------------------------------------------------
// The task, end to end
// ---------------------------------------------------------------------------

describe("a stablecoin-quoted swap at a minute the fill covers", () => {
  const minute = new Date("2026-08-25T12:03:00.000Z");
  let kolId: string;
  let walletAddress: string;
  let tokenMint: string;

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price CASCADE");
    kolId = await makeKol();
    walletAddress = inventAddress();
    await addWallet(kolId, walletAddress);
    tokenMint = inventAddress();
  });

  /** A USDC-quoted buy: 2 tokens in, 231.71 USDC out, gas the only native movement. */
  async function storeUsdcQuotedBuy(): Promise<void> {
    const payload = buildObservedSwapPayload({
      wallet: walletAddress,
      nativeChangeLamports: -5_000,
      feeLamports: 5_000,
      isFeePayer: true,
      timestamp: Math.floor(minute.getTime() / 1000),
      slot: 777,
      legs: [
        { mint: tokenMint, decimals: 6, rawTokenAmount: "2000000" },
        { mint: USDC_MINT, decimals: 6, rawTokenAmount: "-231710000" },
      ],
    });
    await storeRawTx({ signature: payload.signature, blockTime: minute, slot: 777, payload, source: "webhook" });
  }

  it("is refused with no rate for its minute, and becomes a trade once the fill writes one", async () => {
    // Half one: today's behaviour, and the reason this task exists. Nothing
    // has written 12:03, so `solUsdForMinute` returns null and the swap is
    // declined — requeueably, `parsed_at` still NULL.
    await storeUsdcQuotedBuy();
    await parsePending();

    expect(await query("SELECT id FROM trade")).toHaveLength(0);
    const [refused] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(refused.parse_error).toBe("unsupported_quote_no_rate");
    expect(refused.parsed_at).toBeNull();

    // Half two: the same swap, on a fresh row, with the fill run *before* the
    // parse — the ordering `.github/workflows/parse-pending.yml` now uses.
    await query("TRUNCATE raw_tx, trade, position CASCADE");
    await storeUsdcQuotedBuy();

    const { fn } = klineFetch(buildKlineSeries(new Date("2026-08-25T12:00:00.000Z"), 10, () => "231.71"));
    const fill = await backfillSolPrice({
      fetchImpl: fn,
      from: new Date("2026-08-25T12:00:00.000Z"),
      to: new Date("2026-08-25T12:09:00.000Z"),
    });
    expect(fill.filled).toBe(10);

    await parsePending();

    const [trade] = await query<Record<string, unknown>>("SELECT * FROM trade");
    expect(trade).toBeDefined();
    expect(trade.mint).toBe(tokenMint);
    expect(trade.side).toBe("buy");
    // The rate became the cost basis, not a display figure: 231.71 USDC at
    // 231.71 USD/SOL is exactly 1 SOL, and `price_sol` follows from it.
    expect(trade.sol_amount).toBe("1");
    expect(trade.price_sol).toBe("0.5");
    expect(trade.sol_usd).toBe("231.71");
    expect(trade.usd_amount).toBe("231.71");

    const [parsed] = await query<{ parsed_at: Date | null; parse_error: string | null }>(
      "SELECT parsed_at, parse_error FROM raw_tx",
    );
    expect(parsed.parse_error).toBeNull();
    expect(parsed.parsed_at).not.toBeNull();
  });

  it("uses the block's own minute, not a neighbouring one", async () => {
    // The mutation this file is written to kill: a writer off by one minute
    // still fills the range, still reports the same counts, and hands
    // `solUsdForMinute` either nothing or the wrong number. Each minute gets
    // a distinct close so a shift of one is a *value* mismatch, not just a
    // count.
    await storeUsdcQuotedBuy();
    const from = new Date("2026-08-25T12:00:00.000Z");
    const { fn } = klineFetch(buildKlineSeries(from, 10, (i) => String(200 + i)));

    await backfillSolPrice({ fetchImpl: fn, from, to: new Date("2026-08-25T12:09:00.000Z") });

    expect(await rateFor(new Date("2026-08-25T12:02:00.000Z"))).toBe("202");
    expect(await rateFor(minute)).toBe("203");
    expect(await rateFor(new Date("2026-08-25T12:04:00.000Z"))).toBe("204");

    await parsePending();
    const [trade] = await query<Record<string, unknown>>("SELECT * FROM trade");
    expect(trade.sol_usd).toBe("203");
  });
});

// ---------------------------------------------------------------------------
// The window, and the open minute
// ---------------------------------------------------------------------------

describe("resolveWindow", () => {
  const now = new Date("2026-08-25T12:07:42.000Z");

  it("defaults to the last N closed minutes, ending one minute before now", () => {
    // The current minute is deliberately excluded: Binance's candle for a
    // minute still in progress carries a provisional close that keeps moving,
    // and `ON CONFLICT DO NOTHING` would freeze whichever value this run
    // happened to see. `refreshSolPrice` is what covers the current minute.
    const { from, to } = resolveWindow({ minutes: 5 }, now);
    expect(to.toISOString()).toBe("2026-08-25T12:06:00.000Z");
    expect(from.toISOString()).toBe("2026-08-25T12:02:00.000Z");
  });

  it("clamps an explicit --to to the last closed minute", () => {
    const { to } = resolveWindow({ to: new Date("2026-08-25T12:59:00.000Z"), minutes: 5 }, now);
    expect(to.toISOString()).toBe("2026-08-25T12:06:00.000Z");
  });

  it("honours an explicit --from and --to inside the closed range", () => {
    const { from, to } = resolveWindow(
      { from: new Date("2026-08-25T11:00:00.000Z"), to: new Date("2026-08-25T11:30:00.000Z"), minutes: 5 },
      now,
    );
    expect(from.toISOString()).toBe("2026-08-25T11:00:00.000Z");
    expect(to.toISOString()).toBe("2026-08-25T11:30:00.000Z");
  });
});

describe("parseArgs", () => {
  it("reads --from, --to, --minutes and --max-requests", () => {
    const parsed = parseArgs([
      "--from", "2026-08-25T11:00:00Z",
      "--to", "2026-08-25T11:30:00Z",
      "--minutes", "45",
      "--max-requests", "2",
    ]);
    expect(parsed.from?.toISOString()).toBe("2026-08-25T11:00:00.000Z");
    expect(parsed.to?.toISOString()).toBe("2026-08-25T11:30:00.000Z");
    expect(parsed.minutes).toBe(45);
    expect(parsed.maxRequests).toBe(2);
  });

  it("defaults the window and the cap when given nothing", () => {
    const parsed = parseArgs([]);
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toBeUndefined();
    expect(parsed.minutes).toBeGreaterThan(0);
    expect(parsed.maxRequests).toBeGreaterThan(0);
  });

  it("refuses a value it cannot read rather than silently defaulting", () => {
    // A typo'd `--from` that quietly became "the last 180 minutes" would
    // backfill the wrong range and report success for it.
    expect(() => parseArgs(["--from", "yesterday"])).toThrow(/--from/);
    expect(() => parseArgs(["--minutes", "0"])).toThrow(/--minutes/);
    expect(() => parseArgs(["--max-requests", "-1"])).toThrow(/--max-requests/);
  });
});

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

describe("scripts/backfill-sol-price.ts: main()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await query("TRUNCATE sol_price CASCADE");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("says how many minutes it filled against how many were already there, and exits 0", async () => {
    // The unmocked `fetch` main() uses is the network guard, which throws;
    // `fillSolPriceMinutes` swallows that into "wrote nothing", the same shape
    // a real Binance outage takes, and the run still exits 0 rather than
    // standing between a webhook and a trade.
    const code = await main([]);

    expect(code).toBe(0);
    const line = logSpy.mock.calls.flat().join("\n");
    expect(line).toContain("backfill-sol-price:");
    expect(line).toMatch(/filled 0 minute\(s\)/);
    expect(line).toMatch(/already had a rate/);
    for (const secret of [process.env.DATABASE_URL, process.env.WALLET_ENC_KEY, process.env.WALLET_HMAC_KEY]) {
      if (secret) expect(line).not.toContain(secret);
    }
  });

  it("exits non-zero when the work throws, distinguishably from having done nothing", async () => {
    const spy = vi
      .spyOn(await import("../src/lib/prices"), "fillSolPriceMinutes")
      .mockRejectedValue(new Error("neon is down"));
    try {
      const code = await main([]);
      expect(code).toBe(1);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("backfill-sol-price: failed");
      expect(logSpy.mock.calls.flat().join("\n")).not.toContain("did nothing");
    } finally {
      spy.mockRestore();
    }
  });

  it("exits non-zero on an unreadable argument instead of backfilling the wrong range", async () => {
    const code = await main(["--minutes", "not-a-number"]);
    expect(code).toBe(1);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("backfill-sol-price: failed");
    expect(await query("SELECT minute FROM sol_price")).toHaveLength(0);
  });
});

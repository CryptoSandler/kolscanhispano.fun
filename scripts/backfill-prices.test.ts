/**
 * The properties Task 5 states for the backfill, each written so it fails for
 * the reason it names.
 *
 * - A trade a rate covers gets `usd_amount`, `sol_usd` and `price_usd`, and
 *   the numbers are the exact product, not a float's rendering of it.
 * - A trade no rate covers keeps NULL — **never `0`** — and is stamped
 *   `priced_at`, which is what keeps "we looked and there was none" apart
 *   from "nothing has ever looked".
 * - Every filled trade's position is marked dirty; a run that fills nothing
 *   marks nothing.
 * - Re-running is idempotent: the second run fills nothing, dirties nothing,
 *   and does not disturb the figures the first run wrote.
 * - The rate used is the one for the trade's own minute, not the newest one
 *   in the table.
 *
 * `fetch` is mocked in every case: the harness's network guard throws on a
 * real call (see src/lib/network-guard.ts), and a backfill that reached
 * DexScreener from a test would also be spending a third party's quota on
 * every `vitest run`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../src/lib/db";
import { buildDexPair, buildDexResponse } from "../src/lib/fixtures/dexscreener";
import { inventAddress, inventSignature } from "../src/lib/ids";
import { USDC_MINT, WSOL_MINT } from "../src/lib/mints";
import { aadFor, encrypt, blindIndex } from "../src/lib/crypto";
import { addWallet } from "../src/lib/wallets";
import { backfillPrices, main } from "./backfill-prices";

/** A `fetch` that always answers with one SOL/USDC pair at `priceUsd`. */
function dexFetch(priceUsd: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify(
        buildDexResponse([
          buildDexPair({ mint: WSOL_MINT, quoteMint: USDC_MINT, priceUsd, liquidityUsd: 5_000_000 }),
        ]),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

/** A `fetch` that fails, so `refreshSolPrice` writes nothing and the run is driven purely by stored rates. */
const offlineFetch = (async () => {
  throw new TypeError("network down");
}) as typeof fetch;

async function makeKol(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    "INSERT INTO kol (id, slug, display_name, x_handle, status) VALUES ($1,$2,$3,$4,'approved')",
    [id, id, id, id],
  );
  return id;
}

type TradeInput = {
  kolId: string;
  walletId: string;
  mint: string;
  blockTime: Date;
  solAmount?: string;
  priceSol?: string | null;
  usdAmount?: string | null;
};

/**
 * Inserts one trade directly, with `usd_amount` NULL by default — the exact
 * state `insertTrade` leaves behind when `sol_price` has no row covering the
 * block. Going through `parsePending` here would test the parser instead of
 * the backfill, and would make it impossible to construct the "written before
 * anything stamped `priced_at`" row that every existing row in the database
 * actually is.
 */
async function insertUnpricedTrade(input: TradeInput): Promise<string> {
  const id = crypto.randomUUID();
  const signature = inventSignature();
  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                        mint, side, token_amount, sol_amount, usd_amount, price_sol, fee_sol,
                        block_time, priced_at)
     VALUES ($1,$2,$3,0,$4,$5,$6,'buy','2',$7,$8,$9,'0',$10,NULL)`,
    [
      id,
      blindIndex(signature, "signature"),
      encrypt(signature, aadFor("trade", "signature", id)),
      input.kolId,
      input.walletId,
      input.mint,
      input.solAmount ?? "1",
      input.usdAmount ?? null,
      input.priceSol === undefined ? "0.5" : input.priceSol,
      input.blockTime,
    ],
  );
  return id;
}

async function tradeRow(id: string): Promise<Record<string, unknown>> {
  const [row] = await query<Record<string, unknown>>("SELECT * FROM trade WHERE id = $1", [id]);
  return row;
}

describe("backfillPrices", () => {
  let kolId: string;
  let walletId: string;
  let mint: string;

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price, token CASCADE");
    kolId = await makeKol();
    walletId = await addWallet(kolId, inventAddress());
    mint = inventAddress();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fills a trade whose minute a stored rate covers, exactly", async () => {
    const blockTime = new Date("2026-08-01T12:00:30.000Z");
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '231.71')", [
      new Date("2026-08-01T12:00:00.000Z"),
    ]);
    const id = await insertUnpricedTrade({
      kolId,
      walletId,
      mint,
      blockTime,
      solAmount: "0.1",
      priceSol: "0.05",
    });

    const result = await backfillPrices({ fetchImpl: offlineFetch });

    expect(result.examined).toBe(1);
    expect(result.filled).toBe(1);
    expect(result.stillUnpriced).toBe(0);

    const row = await tradeRow(id);
    // Exact strings, not `Number(...)`. Measured in node 26:
    // `0.1 * 231.71` is 23.171000000000003 and `0.05 * 231.71` is
    // 11.585500000000001 — what a double-based implementation writes into
    // these `numeric` columns. Asserting through `Number()` would pass
    // against both implementations.
    expect(row.usd_amount).toBe("23.171");
    expect(row.price_usd).toBe("11.5855");
    expect(row.sol_usd).toBe("231.71");
    expect(row.priced_at).not.toBeNull();
  });

  it("leaves a trade with no rate for its minute NULL — not zero — and records that it looked", async () => {
    // The only rate in the table is *after* the trade, so `solUsdAt`'s `<=`
    // bound finds nothing. Using it anyway would be re-pricing, which spec
    // §4.1 forbids outright.
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '200')", [
      new Date("2026-08-02T00:00:00.000Z"),
    ]);
    const id = await insertUnpricedTrade({
      kolId,
      walletId,
      mint,
      blockTime: new Date("2026-08-01T12:00:30.000Z"),
    });

    const result = await backfillPrices({ fetchImpl: offlineFetch });

    expect(result.filled).toBe(0);
    expect(result.stillUnpriced).toBe(1);

    const row = await tradeRow(id);
    expect(row.usd_amount).toBeNull();
    expect(row.sol_usd).toBeNull();
    expect(row.price_usd).toBeNull();
    // Not `toBeFalsy()`: `"0"` is falsy through Number() and would pass a
    // laxer assertion while being exactly the value this must never be.
    expect(row.usd_amount).not.toBe("0");
    // "We looked, and there was genuinely no rate" — distinguishable from
    // "nothing has ever looked at this row", which is what it was before.
    expect(row.priced_at).not.toBeNull();
  });

  it("marks the position of every filled trade dirty, and only those", async () => {
    const blockTime = new Date("2026-08-01T12:00:30.000Z");
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '100')", [
      new Date("2026-08-01T12:00:00.000Z"),
    ]);
    const unpriceableMint = inventAddress();

    await insertUnpricedTrade({ kolId, walletId, mint, blockTime });
    // Two trades on the same position: the dirty count is per position, not per trade.
    await insertUnpricedTrade({ kolId, walletId, mint, blockTime, solAmount: "2" });
    // Before every rate there is, so it cannot be filled and must not be dirtied.
    await insertUnpricedTrade({
      kolId,
      walletId,
      mint: unpriceableMint,
      blockTime: new Date("2020-01-01T00:00:00.000Z"),
    });

    // Both positions start clean, so `dirty` can only be true if this run set it.
    await query(
      "INSERT INTO position (kol_id, mint, dirty) VALUES ($1,$2,FALSE), ($1,$3,FALSE)",
      [kolId, mint, unpriceableMint],
    );

    const result = await backfillPrices({ fetchImpl: offlineFetch });

    expect(result.filled).toBe(2);
    expect(result.positionsMarked).toBe(1);

    const rows = await query<{ mint: string; dirty: boolean }>(
      "SELECT mint, dirty FROM position WHERE kol_id = $1 ORDER BY mint",
      [kolId],
    );
    const dirtyByMint = new Map(rows.map((r) => [r.mint, r.dirty]));
    expect(dirtyByMint.get(mint)).toBe(true);
    expect(dirtyByMint.get(unpriceableMint)).toBe(false);
  });

  it("creates the position row when a filled trade has none yet", async () => {
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '100')", [
      new Date("2026-08-01T12:00:00.000Z"),
    ]);
    await insertUnpricedTrade({
      kolId,
      walletId,
      mint,
      blockTime: new Date("2026-08-01T12:00:30.000Z"),
    });

    await backfillPrices({ fetchImpl: offlineFetch });

    const [row] = await query<{ dirty: boolean }>(
      "SELECT dirty FROM position WHERE kol_id = $1 AND mint = $2",
      [kolId, mint],
    );
    expect(row.dirty).toBe(true);
  });

  it("is idempotent: a second run fills nothing, dirties nothing, and changes no figure", async () => {
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '100')", [
      new Date("2026-08-01T12:00:00.000Z"),
    ]);
    const id = await insertUnpricedTrade({
      kolId,
      walletId,
      mint,
      blockTime: new Date("2026-08-01T12:00:30.000Z"),
    });

    const first = await backfillPrices({ fetchImpl: offlineFetch });
    expect(first.filled).toBe(1);
    const afterFirst = await tradeRow(id);

    // Clean the position so a second dirty mark is visible rather than
    // hidden behind the first run's flag.
    await query("UPDATE position SET dirty = FALSE WHERE kol_id = $1", [kolId]);

    const second = await backfillPrices({ fetchImpl: offlineFetch });

    expect(second.examined).toBe(0);
    expect(second.filled).toBe(0);
    expect(second.positionsMarked).toBe(0);

    const afterSecond = await tradeRow(id);
    expect(afterSecond.usd_amount).toBe(afterFirst.usd_amount);
    expect(afterSecond.price_usd).toBe(afterFirst.price_usd);

    const [pos] = await query<{ dirty: boolean }>(
      "SELECT dirty FROM position WHERE kol_id = $1 AND mint = $2",
      [kolId, mint],
    );
    expect(pos.dirty).toBe(false);
  });

  it("re-runs pick up a trade only once a rate covering its minute exists", async () => {
    const blockTime = new Date("2026-08-01T12:00:30.000Z");
    const id = await insertUnpricedTrade({ kolId, walletId, mint, blockTime });

    // Nothing in sol_price at all: still unpriced, still requeued.
    expect((await backfillPrices({ fetchImpl: offlineFetch })).filled).toBe(0);
    expect((await tradeRow(id)).usd_amount).toBeNull();

    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '100')", [
      new Date("2026-08-01T11:59:00.000Z"),
    ]);

    const second = await backfillPrices({ fetchImpl: offlineFetch });
    expect(second.filled).toBe(1);
    expect((await tradeRow(id)).usd_amount).toBe("100");
  });

  it("uses the rate for the trade's own minute, not the newest rate in the table", async () => {
    // Two trades, two minutes, two very different rates. A run that resolved
    // one rate for the whole batch — or took the latest row — would give both
    // trades the same number, and both numbers would still look plausible.
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1,'100'), ($2,'400')", [
      new Date("2026-08-01T12:00:00.000Z"),
      new Date("2026-08-01T13:00:00.000Z"),
    ]);
    const early = await insertUnpricedTrade({
      kolId,
      walletId,
      mint,
      blockTime: new Date("2026-08-01T12:30:00.000Z"),
    });
    const late = await insertUnpricedTrade({
      kolId,
      walletId,
      mint,
      blockTime: new Date("2026-08-01T13:30:00.000Z"),
    });

    await backfillPrices({ fetchImpl: offlineFetch });

    expect((await tradeRow(early)).usd_amount).toBe("100");
    expect((await tradeRow(late)).usd_amount).toBe("400");
  });

  it("a newly arrived trade jumps a backlog of permanently unfillable ones", async () => {
    // The starvation this ordering exists to prevent. Trades older than the
    // earliest `sol_price` row can never be filled and are also the oldest
    // rows in the queue, so `ORDER BY block_time` alone parks them at the
    // front forever: past one LIMIT's worth, every run re-examines the same
    // prefix and a newer, fillable trade is never reached.
    //
    // `limit: 2` stands in for the real 5,000 — the property is the ordering,
    // not the number.
    const stale = inventAddress();
    await insertUnpricedTrade({
      kolId, walletId, mint: stale, blockTime: new Date("2020-01-01T00:00:00.000Z"),
    });
    await insertUnpricedTrade({
      kolId, walletId, mint: stale, blockTime: new Date("2020-01-02T00:00:00.000Z"),
    });

    // Run once: the backlog is examined, fills nothing, and gets stamped.
    const first = await backfillPrices({ fetchImpl: offlineFetch, limit: 2 });
    expect(first.examined).toBe(2);
    expect(first.filled).toBe(0);

    // Now a real trade arrives, with a rate that covers it. Under block_time
    // ordering it sorts *behind* both 2020 rows and, at limit 2, is never
    // reached — the second run would report examined 2, filled 0, forever.
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '100')", [
      new Date("2026-08-01T12:00:00.000Z"),
    ]);
    const fresh = await insertUnpricedTrade({
      kolId, walletId, mint, blockTime: new Date("2026-08-01T12:30:00.000Z"),
    });

    const second = await backfillPrices({ fetchImpl: offlineFetch, limit: 2 });

    expect(second.filled).toBe(1);
    expect((await tradeRow(fresh)).usd_amount).toBe("100");
  });

  it("still retries a stamped trade, so a rate arriving later is not locked out", async () => {
    // The other side of the same decision: the queue is *ordered* by
    // priced_at, never *narrowed* by it. Narrowing would bound starvation by
    // making an attempted-and-failed row unreachable for good, which would
    // silently discard any sol_price row imported after the fact.
    const id = await insertUnpricedTrade({
      kolId, walletId, mint, blockTime: new Date("2026-08-01T12:30:00.000Z"),
    });

    expect((await backfillPrices({ fetchImpl: offlineFetch })).filled).toBe(0);
    expect((await tradeRow(id)).priced_at).not.toBeNull(); // stamped: it has been looked at

    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '100')", [
      new Date("2026-08-01T12:00:00.000Z"),
    ]);

    expect((await backfillPrices({ fetchImpl: offlineFetch })).filled).toBe(1);
    expect((await tradeRow(id)).usd_amount).toBe("100");
  });

  it("does not touch a trade that already carries a USD amount", async () => {
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '999')", [
      new Date("2026-08-01T12:00:00.000Z"),
    ]);
    const id = await insertUnpricedTrade({
      kolId,
      walletId,
      mint,
      blockTime: new Date("2026-08-01T12:30:00.000Z"),
      usdAmount: "42",
    });

    const result = await backfillPrices({ fetchImpl: offlineFetch });

    expect(result.examined).toBe(0);
    expect(Number((await tradeRow(id)).usd_amount)).toBe(42);
  });

  it("refreshes the rate first, covering a trade from the same minute as the refresh", async () => {
    // The narrowest true statement about this run's own refresh.
    // `refreshSolPrice` writes one row at the current minute and `solUsdAt`
    // bounds at `minute <= block_time`, so the only trades this run's refresh
    // can reach are the ones inside that same minute.
    //
    // `now` is pinned rather than taken from the clock: with a real `new
    // Date()` this case passes or fails depending on whether the trade and
    // the refresh land either side of a minute boundary. An earlier draft of
    // this test hid that by giving the trade a block time 30 seconds in the
    // *future* under a comment claiming it was in the past — a fixture no
    // real trade can have, proving a property no real trade enjoys.
    const now = new Date("2026-08-01T12:00:45.000Z");
    const id = await insertUnpricedTrade({
      kolId,
      walletId,
      mint,
      blockTime: new Date("2026-08-01T12:00:10.000Z"), // earlier than `now`, same minute
    });

    const result = await backfillPrices({ fetchImpl: dexFetch("150"), now });

    expect(result.rateRefreshed).toBe(true);
    expect(result.filled).toBe(1);
    expect((await tradeRow(id)).usd_amount).toBe("150");
  });

  it("does not reach a trade from a minute before the refresh, and does not back-date one to it", async () => {
    // The other half, and the one that governs every real trade: a trade from
    // an earlier minute is *not* covered by this run's refresh. It waits for
    // a row an earlier cycle wrote — which is what the 5-minute cadence
    // provides in steady state — and if none exists it stays NULL rather than
    // being valued at a rate from after it happened (spec §4.1: never
    // re-price).
    const now = new Date("2026-08-01T12:05:00.000Z");
    const id = await insertUnpricedTrade({
      kolId,
      walletId,
      mint,
      blockTime: new Date("2026-08-01T12:04:30.000Z"), // one minute earlier
    });

    const result = await backfillPrices({ fetchImpl: dexFetch("150"), now });

    expect(result.rateRefreshed).toBe(true);
    expect(result.filled).toBe(0);
    expect(result.stillUnpriced).toBe(1);
    expect((await tradeRow(id)).usd_amount).toBeNull();

    // ...and the cycle after next fills it, because by then a row predates it.
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '140')", [
      new Date("2026-08-01T12:00:00.000Z"),
    ]);
    const later = await backfillPrices({ fetchImpl: offlineFetch, now });
    expect(later.filled).toBe(1);
    expect((await tradeRow(id)).usd_amount).toBe("140");
  });

  it("a DexScreener outage still fills everything the stored rates cover", async () => {
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '120')", [
      new Date("2026-08-01T12:00:00.000Z"),
    ]);
    const id = await insertUnpricedTrade({
      kolId,
      walletId,
      mint,
      blockTime: new Date("2026-08-01T12:30:00.000Z"),
    });

    const result = await backfillPrices({ fetchImpl: offlineFetch });

    expect(result.rateRefreshed).toBe(false);
    expect(result.filled).toBe(1);
    expect((await tradeRow(id)).usd_amount).toBe("120");
  });
});

describe("scripts/backfill-prices.ts: main()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price, token CASCADE");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("reports the counts and exits 0, printing no secret", async () => {
    // The network guard throws on the unmocked `fetch` main() uses, which
    // `refreshSolPrice` swallows into "wrote nothing" — the same shape a real
    // DexScreener outage takes, and the reason main() still exits 0.
    const code = await main();

    expect(code).toBe(0);
    const line = logSpy.mock.calls.flat().join("\n");
    expect(line).toContain("backfill-prices: examined 0 unpriced trade(s)");
    for (const secret of [
      process.env.DATABASE_URL,
      process.env.WALLET_ENC_KEY,
      process.env.WALLET_HMAC_KEY,
      process.env.HELIUS_API_KEY,
    ]) {
      if (secret) expect(line).not.toContain(secret);
    }
  });

  it("exits non-zero when the work throws, distinguishably from having done nothing", async () => {
    const failure = new Error("neon is down");
    const spy = vi.spyOn(await import("../src/lib/prices"), "solUsdAt").mockRejectedValue(failure);
    try {
      // A row to make the run reach solUsdAt at all.
      const kolId = await makeKol();
      const walletId = await addWallet(kolId, inventAddress());
      await insertUnpricedTrade({
        kolId,
        walletId,
        mint: inventAddress(),
        blockTime: new Date("2026-08-01T12:00:30.000Z"),
      });

      const code = await main();

      expect(code).toBe(1);
      const errors = errorSpy.mock.calls.flat().join("\n");
      expect(errors).toContain("backfill-prices: failed");
      expect(logSpy.mock.calls.flat().join("\n")).not.toContain("did nothing");
    } finally {
      spy.mockRestore();
    }
  });
});

import { randomBytes, randomInt } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { inventAddress } from "./ids";
import { recomputeDirty, replayPosition } from "./pnl";
import { addWallet } from "./wallets";

let kolId: string;
let walletId: string;
let mint: string;
let otherMint: string;

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet, trade, position, pnl_daily, pnl_position_daily CASCADE");
  kolId = crypto.randomUUID();
  await query(
    "INSERT INTO kol (id, slug, display_name, x_handle, status) VALUES ($1,'p','P','p','approved')",
    [kolId],
  );
  walletId = await addWallet(kolId, inventAddress());
  mint = inventAddress();
  otherMint = inventAddress();
});

/**
 * One trade, with every amount written as a **string**. A test that typed
 * `1.5` would hand the implementation a float before it ever reached the
 * database, and could not tell whether the value that came back had been
 * through one.
 */
type TradeSpec = {
  side: "buy" | "sell";
  /** Net SOL moved, spec §4.4. */
  sol: string;
  tokens: string;
  /** UTC instant, as an ISO string, so the day a sell lands in is visible in the test. */
  at: string;
  slot: number;
  ix?: number;
  /** NULL models a trade whose block had no `sol_price` row. */
  usd?: string | null;
  /**
   * The transaction fee, spec §4.4. Zero unless this wallet was the fee
   * payer — `parse-swap` writes 0 for every other wallet in the transaction.
   */
  fee?: string;
  basis?: "known" | "unknown";
  mint?: string;
};

/** All of them in one statement: every round trip to Neon costs the suite real time. */
async function insertTrades(specs: TradeSpec[]): Promise<void> {
  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, slot, kol_id,
                        wallet_id, mint, side, token_amount, sol_amount, usd_amount, sol_usd,
                        fee_sol, basis, block_time)
     SELECT entry.id::uuid, decode(entry.sig, 'hex'), decode(entry.sig, 'hex'),
            entry.ix::smallint, entry.slot::bigint, $1, $2, entry.mint, entry.side,
            entry.tokens::numeric, entry.sol::numeric, entry.usd::numeric,
            entry.sol_usd::numeric, entry.fee::numeric,
            entry.basis, entry.at::timestamptz
       FROM unnest($3::text[], $4::text[], $5::int[], $6::bigint[], $7::text[], $8::text[],
                   $9::text[], $10::text[], $11::text[], $12::text[], $13::text[],
                   $14::text[], $15::text[])
            AS entry(id, sig, ix, slot, mint, side, tokens, sol, usd, sol_usd, fee, basis, at)`,
    [
      kolId,
      walletId,
      specs.map(() => crypto.randomUUID()),
      specs.map(() => randomBytes(32).toString("hex")),
      specs.map((spec) => spec.ix ?? 0),
      specs.map((spec) => spec.slot),
      specs.map((spec) => spec.mint ?? mint),
      specs.map((spec) => spec.side),
      specs.map((spec) => spec.tokens),
      specs.map((spec) => spec.sol),
      specs.map((spec) => (spec.usd === undefined ? null : spec.usd)),
      // `usd_amount` and `sol_usd` are written from the same lookup, so a
      // trade whose block had no price has neither.
      specs.map((spec) => (spec.usd === undefined || spec.usd === null ? null : "150")),
      specs.map((spec) => spec.fee ?? "0"),
      specs.map((spec) => spec.basis ?? "known"),
      specs.map((spec) => spec.at),
    ],
  );
}

type PositionRow = {
  qty: string;
  cost_sol: string;
  avg_cost_sol: string;
  realized_sol: string;
  realized_usd: string;
  basis: string;
  dirty: boolean;
};

/** Numerics as `::text`, so an assertion compares what is stored, not a float of it. */
async function position(forMint: string = mint): Promise<PositionRow> {
  const rows = await query<PositionRow>(
    `SELECT qty::text, cost_sol::text, avg_cost_sol::text, realized_sol::text,
            realized_usd::text, basis, dirty
       FROM position WHERE kol_id = $1 AND mint = $2`,
    [kolId, forMint],
  );
  return rows[0];
}

type DailyRow = { day: string; realized_sol: string; realized_usd: string; wins: number; losses: number };

async function daily(): Promise<DailyRow[]> {
  return query<DailyRow>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, realized_sol::text, realized_usd::text, wins, losses
       FROM pnl_daily WHERE kol_id = $1 ORDER BY day`,
    [kolId],
  );
}

/**
 * Everything a replay derives, as one comparable string. `to_char` and
 * `::text` keep it in the database's own representation: `numeric` preserves
 * the scale it was written with, so two replays that agree on the value but
 * not on how they wrote it (`0.5` versus `0.500`) still differ here.
 */
async function derivedRows(): Promise<string> {
  const positions = await query(
    `SELECT mint, qty::text AS qty, cost_sol::text AS cost_sol, avg_cost_sol::text AS avg_cost_sol,
            realized_sol::text AS realized_sol, realized_usd::text AS realized_usd, basis, dirty,
            to_char(first_buy_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS first_buy_at,
            to_char(last_trade_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS last_trade_at
       FROM position WHERE kol_id = $1 ORDER BY mint`,
    [kolId],
  );
  return JSON.stringify({ positions, daily: await daily() }, null, 1);
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const pick = randomInt(index + 1);
    [copy[index], copy[pick]] = [copy[pick], copy[index]];
  }
  return copy;
}

/**
 * The worked case, chosen so every intermediate value is exact in decimal and
 * the position closes twice — once at a loss, once at a win.
 *
 *  1. buy   1 SOL / 100 tok  -> qty 100, cost 1
 *  2. buy   3 SOL / 100 tok  -> qty 200, cost 4, avg 0.02
 *  3. sell  1.5 SOL / 50 tok -> removed 4x50/200 = 1;   realized  0.5; cost 3;   qty 150
 *  4. sell  2 SOL / 140 tok  -> removed 3x140/150 = 2.8; realized -0.3; cost 0.2; qty 10
 *                               sold 190 of 200 bought = 95% -> closed, at a loss
 *  5. buy   2 SOL / 100 tok  -> qty 110, cost 2.2; 190 of 300 -> reopened
 *  6. sell  5 SOL / 105 tok  -> removed 2.2x105/110 = 2.1; realized 2.6; cost 0.1; qty 5
 *                               sold 295 of 300 -> closed again, at a win
 *
 * Trades 2 and 3 carry the same `block_time`, and so do 5 and 6: `block_time`
 * is only second-granular and a trader fires several swaps of one mint inside
 * a second. Each of those pairs is a buy and a sell whose order changes the
 * answer, and only `slot` separates them - so an implementation ordering by
 * `block_time, id` picks between them at random, which is what makes the
 * shuffle below able to see it.
 */
const GOLDEN: TradeSpec[] = [
  { side: "buy", sol: "1", tokens: "100", usd: "150", at: "2026-08-25T12:00:00Z", slot: 100 },
  { side: "buy", sol: "3", tokens: "100", usd: "450", at: "2026-08-25T12:01:00Z", slot: 101 },
  { side: "sell", sol: "1.5", tokens: "50", usd: "225", at: "2026-08-25T12:01:00Z", slot: 102 },
  { side: "sell", sol: "2", tokens: "140", usd: "300", at: "2026-08-26T12:00:00Z", slot: 200 },
  { side: "buy", sol: "2", tokens: "100", usd: "300", at: "2026-08-27T10:00:00Z", slot: 300 },
  { side: "sell", sol: "5", tokens: "105", usd: "750", at: "2026-08-27T10:00:00Z", slot: 301 },
];

describe("replayPosition: cost basis", () => {
  it("averages the cost of two buys", async () => {
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "buy", sol: "3", tokens: "100", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.qty).toBe("200");
    expect(row.cost_sol).toBe("4");
    expect(row.avg_cost_sol).toBe("0.02");
    expect(row.realized_sol).toBe("0");
  });

  it("realizes profit only on the quantity actually sold, and leaves the average alone", async () => {
    await insertTrades([
      { side: "buy", sol: "2", tokens: "200", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.5", tokens: "100", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.realized_sol).toBe("0.5");
    expect(row.qty).toBe("100");
    expect(row.cost_sol).toBe("1");
    expect(row.avg_cost_sol).toBe("0.01");
  });

  it("leaves an open position out of realized PnL entirely", async () => {
    await insertTrades([{ side: "buy", sol: "5", tokens: "500", at: "2026-08-25T12:00:00Z", slot: 1 }]);
    await replayPosition(kolId, mint);

    expect((await position()).realized_sol).toBe("0");
    expect(await daily()).toEqual([]);
  });

  it("keeps a basis a double would round, to the last digit", async () => {
    // 1 SOL over 3 tokens. A double holds 15-17 significant digits, so a float
    // implementation returns 0.6666666666666667 or 0.6666666666666666 here;
    // neither is this.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "3", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1", tokens: "1", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.realized_sol).toBe("0.666666666666666667");
    expect(row.cost_sol).toBe("0.666666666666666667");
    expect(row.avg_cost_sol).toBe("0.333333333333333333");
    expect(row.qty).toBe("2");
  });

  it("takes the basis out in one division, not by way of a rounded average", async () => {
    // 1 SOL over 3 tokens, 2.5 of them sold. The exact share of the cost is
    // 0.8333...; `(cost x sold) / qty` floors that once, to ...333.
    // `avg = cost / qty` then `avg x sold` floors twice - the residue the
    // first division dropped gets multiplied by 2.5 - and lands on ...332,
    // one unit light, with the difference stranded on the position as profit
    // that was never made.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "3", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1", tokens: "2.5", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.realized_sol).toBe("0.166666666666666667");
    // Exactly what the sale did not take: the position's cost stays consistent
    // with the amount removed from it, by construction.
    expect(row.cost_sol).toBe("0.166666666666666667");
    expect(row.qty).toBe("0.5");
  });

  it("returns exactly the cost that went in, once the position is fully out", async () => {
    // 1 SOL in, 2 SOL out, in two unequal tranches whose basis does not divide
    // evenly. Realized must be exactly 1 and the remaining cost exactly 0: any
    // rounding residue left on the position shows up as invented profit.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "3", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1", tokens: "1", at: "2026-08-25T12:01:00Z", slot: 2 },
      { side: "sell", sol: "1", tokens: "2", at: "2026-08-25T12:02:00Z", slot: 3 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.realized_sol).toBe("1");
    expect(row.cost_sol).toBe("0");
    expect(row.qty).toBe("0");
    expect(row.avg_cost_sol).toBe("0");
  });
});

describe("replayPosition: fees", () => {
  it("charges the fee on both legs, so a round trip pays it twice", async () => {
    // Spec §4.4: `sol_amount` is the swap leg alone — `parse-swap` adds the
    // fee back out of the wallet's net balance delta precisely so the two can
    // be charged separately. A buy costs the leg plus the fee, a sell nets the
    // leg minus it.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", fee: "0.05", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.2", tokens: "100", fee: "0.05", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    // (1.2 - 0.05) - (1 + 0.05) = 0.1, not the 0.2 the gross legs alone show.
    expect((await position()).realized_sol).toBe("0.1");
  });

  it("carries the fee into the cost basis of an unsold remainder", async () => {
    // The ratio path, not the full-exit shortcut: half the position is still
    // open and its average cost has to carry its share of the entry fee.
    await insertTrades([
      { side: "buy", sol: "2", tokens: "200", fee: "0.1", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.5", tokens: "100", fee: "0.1", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    // Cost 2.1 over 200 tokens; the sale removes 2.1 x 100/200 = 1.05 and
    // nets 1.4, so realized is 0.35 and 1.05 of basis stays on 100 tokens.
    expect(row.realized_sol).toBe("0.35");
    expect(row.cost_sol).toBe("1.05");
    expect(row.avg_cost_sol).toBe("0.0105");
  });

  it("records a round trip that the fees turned negative as a loss", async () => {
    // The seam this closes. Gross, the legs read +0.02 and the position
    // closes as a win. The wallet paid 0.10 in fees to make it, so the round
    // trip lost 0.08 - and a win on a losing round trip is the §4.7
    // contradiction, on the number the leaderboard ranks.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", fee: "0.05", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.02", tokens: "100", fee: "0.05", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    expect((await position()).realized_sol).toBe("-0.08");
    expect(await daily()).toEqual([
      { day: "2026-08-25", realized_sol: "-0.08", realized_usd: "0", wins: 0, losses: 1 },
    ]);
  });

  it("leaves the same round trip a win for a wallet that paid no fee", async () => {
    // `parse-swap` writes `fee_sol` only for the fee payer; every other
    // tracked wallet in the same transaction gets 0. The two cases have to be
    // distinguishable, or the fix above is indistinguishable from a constant.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", fee: "0", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.02", tokens: "100", fee: "0", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    expect((await position()).realized_sol).toBe("0.02");
    expect(await daily()).toEqual([
      { day: "2026-08-25", realized_sol: "0.02", realized_usd: "0", wins: 1, losses: 0 },
    ]);
  });

  it("values the fee in USD at the same rate the trade was priced with", async () => {
    // §4.1: USD is derived at trade time and never re-priced. The fee is a
    // SOL amount, so it is valued at that trade's own `sol_usd` — the rate
    // `usd_amount` came from — rather than left out of the USD figure.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", usd: "150", fee: "0.05", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.2", tokens: "100", usd: "180", fee: "0.05", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.realized_sol).toBe("0.1");
    // Cost 150 + 7.5, proceeds 180 - 7.5.
    expect(row.realized_usd).toBe("15");
  });

  it("counts a sell whose fee outweighs its proceeds as the loss it is", async () => {
    // Net proceeds below zero are a real outcome, not corrupt data, so they
    // are not clamped - and they give up basis, so the position stays known.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "0.02", tokens: "100", fee: "0.05", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.realized_sol).toBe("-1.03");
    expect(row.basis).toBe("known");
  });
});

describe("replayPosition: replay order", () => {
  it("produces the same rows whatever order the trades were inserted in", async () => {
    // A 30-day backfill landing after live trades is a shuffled insertion
    // order, so the property is asserted over real permutations rather than
    // one hand-picked reversal.
    const snapshots: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      await query("TRUNCATE trade, position, pnl_daily, pnl_position_daily CASCADE");
      await insertTrades(shuffled(GOLDEN));
      await replayPosition(kolId, mint);
      snapshots.push(await derivedRows());
    }

    for (const snapshot of snapshots) expect(snapshot).toBe(snapshots[0]);

    // And the shared answer is the right one, not merely a stable one.
    const row = await position();
    expect(row.qty).toBe("5");
    expect(row.cost_sol).toBe("0.1");
    expect(row.realized_sol).toBe("2.6");
    expect(row.realized_usd).toBe("390");
    expect(await daily()).toEqual([
      { day: "2026-08-25", realized_sol: "0.5", realized_usd: "75", wins: 0, losses: 0 },
      { day: "2026-08-26", realized_sol: "-0.8", realized_usd: "-120", wins: 0, losses: 1 },
      { day: "2026-08-27", realized_sol: "2.9", realized_usd: "435", wins: 1, losses: 0 },
    ]);
  });

  it("orders two trades of the same second by slot, not by anything else", async () => {
    // Same block time to the second, which is all `block_time` records. Read
    // in slot order this is a buy then a sale of half of it. Read the other
    // way round it is a sale of tokens the position does not hold, which is a
    // different number *and* a different basis - so the assertion fails loudly
    // rather than drifting.
    await insertTrades([
      { side: "sell", sol: "1", tokens: "50", at: "2026-08-25T12:00:00Z", slot: 11 },
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 10 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.realized_sol).toBe("0.5");
    expect(row.qty).toBe("50");
    expect(row.basis).toBe("known");
  });

  it("orders two trades of the same slot by instruction index", async () => {
    await insertTrades([
      { side: "sell", sol: "1", tokens: "50", at: "2026-08-25T12:00:00Z", slot: 10, ix: 4 },
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 10, ix: 1 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.realized_sol).toBe("0.5");
    expect(row.qty).toBe("50");
    expect(row.basis).toBe("known");
  });

  it("is idempotent: a second replay of the same trades rewrites the same rows", async () => {
    await insertTrades(GOLDEN);
    await replayPosition(kolId, mint);
    const first = await derivedRows();

    await replayPosition(kolId, mint);
    expect(await derivedRows()).toBe(first);
  });
});

describe("replayPosition: daily buckets", () => {
  it("writes realized PnL into the UTC day of the sell", async () => {
    await insertTrades([
      { side: "buy", sol: "2", tokens: "200", usd: "300", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.5", tokens: "100", usd: "225", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    expect(await daily()).toEqual([
      { day: "2026-08-25", realized_sol: "0.5", realized_usd: "75", wins: 0, losses: 0 },
    ]);
  });

  it("splits two sells a second apart across the UTC midnight between them", async () => {
    await insertTrades([
      { side: "buy", sol: "4", tokens: "400", at: "2026-08-25T00:00:00Z", slot: 1 },
      { side: "sell", sol: "1.5", tokens: "100", at: "2026-08-25T23:59:59Z", slot: 2 },
      { side: "sell", sol: "0.5", tokens: "100", at: "2026-08-26T00:00:01Z", slot: 3 },
    ]);
    await replayPosition(kolId, mint);

    expect((await daily()).map((row) => [row.day, row.realized_sol])).toEqual([
      ["2026-08-25", "0.5"],
      ["2026-08-26", "-0.5"],
    ]);
  });

  it("contributes nothing to USD for a trade whose block had no SOL price", async () => {
    await insertTrades([
      { side: "buy", sol: "2", tokens: "200", usd: null, at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.5", tokens: "100", usd: "225", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    // The SOL figure is unaffected; the USD one carries only the priced side.
    const row = await position();
    expect(row.realized_sol).toBe("0.5");
    expect(row.realized_usd).toBe("225");
  });

  it("takes a day's row away when its last sell does", async () => {
    await insertTrades([
      { side: "buy", sol: "2", tokens: "200", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.5", tokens: "100", at: "2026-08-26T12:00:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);
    expect((await daily()).length).toBe(1);

    await query("DELETE FROM trade WHERE side = 'sell'");
    await replayPosition(kolId, mint);
    expect(await daily()).toEqual([]);
  });

  it("removes the position outright when its last trade is gone", async () => {
    await insertTrades([{ side: "buy", sol: "2", tokens: "200", at: "2026-08-25T12:00:00Z", slot: 1 }]);
    await replayPosition(kolId, mint);
    expect(await position()).toBeDefined();

    await query("DELETE FROM trade");
    await replayPosition(kolId, mint);
    expect(await position()).toBeUndefined();
  });
});

describe("replayPosition: win rate", () => {
  it("counts nothing until the position closes, then counts it once", async () => {
    await insertTrades([
      { side: "buy", sol: "2", tokens: "200", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.5", tokens: "100", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);
    expect((await daily())[0].wins).toBe(0);

    await insertTrades([
      { side: "sell", sol: "1.6", tokens: "100", at: "2026-08-25T12:02:00Z", slot: 3 },
    ]);
    await replayPosition(kolId, mint);
    expect((await daily())[0]).toMatchObject({ wins: 1, losses: 0 });
  });

  it("does not count again for selling the tail of a position that already closed", async () => {
    // Spec §4.8 counts per closed position, not per sell: the whole point is
    // that exiting in twelve tranches is not twelve wins. Both sells here are
    // past the 95% mark, and there is no buy in between to reopen anything.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "2", tokens: "96", at: "2026-08-25T12:01:00Z", slot: 2 },
      { side: "sell", sol: "1", tokens: "4", at: "2026-08-26T12:00:00Z", slot: 3 },
    ]);
    await replayPosition(kolId, mint);

    const rows = await daily();
    expect(rows.reduce((total, row) => total + row.wins, 0)).toBe(1);
    expect(rows.reduce((total, row) => total + row.losses, 0)).toBe(0);
    // And it landed on the day of the sell that closed it, not the last one.
    expect(rows.find((row) => row.day === "2026-08-25")?.wins).toBe(1);
  });

  it("counts a losing round trip as a loss even after a winning one", async () => {
    // The realized figure on the position is cumulative, so once a position
    // has ever been in profit every later closure looks positive. Judged that
    // way, the second episode here — which lost half a SOL — is recorded as a
    // win, and 08-26 becomes a day whose own realized PnL is negative while it
    // carries a win. That is the statistic spec §4.7 cites against
    // kolscan.io, on the number the leaderboard ranks.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "2", tokens: "100", at: "2026-08-25T12:01:00Z", slot: 2 },
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-26T12:00:00Z", slot: 3 },
      { side: "sell", sol: "0.5", tokens: "100", at: "2026-08-26T12:01:00Z", slot: 4 },
    ]);
    await replayPosition(kolId, mint);

    // Episode one: +1, a win. Episode two: -0.5, a loss. The position's
    // cumulative realized PnL is +0.5 throughout the second closure.
    expect(await daily()).toEqual([
      { day: "2026-08-25", realized_sol: "1", realized_usd: "0", wins: 1, losses: 0 },
      { day: "2026-08-26", realized_sol: "-0.5", realized_usd: "0", wins: 0, losses: 1 },
    ]);
    expect((await position()).realized_sol).toBe("0.5");
  });

  it("counts a winning round trip as a win even after a losing one", async () => {
    // The other sign direction, where the cumulative reading is still negative
    // at the second closure and would call a profitable round trip a loss.
    await insertTrades([
      { side: "buy", sol: "3", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "0.5", tokens: "100", at: "2026-08-25T12:01:00Z", slot: 2 },
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-26T12:00:00Z", slot: 3 },
      { side: "sell", sol: "2", tokens: "100", at: "2026-08-26T12:01:00Z", slot: 4 },
    ]);
    await replayPosition(kolId, mint);

    // Episode one: -2.5, a loss. Episode two: +1, a win. Cumulative realized
    // PnL at the second closure is -1.5.
    expect(await daily()).toEqual([
      { day: "2026-08-25", realized_sol: "-2.5", realized_usd: "0", wins: 0, losses: 1 },
      { day: "2026-08-26", realized_sol: "1", realized_usd: "0", wins: 1, losses: 0 },
    ]);
    expect((await position()).realized_sol).toBe("-1.5");
  });

  it("opens the next episode at the reopening buy, not at the closure before it", async () => {
    // Where the snapshot is taken is the most fragile decision in the module,
    // and it takes a deliberate value to see it. The 0.96 SOL tail sell on
    // 08-26 is the *first* round trip's proceeds - it arrived after that
    // position closed and before anything reopened it - so it must stay with
    // the episode that already counted.
    //
    // Snapshotting at the closure instead leaves that 0.96 inside the next
    // episode, which then reads +0.46 rather than -0.5 and writes a win onto
    // a day whose own realized PnL is negative: the §4.7 contradiction the
    // episode rule exists to remove, one step further along.
    //
    //   buy  1   / 100 -> qty 100, cost 1
    //   sell 2   /  96 -> +1.04, closes 08-25 at a win
    //   sell 1   /   4 -> +0.96 tail on 08-26, no episode open, counts nothing
    //   buy  2   / 100 -> reopens; realized stands at 2 and the episode starts there
    //   sell 1.5 / 100 -> -0.5 for the episode, closes 08-27 at a loss
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "2", tokens: "96", at: "2026-08-25T12:01:00Z", slot: 2 },
      { side: "sell", sol: "1", tokens: "4", at: "2026-08-26T12:00:00Z", slot: 3 },
      { side: "buy", sol: "2", tokens: "100", at: "2026-08-27T12:00:00Z", slot: 4 },
      { side: "sell", sol: "1.5", tokens: "100", at: "2026-08-27T12:01:00Z", slot: 5 },
    ]);
    await replayPosition(kolId, mint);

    const rows = await daily();
    expect(rows.find((row) => row.day === "2026-08-25")).toMatchObject({ wins: 1, losses: 0 });
    // A sell between a closure and the next buy belongs to no episode's verdict.
    expect(rows.find((row) => row.day === "2026-08-26")).toMatchObject({
      realized_sol: "0.96",
      wins: 0,
      losses: 0,
    });
    // The day that discriminates: negative realized PnL, and it must not carry a win.
    expect(rows.find((row) => row.day === "2026-08-27")).toMatchObject({
      realized_sol: "-0.5",
      wins: 0,
      losses: 1,
    });
    expect((await position()).realized_sol).toBe("1.5");
  });

  it("closes on the share of everything ever bought, not of what is left", async () => {
    // 100 bought, 60 sold, then 100 more bought and 60 more sold: 120 of 200,
    // which is not closed - even though the second sell took 60 of the 140 on
    // hand and a `sold / qty` reading would have crossed the line twice.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1", tokens: "60", at: "2026-08-25T12:01:00Z", slot: 2 },
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:02:00Z", slot: 3 },
      { side: "sell", sol: "1", tokens: "60", at: "2026-08-25T12:03:00Z", slot: 4 },
    ]);
    await replayPosition(kolId, mint);

    expect((await daily())[0]).toMatchObject({ wins: 0, losses: 0 });
  });

  it("closes at exactly the threshold, and not one token below it", async () => {
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "2", tokens: "94", at: "2026-08-25T12:01:00Z", slot: 2 },
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T13:00:00Z", slot: 3, mint: otherMint },
      { side: "sell", sol: "2", tokens: "95", at: "2026-08-25T13:01:00Z", slot: 4, mint: otherMint },
    ]);
    await replayPosition(kolId, mint);
    expect((await daily())[0]).toMatchObject({ wins: 0, losses: 0 });

    await replayPosition(kolId, otherMint);
    expect((await daily())[0]).toMatchObject({ wins: 1, losses: 0 });
  });

  it("counts a closed position that lost as a loss, on the day it closed", async () => {
    await insertTrades([
      { side: "buy", sol: "2", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "0.5", tokens: "100", at: "2026-08-26T12:00:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    expect(await daily()).toEqual([
      { day: "2026-08-26", realized_sol: "-1.5", realized_usd: "0", wins: 0, losses: 1 },
    ]);
  });

  it("lets a position that reopens close a second time", async () => {
    await insertTrades(GOLDEN);
    await replayPosition(kolId, mint);

    const rows = await daily();
    expect(rows.reduce((total, row) => total + row.wins, 0)).toBe(1);
    expect(rows.reduce((total, row) => total + row.losses, 0)).toBe(1);
  });
});

describe("replayPosition: unknown basis", () => {
  it("marks a position that sold more than it ever bought, and keeps it off pnl_daily", async () => {
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", usd: "150", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "3", tokens: "150", usd: "450", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.basis).toBe("unknown");
    // Never negative: the 50 tokens that were never bought take the whole
    // remaining cost with them and leave the position flat.
    expect(row.qty).toBe("0");
    expect(row.cost_sol).toBe("0");
    // Still recorded on the position, for the KOL page to show labelled.
    expect(row.realized_sol).toBe("2");
    // But withheld from the leaderboard's table (spec §4.5).
    expect(await daily()).toEqual([]);
  });

  it("marks a sell that gave up no quantity, and keeps its proceeds off pnl_daily", async () => {
    // Proceeds against no basis are the same manufactured-profit shape as an
    // oversell. Unreachable through `parse-swap`, whose dust floor drops a
    // zero leg — but the number this feeds is the one the leaderboard ranks,
    // so it is guarded here rather than upstream.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "5", tokens: "0", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.basis).toBe("unknown");
    // The position is untouched: nothing left it.
    expect(row.qty).toBe("100");
    expect(row.cost_sol).toBe("1");
    // 5 SOL out of nothing, kept off the ranked table.
    expect(await daily()).toEqual([]);
  });

  it("leaves a sell that moved nothing at all alone", async () => {
    // No quantity and no proceeds moves no money and accuses nobody.
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "0", tokens: "0", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.basis).toBe("known");
    expect(row.realized_sol).toBe("0");
    expect(row.qty).toBe("100");
  });

  it("marks a position whose first trade is a sell", async () => {
    await insertTrades([
      { side: "sell", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
    ]);
    await replayPosition(kolId, mint);

    const row = await position();
    expect(row.basis).toBe("unknown");
    expect(row.qty).toBe("0");
    expect(await daily()).toEqual([]);
  });

  it("honours a trade the parser already marked unknown", async () => {
    await insertTrades([
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1, basis: "unknown" },
      { side: "sell", sol: "3", tokens: "50", at: "2026-08-25T12:01:00Z", slot: 2 },
    ]);
    await replayPosition(kolId, mint);

    expect((await position()).basis).toBe("unknown");
    expect(await daily()).toEqual([]);
  });

  it("stays unknown once flagged, even if later buys cover the shortfall", async () => {
    await insertTrades([
      { side: "sell", sol: "1", tokens: "100", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "buy", sol: "1", tokens: "500", at: "2026-08-25T12:01:00Z", slot: 2 },
      { side: "sell", sol: "2", tokens: "100", at: "2026-08-25T12:02:00Z", slot: 3 },
    ]);
    await replayPosition(kolId, mint);

    expect((await position()).basis).toBe("unknown");
    expect(await daily()).toEqual([]);
  });
});

describe("replayPosition: one position at a time", () => {
  it("leaves the other mints' share of a day alone", async () => {
    await insertTrades([
      { side: "buy", sol: "2", tokens: "200", usd: "300", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.5", tokens: "100", usd: "225", at: "2026-08-25T12:01:00Z", slot: 2 },
      { side: "buy", sol: "1", tokens: "100", usd: "150", at: "2026-08-25T13:00:00Z", slot: 3, mint: otherMint },
      { side: "sell", sol: "2", tokens: "100", usd: "300", at: "2026-08-25T13:01:00Z", slot: 4, mint: otherMint },
    ]);
    await replayPosition(kolId, mint);
    await replayPosition(kolId, otherMint);

    // 0.5 from the first mint plus 1 from the second, and the second closed.
    expect(await daily()).toEqual([
      { day: "2026-08-25", realized_sol: "1.5", realized_usd: "225", wins: 1, losses: 0 },
    ]);

    // Replaying the first mint again must not overwrite the second's share.
    await replayPosition(kolId, mint);
    expect(await daily()).toEqual([
      { day: "2026-08-25", realized_sol: "1.5", realized_usd: "225", wins: 1, losses: 0 },
    ]);
  });
});

describe("recomputeDirty", () => {
  it("replays the dirty positions and clears their flags", async () => {
    await insertTrades([
      { side: "buy", sol: "2", tokens: "200", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "sell", sol: "1.5", tokens: "100", at: "2026-08-25T12:01:00Z", slot: 2 },
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T13:00:00Z", slot: 3, mint: otherMint },
    ]);
    await query(
      `INSERT INTO position (kol_id, mint, dirty) VALUES ($1,$2,TRUE), ($1,$3,TRUE)`,
      [kolId, mint, otherMint],
    );

    expect(await recomputeDirty()).toBe(2);
    expect((await position()).dirty).toBe(false);
    expect((await position(otherMint)).dirty).toBe(false);
    expect((await position()).realized_sol).toBe("0.5");
    expect(await recomputeDirty()).toBe(0);
  });

  it("takes no more than the limit it was given", async () => {
    await insertTrades([
      { side: "buy", sol: "2", tokens: "200", at: "2026-08-25T12:00:00Z", slot: 1 },
      { side: "buy", sol: "1", tokens: "100", at: "2026-08-25T13:00:00Z", slot: 2, mint: otherMint },
    ]);
    await query(
      `INSERT INTO position (kol_id, mint, dirty) VALUES ($1,$2,TRUE), ($1,$3,TRUE)`,
      [kolId, mint, otherMint],
    );

    expect(await recomputeDirty(1)).toBe(1);
    const remaining = await query<{ count: string }>(
      "SELECT count(*)::text FROM position WHERE kol_id = $1 AND dirty",
      [kolId],
    );
    expect(remaining[0].count).toBe("1");
  });

  it("refuses a limit that is not a whole, non-negative count", async () => {
    await expect(recomputeDirty(-1)).rejects.toThrow(/non-negative integer/);
    await expect(recomputeDirty(1.5)).rejects.toThrow(/non-negative integer/);
  });
});

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Chain } from "./chain";
import { orderChains, readChainPnl } from "./chain-pnl";
import { query } from "./db";

/**
 * `docs/round-columnas-chain.md` §3. Two properties matter more than the sums:
 * a chain nobody traded on is **absent** rather than zero, and a group with any
 * unpriced sell reports `null` rather than the total of the priced half.
 */
const FROM = new Date("2026-09-01T00:00:00Z");
const TO = new Date("2026-09-08T00:00:00Z");

async function kol(slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, status, approved_at)
     VALUES ($1::uuid, $2, $2, $3::citext, 'approved', now())`,
    [id, slug, slug],
  );
  return id;
}

async function wallet(kolId: string, chain: Chain): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol_wallet (id, kol_id, chain, address_hmac, address_enc, status)
     VALUES ($1::uuid, $2::uuid, $3, $4, $4, 'active')`,
    [id, kolId, chain, randomBytes(32)],
  );
  return id;
}

/**
 * `chain` is passed explicitly and must match the wallet's.
 *
 * `migrations/011` ties them with a composite foreign key so an ingestor cannot
 * file a BNB trade against a Solana wallet. The first version of this fixture
 * let `trade.chain` take its `'solana'` default and Postgres refused every
 * non-Solana row — the constraint doing exactly its job, on a test.
 */
async function sell(
  kolId: string,
  walletId: string,
  chain: Chain,
  realized: string,
  usd: string | null,
): Promise<void> {
  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                        chain, mint, side, token_amount, sol_amount, usd_amount, sol_usd, fee_sol,
                        basis, block_time, realized_sol, realized_usd)
     VALUES (gen_random_uuid(), decode($1,'hex'), decode($1,'hex'), 0, $2::uuid, $3::uuid,
             $4, 'mint-x', 'sell', 1, $5::numeric, 0, 150, 0,
             'known', '2026-09-03T12:00:00Z'::timestamptz, $5::numeric, $6::numeric)`,
    [randomBytes(32).toString("hex"), kolId, walletId, chain, realized, usd],
  );
}

beforeEach(async () => {
  await query("UPDATE kol SET cabal_id = NULL");
  await query("TRUNCATE kol, kol_wallet, trade, position, pnl_daily, pnl_position_daily CASCADE");
});

describe("readChainPnl", () => {
  it("splits one KOL's realized figures by the chain the wallet is on", async () => {
    const id = await kol("ana");
    const sol = await wallet(id, "solana");
    const eth = await wallet(id, "ethereum");
    await sell(id, sol, "solana", "10", "1500");
    await sell(id, sol, "solana", "2.5", "375");
    await sell(id, eth, "ethereum", "0.8", "2400");

    const byKol = await readChainPnl([id], { from: FROM, to: TO });
    expect(orderChains(byKol.get(id)!)).toEqual([
      { chain: "solana", realized: "12.5", realizedUsd: "1875", unpriced: 0 },
      { chain: "ethereum", realized: "0.8", realizedUsd: "2400", unpriced: 0 },
    ]);
  });

  /**
   * The rule the whole feature turns on. A chain nobody traded on has no row, so
   * a surface renders no column — not `0.00`, which would be a measurement
   * nobody made.
   */
  it("leaves a chain out entirely rather than reporting zero", async () => {
    const id = await kol("ana");
    await sell(id, await wallet(id, "solana"), "solana", "3", "450");
    // Wallets on other chains exist and are active; they simply have no trades.
    await wallet(id, "bnb");
    await wallet(id, "robinhood");

    const chains = (await readChainPnl([id], { from: FROM, to: TO })).get(id)!;
    expect(chains.map((c) => c.chain)).toEqual(["solana"]);
  });

  it("has no entry at all for a KOL who closed nothing", async () => {
    const id = await kol("ana");
    await wallet(id, "solana");
    expect((await readChainPnl([id], { from: FROM, to: TO })).has(id)).toBe(false);
  });

  /**
   * "Sin cotizar" is not the sum of the priced half. A total computed over a
   * hole is a number with an invisible gap, which is exactly what the brief's
   * "nunca en cero" is about.
   */
  it("reports null USD for a group with any unpriced sell, and counts them", async () => {
    const id = await kol("ana");
    const eth = await wallet(id, "ethereum");
    await sell(id, eth, "ethereum", "1.5", "4500");
    await sell(id, eth, "ethereum", "0.5", null);

    const [chain] = (await readChainPnl([id], { from: FROM, to: TO })).get(id)!;
    // The native amount is known — it came off the chain — so it is never
    // suppressed.
    expect(chain.realized).toBe("2.0");
    expect(chain.realizedUsd).toBeNull();
    expect(chain.unpriced).toBe(1);
  });

  it("keeps two KOLs' breakdowns apart", async () => {
    const ana = await kol("ana");
    const beto = await kol("beto");
    await sell(ana, await wallet(ana, "solana"), "solana", "5", "750");
    await sell(beto, await wallet(beto, "ethereum"), "ethereum", "0.2", "600");

    const byKol = await readChainPnl([ana, beto], { from: FROM, to: TO });
    expect(byKol.get(ana)!.map((c) => c.chain)).toEqual(["solana"]);
    expect(byKol.get(beto)!.map((c) => c.chain)).toEqual(["ethereum"]);
  });

  /**
   * The fan-out `leaderboard.ts` warns about, asserted rather than reasoned:
   * three wallets on one chain must not triple the figure.
   */
  it("does not multiply a figure by the number of wallets", async () => {
    const id = await kol("ana");
    const first = await wallet(id, "solana");
    await wallet(id, "solana");
    await wallet(id, "solana");
    await sell(id, first, "solana", "9", "1350");

    const [chain] = (await readChainPnl([id], { from: FROM, to: TO })).get(id)!;
    expect(chain.realized).toBe("9");
  });

  it("respects the window bounds", async () => {
    const id = await kol("ana");
    await sell(id, await wallet(id, "solana"), "solana", "4", "600");
    const outside = { from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-02T00:00:00Z") };
    expect((await readChainPnl([id], outside)).size).toBe(0);
  });

  it("returns nothing for an empty id list without touching the database", async () => {
    expect((await readChainPnl([], { from: FROM, to: TO })).size).toBe(0);
  });
});

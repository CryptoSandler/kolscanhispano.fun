import type { Chain } from "./chain";
import { query } from "./db";

/**
 * Realized PnL split by the chain the wallet is on.
 *
 * `docs/round-columnas-chain.md` §3: this is the part of the multichain brief
 * that is genuinely unblocked. `migrations/015` put the realized figure on the
 * sell that produced it and `kol_wallet` carries the chain, so the split is
 * answerable from today's schema — no migration, no ingestion, no key.
 *
 * ## No join at all, because `migrations/011` already did the work
 *
 * The first version of this grouped by `kol_wallet.chain` over a join. It did
 * not need to: **`trade` carries its own `chain`**, and a composite foreign key
 * `(wallet_id, chain) REFERENCES kol_wallet (id, chain)` guarantees it equals
 * the wallet's — which that migration added precisely so "a BNB trade filed
 * against a Solana wallet" is a thing the database refuses rather than a thing
 * a query has to be careful about.
 *
 * So the group is `t.chain` and there is no join to fan out. `leaderboard.ts`
 * warns that joining `kol_wallet` on `kol_id` multiplies every summed row by the
 * number of wallets a KOL has — silently, with every figure still looking like a
 * figure — and this sidesteps the whole class.
 *
 * It still runs as a separate statement from the ranking, because the round
 * recommends the sort not change at all and the safest way to guarantee that is
 * not to touch the query that produces it.
 *
 * ## `null` is "sin cotizar", and it is not zero
 *
 * A chain's USD figure is `null` when **any** sell in the group has no USD
 * value. Not the sum of the ones that do: a total computed over a hole is a
 * number with an invisible gap, and the whole reason the brief asks for "sin
 * cotizar" is that a missing price must not read as a measured zero. So the
 * group is either fully priced or not priced, and the surface says which.
 *
 * The native amount is always known — it comes off the chain — so it is never
 * null and never suppressed.
 */
export type ChainPnl = {
  chain: Chain;
  /** The chain's own unit: SOL on Solana, ETH on the EVM chains. Always known. */
  realized: string;
  /** `null` when any position in the group could not be priced. Never zero for absent. */
  realizedUsd: string | null;
  /** How many of the group's sells had no price, so a surface can say how much is missing. */
  unpriced: number;
};

/**
 * The breakdown for a set of KOLs over one instant range.
 *
 * Keyed by KOL id, and **a KOL with no closed positions is absent from the map
 * rather than present with zeroes** — which is what lets a surface render no
 * column at all. `DESIGN.md`'s rule against zeroed rows, one level down: a
 * column of `0.00` for a chain nothing was measured on is a measurement nobody
 * made.
 */
export async function readChainPnl(
  kolIds: string[],
  bounds: { from: Date; to: Date },
): Promise<Map<string, ChainPnl[]>> {
  if (kolIds.length === 0) return new Map();

  const rows = await query<{
    kol_id: string;
    chain: Chain;
    realized: string;
    realized_usd: string | null;
    unpriced: number;
  }>(
    `SELECT t.kol_id,
            t.chain,
            SUM(t.realized_sol) AS realized,
            -- Fully priced or not priced. Summing the priced half would hide
            -- the gap inside a number that looks complete.
            CASE WHEN count(*) FILTER (WHERE t.realized_usd IS NULL) > 0
                 THEN NULL
                 ELSE SUM(t.realized_usd)
            END AS realized_usd,
            count(*) FILTER (WHERE t.realized_usd IS NULL)::int AS unpriced
       FROM trade t
      WHERE t.kol_id = ANY($1::uuid[])
        AND t.realized_sol IS NOT NULL
        AND t.block_time >= $2::timestamptz AND t.block_time < $3::timestamptz
      GROUP BY t.kol_id, t.chain
      ORDER BY t.kol_id, t.chain`,
    [kolIds, bounds.from.toISOString(), bounds.to.toISOString()],
  );

  const byKol = new Map<string, ChainPnl[]>();
  for (const row of rows) {
    const list = byKol.get(row.kol_id) ?? [];
    list.push({
      chain: row.chain,
      realized: row.realized,
      realizedUsd: row.realized_usd,
      unpriced: row.unpriced,
    });
    byKol.set(row.kol_id, list);
  }
  return byKol;
}

/**
 * The chains a breakdown actually has rows for, in a stable order.
 *
 * **A chain with no ingestion produces no rows and therefore no column.** That
 * is the brief's rule and it falls out of the data rather than being enforced by
 * a flag check on the surface: nothing indexed it, so nothing summed it, so
 * there is nothing to render. A flag that was on but had produced no trades
 * would behave identically, which is correct — the column says "we measured
 * this", not "we intended to".
 */
/**
 * **ETH, BNB, SOL** — the mould's column order, measured at 1440 on 2026-09-05:
 * `+11.75 ETH  +0.24 BNB  ---`. Not alphabetical and not our own history's
 * Solana-first; it is theirs, which is what a 1:1 clone means here.
 */
export const CHAIN_ORDER: readonly Chain[] = ["ethereum", "robinhood", "bnb", "solana"];

export function orderChains(entries: ChainPnl[]): ChainPnl[] {
  return [...entries].sort(
    (a, b) => CHAIN_ORDER.indexOf(a.chain) - CHAIN_ORDER.indexOf(b.chain),
  );
}

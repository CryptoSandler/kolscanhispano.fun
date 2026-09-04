/**
 * A wallet the project does not track must not reach a reader.
 *
 * This is not hypothetical. The Helius webhook is registered against one
 * **verification address** — an active trader picked to prove deliveries
 * arrive, belonging to nobody, listed in no roster — because Helius refuses
 * to create a webhook with an empty address list and `kol_wallet` is empty
 * until the roster batch. So production is, right now, receiving and storing
 * the raw transactions of a wallet that is not a KOL, and will keep doing so
 * until that address is replaced.
 *
 * Three independent things stop it from ever being published, and this file
 * pins all three, because each could be removed without the other two
 * noticing:
 *
 * 1. `parsePending` skips any address that is not an active `kol_wallet`, so
 *    no `trade` row is written for it at all. This is the behavioural one,
 *    the one a refactor could plausibly break, and the reason this file
 *    leads with it.
 * 2. `trade.kol_id` is `NOT NULL REFERENCES kol (id)`, so a trade cannot
 *    exist without a KOL even if something bypassed the parser.
 * 3. Both public readers are anchored on `kol` — the feed inner-joins it,
 *    the leaderboard selects from it — so an orphan trade could not surface
 *    even if one existed.
 *
 * When the roster batch replaces the verification address with real wallets
 * driven from `kol_wallet` (spec §5.5), this file stops describing a live
 * situation and becomes an ordinary regression test. It should stay either
 * way: "an untracked wallet is invisible" is a property of the product, not
 * a property of this month's configuration.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { readFeedPage } from "./feed";
import { buildSwapPayload } from "./fixtures/swap";
import { inventAddress } from "./ids";
import { readLeaderboard } from "./leaderboard";
import { parsePending } from "./parse-swap";
import { storeRawTx } from "./raw-tx";

beforeEach(async () => {
  await query("TRUNCATE raw_tx, trade, position, pnl_daily, pnl_position_daily, kol_wallet, kol CASCADE");
});

/** A swap by a wallet nobody registered — exactly what the webhook is delivering today. */
async function storeUntrackedSwap(): Promise<void> {
  const stranger = inventAddress();
  await storeRawTx({
    signature: inventAddress() + inventAddress(),
    slot: 1,
    source: "webhook",
    blockTime: new Date(),
    payload: buildSwapPayload({
      wallet: stranger,
      mint: inventAddress(),
      decimals: 6,
      nativeChangeLamports: -1_000_005_000,
      tokenChangeRaw: "2000000",
      isFeePayer: true,
      feeLamports: 5_000,
    }),
  });
}

describe("a wallet the project does not track", () => {
  it("produces no trade at all when the parser runs", async () => {
    await storeUntrackedSwap();

    await parsePending();

    const [{ n }] = await query<{ n: string }>("SELECT count(*)::text AS n FROM trade");
    expect(n).toBe("0");
  });

  it("does not stall the queue behind it", async () => {
    await storeUntrackedSwap();

    await parsePending();

    // Settled, not errored: there is nothing wrong with the payload, and a
    // row that stayed pending would be re-read on every run for ever.
    const [row] = await query<{ parsed: boolean; err: string | null }>(
      "SELECT parsed_at IS NOT NULL AS parsed, parse_error AS err FROM raw_tx",
    );
    expect(row).toMatchObject({ parsed: true, err: null });
  });

  it("appears on no public surface", async () => {
    await storeUntrackedSwap();
    await parsePending();

    expect((await readFeedPage()).trades).toEqual([]);
    expect((await readLeaderboard({ window: "1d" })).entries).toEqual([]);
    expect((await readLeaderboard({ window: "7d" })).entries).toEqual([]);
  });

  it("could not be published even if a trade were written around the parser", async () => {
    // The schema, not the code, is what makes this one true. A migration
    // that relaxed either property would fail here rather than quietly
    // widening what can be shown.
    const [col] = await query<{ nullable: string }>(
      `SELECT is_nullable AS nullable FROM information_schema.columns
        WHERE table_name = 'trade' AND column_name = 'kol_id'`,
    );
    expect(col.nullable).toBe("NO");

    const [fk] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage k USING (constraint_name)
        WHERE tc.table_name = 'trade' AND tc.constraint_type = 'FOREIGN KEY'
          AND k.column_name = 'kol_id'`,
    );
    expect(fk.n).toBe("1");
  });
});

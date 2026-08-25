import { beforeEach, describe, expect, it } from "vitest";
import { seedDev } from "../../scripts/seed-dev.mts";
import { query } from "./db";
import { findWalletByAddress } from "./wallets";

beforeEach(async () => {
  await query("TRUNCATE kol, cabal, kol_wallet, sol_price CASCADE");
});

describe("seedDev", () => {
  it("creates an approved KOL with a cabal and a wallet", async () => {
    const { kolId, address } = await seedDev();

    const [kol] = await query<{ status: string; hide_wallets: boolean; cabal_id: string | null }>(
      "SELECT status, hide_wallets, cabal_id FROM kol WHERE id = $1", [kolId]);
    expect(kol.status).toBe("approved");
    expect(kol.hide_wallets).toBe(true);
    expect(kol.cabal_id).not.toBeNull();

    expect((await findWalletByAddress(address))?.kol_id).toBe(kolId);
  });

  it("seeds a SOL price so trades can be valued in USD", async () => {
    await seedDev();
    const [row] = await query<{ count: string }>("SELECT count(*) FROM sol_price");
    expect(Number(row.count)).toBeGreaterThan(0);
  });

  it("is idempotent", async () => {
    const first = await seedDev();
    const second = await seedDev();
    expect(second.kolId).toBe(first.kolId);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM kol");
    expect(Number(row.count)).toBe(1);
  });
});

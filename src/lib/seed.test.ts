import { beforeEach, describe, expect, it } from "vitest";
import { seedDev } from "../../scripts/seed-dev";
import { query } from "./db";
import { findWalletByAddress } from "./wallets";
import { revealAddress } from "./wallets";

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
    expect(second.walletId).toBe(first.walletId);
    expect(second.address).toBe(first.address);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM kol");
    expect(Number(row.count)).toBe(1);
    // Verify the address round-trips through revealAddress
    const revealed = await revealAddress(first.walletId);
    expect(revealed).toBe(first.address);
  });

  it("self-heals when KOL exists but wallet was deleted", async () => {
    const first = await seedDev();
    // Simulate a partial seed by deleting the wallet row
    await query("DELETE FROM kol_wallet WHERE kol_id = $1", [first.kolId]);
    // Call seedDev again - it should create a new wallet
    const second = await seedDev();
    expect(second.kolId).toBe(first.kolId);
    // The wallet should be new (different ID)
    expect(second.walletId).not.toBe(first.walletId);
    // The address should be valid and round-trip
    const revealed = await revealAddress(second.walletId);
    expect(revealed).toBe(second.address);
    // Verify we can find it by address
    expect((await findWalletByAddress(second.address))?.kol_id).toBe(first.kolId);
  });
});

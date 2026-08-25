import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { inventAddress } from "./ids";
import { addWallet, findWalletByAddress, revealAddress } from "./wallets";

async function makeKol(handle: string): Promise<string> {
  const id = crypto.randomUUID();
  await query("INSERT INTO kol (id, slug, display_name, x_handle, status) VALUES ($1,$2,$3,$4,'approved')",
    [id, handle, handle, handle]);
  return id;
}

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet CASCADE");
});

describe("wallets", () => {
  it("stores an address and finds it again", async () => {
    const kol = await makeKol("uno");
    const address = inventAddress();
    const walletId = await addWallet(kol, address);

    const found = await findWalletByAddress(address);
    expect(found?.id).toBe(walletId);
    expect(found?.kol_id).toBe(kol);
  });

  it("stores no plaintext address in the row", async () => {
    const kol = await makeKol("dos");
    const address = inventAddress();
    await addWallet(kol, address);

    const [row] = await query<{ blob: string }>(
      "SELECT kol_wallet::text AS blob FROM kol_wallet");
    expect(row.blob).not.toContain(address);
  });

  it("returns null for an address nobody registered", async () => {
    expect(await findWalletByAddress(inventAddress())).toBeNull();
  });

  it("refuses the same address under a second KOL", async () => {
    const a = await makeKol("tres");
    const b = await makeKol("cuatro");
    const address = inventAddress();
    await addWallet(a, address);
    await expect(addWallet(b, address)).rejects.toThrow();
  });

  it("reveals a stored address only through the explicit call", async () => {
    const kol = await makeKol("cinco");
    const address = inventAddress();
    const walletId = await addWallet(kol, address);
    expect(await revealAddress(walletId)).toBe(address);
  });
});

describe("inventAddress", () => {
  it("produces distinct base58 strings of address length", () => {
    const a = inventAddress();
    expect(a).not.toBe(inventAddress());
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a.length).toBeLessThanOrEqual(44);
  });
});

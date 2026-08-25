import { beforeEach, describe, expect, it } from "vitest";
import { aadFor, decrypt } from "./crypto";
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
    // A ::text cast of the row proves nothing here: Postgres renders bytea as
    // hex, so a bare substring check on that rendering would pass even if
    // address_enc held the raw address bytes with no encryption at all. Read
    // the column as a Buffer instead and check for the plaintext's raw bytes.
    const kol = await makeKol("dos");
    const address = inventAddress();
    await addWallet(kol, address);

    const [row] = await query<{ address_enc: Buffer }>(
      "SELECT address_enc FROM kol_wallet");
    expect(row.address_enc.includes(Buffer.from(address, "utf8"))).toBe(false);
  });

  it("round-trips the stored ciphertext through decrypt, bound to its own wallet id", async () => {
    const kol = await makeKol("dos-b");
    const address = inventAddress();
    const walletId = await addWallet(kol, address);

    const [row] = await query<{ address_enc: Buffer }>(
      "SELECT address_enc FROM kol_wallet WHERE id = $1", [walletId]);
    expect(decrypt(row.address_enc, aadFor("kol_wallet", "address", walletId))).toBe(address);

    // A different wallet id's AAD must not authenticate this ciphertext: this
    // is the property aadFor exists to guarantee, exercised end to end
    // through the actual stored row rather than in isolation.
    const otherWalletId = crypto.randomUUID();
    expect(() => decrypt(row.address_enc, aadFor("kol_wallet", "address", otherWalletId))).toThrow();
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

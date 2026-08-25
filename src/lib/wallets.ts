import { aadFor, blindIndex, decrypt, encrypt } from "./crypto";
import { query } from "./db";

export type WalletRow = { id: string; kol_id: string; status: string };

export async function addWallet(kolId: string, address: string): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol_wallet (id, kol_id, address_enc, address_hmac)
     VALUES ($1, $2, $3, $4)`,
    [id, kolId, encrypt(address, aadFor("kol_wallet", "address", id)), blindIndex(address, "address")],
  );
  return id;
}

/** The only lookup path. Nothing decrypts a table to find a wallet. */
export async function findWalletByAddress(address: string): Promise<WalletRow | null> {
  const rows = await query<WalletRow>(
    "SELECT id, kol_id, status FROM kol_wallet WHERE address_hmac = $1",
    [blindIndex(address, "address")],
  );
  return rows[0] ?? null;
}

/**
 * Decrypts exactly one address. Every caller is either the admin reveal path,
 * which audits the call, or the Helius address-set builder.
 */
export async function revealAddress(walletId: string): Promise<string> {
  const rows = await query<{ address_enc: Buffer }>(
    "SELECT address_enc FROM kol_wallet WHERE id = $1", [walletId]);
  if (!rows[0]) throw new Error(`no wallet ${walletId}`);
  return decrypt(rows[0].address_enc, aadFor("kol_wallet", "address", walletId));
}

import { type Chain, canonicalAddress } from "./chain";
import { aadFor, blindIndex, decrypt, encrypt } from "./crypto";
import { query } from "./db";

export type WalletRow = { id: string; kol_id: string; status: string; chain: Chain };

/**
 * `chain` defaults to `"solana"`, and that default is safe for a reason worth
 * stating rather than assuming.
 *
 * Migration 011 deliberately **drops** the column default in the database, so
 * that a raw `INSERT` which forgets `chain` fails loudly instead of quietly
 * filing an EVM row as Solana. A default here might look like it reopens that
 * hole from the application side. It does not: {@link canonicalAddress}
 * validates the address against the *shape* its chain uses, and an EVM address
 * is `0x` + 40 hex while a Solana one is base58 — which excludes `x` and `0`.
 * So the one mistake the default could cause, an EVM wallet added without
 * naming its chain, throws on the line before the insert.
 *
 * The default therefore costs nothing and keeps every existing Solana caller —
 * about thirty of them, nearly all tests — reading as it did.
 */
export async function addWallet(
  kolId: string,
  address: string,
  chain: Chain = "solana",
): Promise<string> {
  // Canonical *before* both the encryption and the digest, so that what is
  // stored and what is looked up are the same string. Encrypting the raw input
  // instead would make `revealAddress` return a form that no longer hashes to
  // the row's own `address_hmac`.
  const canonical = canonicalAddress(address, chain);
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol_wallet (id, kol_id, chain, address_enc, address_hmac)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      kolId,
      chain,
      encrypt(canonical, aadFor("kol_wallet", "address", id)),
      blindIndex(canonical, "address"),
    ],
  );
  return id;
}

/**
 * The only lookup path. Nothing decrypts a table to find a wallet.
 *
 * Scoped to one chain because `address_hmac` is no longer globally unique:
 * migration 011 makes it `UNIQUE (chain, address_hmac)`, since the same EVM
 * address is a distinct wallet on BNB and on Ethereum.
 */
export async function findWalletByAddress(
  address: string,
  chain: Chain = "solana",
): Promise<WalletRow | null> {
  const rows = await query<WalletRow>(
    "SELECT id, kol_id, status, chain FROM kol_wallet WHERE chain = $1 AND address_hmac = $2",
    [chain, blindIndex(canonicalAddress(address, chain), "address")],
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

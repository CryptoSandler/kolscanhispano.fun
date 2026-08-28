import { beforeAll, describe, expect, it } from "vitest";
import { KEY_VERSION } from "./crypto";
import { query } from "./db";
import { inventAddress } from "./ids";
import { addWallet } from "./wallets";

const uuid = () => crypto.randomUUID();

async function truncate() {
  await query("TRUNCATE kol, cabal, kol_wallet, raw_tx, trade, position, pnl_daily, token, sol_price, audit_log CASCADE");
}

describe("core schema", () => {
  beforeAll(truncate);

  it("stores a KOL that hides its wallets by default", async () => {
    const id = uuid();
    await query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
      [id, "ejemplo", "Ejemplo", "ejemplo"]);
    const [row] = await query<{ hide_wallets: boolean; status: string }>(
      "SELECT hide_wallets, status FROM kol WHERE id = $1", [id]);
    expect(row.hide_wallets).toBe(true);
    expect(row.status).toBe("pending");
  });

  it("rejects the same X handle twice, case-insensitively", async () => {
    await query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
      [uuid(), "dup-a", "A", "Repetido"]);
    await expect(
      query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
        [uuid(), "dup-b", "B", "repetido"]),
    ).rejects.toThrow();
  });

  it("rejects the same wallet blind index under two KOLs", async () => {
    const hmac = Buffer.from("a".repeat(64), "hex");
    const first = uuid(), second = uuid();
    await query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
      [first, "w-a", "A", "wa"]);
    await query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
      [second, "w-b", "B", "wb"]);
    await query(
      "INSERT INTO kol_wallet (id, kol_id, address_enc, address_hmac) VALUES ($1,$2,$3,$4)",
      [uuid(), first, Buffer.from("x"), hmac]);
    await expect(
      query("INSERT INTO kol_wallet (id, kol_id, address_enc, address_hmac) VALUES ($1,$2,$3,$4)",
        [uuid(), second, Buffer.from("y"), hmac]),
    ).rejects.toThrow();
  });

  it("keeps money as numeric, not double precision", async () => {
    const [row] = await query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'trade' AND column_name = 'sol_amount'`);
    expect(row.data_type).toBe("numeric");
  });

  it("keeps slot as bigint for replay ordering", async () => {
    const [row] = await query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'trade' AND column_name = 'slot'`);
    expect(row.data_type).toBe("bigint");
  });

  it("rejects the same signature, instruction and wallet twice", async () => {
    const kolId = uuid();
    const walletId = uuid();
    await query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
      [kolId, "trade-dup", "Trade Dup", "tradedup"]);
    await query(
      "INSERT INTO kol_wallet (id, kol_id, address_enc, address_hmac) VALUES ($1,$2,$3,$4)",
      [walletId, kolId, Buffer.from("x"), Buffer.from("b".repeat(64), "hex")]);

    const signatureHmac = Buffer.from("c".repeat(64), "hex");
    const trade = (id: string) => query(
      `INSERT INTO trade
         (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
          mint, side, token_amount, sol_amount, block_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, signatureHmac, Buffer.from("sig"), 0, kolId, walletId,
        "So11111111111111111111111111111111111111112", "buy", 1000, 1, new Date()]);

    await trade(uuid());
    await expect(trade(uuid())).rejects.toThrow();
  });
});


/**
 * L-2, migration 010. `key_version` was a `SMALLINT NOT NULL DEFAULT 1` on
 * `kol_wallet` and `raw_tx` that no statement in this repository ever named, so
 * every row said 1 because the default said 1 -- and a rotation to a v2 key
 * would have left `key_version = 1` on every v2 row.
 *
 * The version it duplicated is byte 0 of the blob, and that copy is folded into
 * the AEAD's additional authenticated data, so it cannot disagree with what
 * `decrypt()` will do. These two cases are the pair: the redundant column is
 * gone, and the question it existed to answer is still answerable in SQL
 * without decrypting anything.
 */
describe("key_version: dropped, and still answerable from the ciphertext", () => {
  it.each([
    ["kol_wallet", "address_enc"],
    ["raw_tx", "payload_enc"],
  ])("%s no longer carries a key_version column", async (table) => {
    const rows = await query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'key_version'",
      [table],
    );
    expect(rows).toEqual([]);
  });

  it("answers 'how many rows are still v1' off the authenticated version byte", async () => {
    await truncate();
    const kolId = uuid();
    await query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
      [kolId, "kv", "KV", "kv"]);
    await addWallet(kolId, inventAddress());

    const rows = await query<{ version: number; count: string }>(
      "SELECT get_byte(address_enc, 0) AS version, count(*)::text AS count FROM kol_wallet GROUP BY 1",
    );
    expect(rows).toEqual([{ version: KEY_VERSION, count: "1" }]);
  });
});

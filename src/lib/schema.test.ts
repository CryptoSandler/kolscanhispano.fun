import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./db";

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

  it("enforces one trade per signature, instruction and wallet", async () => {
    const [row] = await query<{ count: string }>(
      `SELECT count(*) FROM pg_indexes
       WHERE tablename = 'trade' AND indexdef ILIKE '%UNIQUE%signature_hmac%instruction_index%wallet_id%'`);
    expect(Number(row.count)).toBe(1);
  });
});

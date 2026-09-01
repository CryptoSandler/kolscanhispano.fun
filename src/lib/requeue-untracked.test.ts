import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { blindIndex, encrypt, aadFor } from "./crypto";
import { query } from "./db";
import { inventAddress, inventSignature } from "./ids";
import { requeueUntracked } from "./requeue-untracked";
import { addWallet } from "./wallets";

/**
 * `docs/padron.md` §3. The rows this moves are the ones that **succeeded**, so
 * every case here is about telling that state apart from the two it sits
 * between: a row that was refused, and a row that produced a trade.
 */

async function storeRaw(options: {
  parsed: boolean;
  error?: string | null;
  blockTime: string;
}): Promise<Buffer> {
  const signature = inventSignature();
  const hmac = blindIndex(signature, "signature");
  await query(
    `INSERT INTO raw_tx (signature_hmac, signature_enc, payload_enc, chain, block_time, source,
                         parsed_at, parse_error)
     VALUES ($1, $2, $3, 'solana', $4::timestamptz, 'webhook',
             CASE WHEN $5 THEN now() END, $6)`,
    [hmac, randomBytes(16), randomBytes(16), options.blockTime, options.parsed,
     options.error ?? null],
  );
  return hmac;
}

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, pnl_daily, pnl_position_daily CASCADE");
});

describe("requeueUntracked", () => {
  it("moves a parsed row that produced no trade back into the queue", async () => {
    await storeRaw({ parsed: true, blockTime: "2026-08-30T12:00:00Z" });

    const result = await requeueUntracked();
    expect(result).toEqual({ requeued: 1, remaining: 0 });

    const [row] = await query<{ parsed_at: Date | null }>("SELECT parsed_at FROM raw_tx");
    expect(row.parsed_at).toBeNull();
  });

  it("leaves a row that already produced a trade alone", async () => {
    // The idempotence this rests on is `insertTrade`'s ON CONFLICT, but there
    // is no reason to re-decrypt and re-parse a row whose work is done.
    const kolId = randomUUID();
    await query(
      `INSERT INTO kol (id, slug, display_name, x_handle, status, approved_at)
       VALUES ($1,'uno','Uno','uno','approved',now())`, [kolId]);
    const walletId = await addWallet(kolId, inventAddress());

    const hmac = await storeRaw({ parsed: true, blockTime: "2026-08-30T12:00:00Z" });
    const tradeId = randomUUID();
    await query(
      `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                          chain, mint, side, token_amount, sol_amount, block_time)
       VALUES ($1,$2,$3,0,$4,$5,'solana','m','buy',1,1,now())`,
      [tradeId, hmac, encrypt("x", aadFor("trade", "signature", tradeId)), kolId, walletId],
    );

    expect(await requeueUntracked()).toEqual({ requeued: 0, remaining: 0 });
    const [row] = await query<{ parsed_at: Date | null }>("SELECT parsed_at FROM raw_tx");
    expect(row.parsed_at).not.toBeNull();
  });

  /**
   * The line this script must not cross. A row carrying a `parse_error` was
   * *refused*, which is `roadmap.md` §1's problem and has its own rules about
   * backoff and exhaustion. Moving it here would silently re-run refusals that
   * were never designed to be retried.
   */
  it("never touches a row that carries a parse error", async () => {
    await storeRaw({ parsed: true, error: "unsupported_quote", blockTime: "2026-08-30T12:00:00Z" });

    expect(await requeueUntracked()).toEqual({ requeued: 0, remaining: 0 });
    const [row] = await query<{ parsed_at: Date | null; parse_error: string }>(
      "SELECT parsed_at, parse_error FROM raw_tx");
    expect(row.parsed_at).not.toBeNull();
    expect(row.parse_error).toBe("unsupported_quote");
  });

  it("ignores a row that is already pending", async () => {
    await storeRaw({ parsed: false, blockTime: "2026-08-30T12:00:00Z" });
    expect(await requeueUntracked()).toEqual({ requeued: 0, remaining: 0 });
  });

  it("respects the limit and reports what is left", async () => {
    for (let i = 0; i < 5; i += 1) {
      // 20th to 24th: an earlier draft built `2026-08-3${i}` and asked Postgres
      // for the 32nd of August.
      await storeRaw({ parsed: true, blockTime: `2026-08-2${i}T12:00:00Z` });
    }
    expect(await requeueUntracked(2)).toEqual({ requeued: 2, remaining: 3 });
    expect(await requeueUntracked(2)).toEqual({ requeued: 2, remaining: 1 });
    expect(await requeueUntracked(2)).toEqual({ requeued: 1, remaining: 0 });
    expect(await requeueUntracked(2)).toEqual({ requeued: 0, remaining: 0 });
  });

  it("takes the newest rows first", async () => {
    // A reader who adds a KOL wants that KOL's recent activity to appear, and
    // an operator who stops after one batch should have moved the rows that
    // matter most.
    const old = await storeRaw({ parsed: true, blockTime: "2026-08-01T12:00:00Z" });
    const recent = await storeRaw({ parsed: true, blockTime: "2026-08-31T12:00:00Z" });

    expect(await requeueUntracked(1)).toEqual({ requeued: 1, remaining: 1 });
    const pending = await query<{ signature_hmac: Buffer }>(
      "SELECT signature_hmac FROM raw_tx WHERE parsed_at IS NULL");
    expect(pending).toHaveLength(1);
    expect(pending[0].signature_hmac).toEqual(recent);
    expect(pending[0].signature_hmac).not.toEqual(old);
  });

  it("is re-runnable: a second full pass moves nothing", async () => {
    await storeRaw({ parsed: true, blockTime: "2026-08-30T12:00:00Z" });
    expect((await requeueUntracked()).requeued).toBe(1);
    expect(await requeueUntracked()).toEqual({ requeued: 0, remaining: 0 });
  });

  it("refuses a limit that is not a positive integer", async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(requeueUntracked(limit)).rejects.toThrow(/positive integer/);
    }
  });
});

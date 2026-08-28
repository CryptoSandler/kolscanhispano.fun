/**
 * Proves the properties migrations/004_dirty_sweep.sql exists for.
 *
 * A migration that "marks every position dirty" is trivially green if you
 * only assert the flag: a mutant that scopes the UPDATE to the wrong subset,
 * or a mutant that never gets recorded as applied, can still pass a test
 * that only checks the flag on the one row it happened to seed. The test
 * that actually matters -- and the one every mutation below is checked
 * against -- constructs a position whose stored realized_sol and win/loss
 * predate batch 1's fee fix (src/lib/pnl.ts, applyTrade), applies the
 * migration, runs the real recompute, and checks the numbers actually
 * change to the fee-corrected ones. See that test's comment for the worked
 * arithmetic.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "../src/lib/db";
import { inventAddress } from "../src/lib/ids";
import { recomputeDirty } from "../src/lib/pnl";
import { addWallet } from "../src/lib/wallets";

const run = promisify(execFile);

const MIGRATION_PATH = fileURLToPath(new URL("../migrations/004_dirty_sweep.sql", import.meta.url));
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

async function makeKol(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    "INSERT INTO kol (id, slug, display_name, x_handle, status) VALUES ($1,$2,$3,$4,'approved')",
    [id, id, id, id],
  );
  return id;
}

function randomHex(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

/** A clean position row, as a replay under any version of the code would leave it. */
async function insertCleanPosition(kolId: string, mint: string): Promise<void> {
  await query(
    `INSERT INTO position (kol_id, mint, qty, cost_sol, avg_cost_sol, realized_sol, realized_usd,
                           basis, dirty)
     VALUES ($1, $2, '0', '0', '0', '0', '0', 'known', FALSE)`,
    [kolId, mint],
  );
}

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet, trade, position, pnl_daily, pnl_position_daily CASCADE");
});

describe("migrations/004_dirty_sweep.sql", () => {
  it("marks every existing position dirty, across kols and mints, regardless of its prior flag", async () => {
    const kolA = await makeKol();
    const kolB = await makeKol();
    const mintA = inventAddress();
    const mintB = inventAddress();
    const mintC = inventAddress();

    await insertCleanPosition(kolA, mintA);
    await insertCleanPosition(kolA, mintB);
    await insertCleanPosition(kolB, mintC);
    // Already dirty, to prove the migration does not need a prior state to work from.
    await query(
      `INSERT INTO position (kol_id, mint, qty, cost_sol, avg_cost_sol, realized_sol, realized_usd,
                             basis, dirty)
       VALUES ($1, $2, '0', '0', '0', '0', '0', 'known', TRUE)`,
      [kolB, inventAddress()],
    );

    await query(MIGRATION_SQL);

    const rows = await query<{ dirty: boolean }>("SELECT dirty FROM position");
    expect(rows.length).toBe(4);
    expect(rows.every((row) => row.dirty === true)).toBe(true);
  });

  it("is idempotent at the SQL level: applying it twice leaves every position dirty", async () => {
    const kolId = await makeKol();
    await insertCleanPosition(kolId, inventAddress());
    await insertCleanPosition(kolId, inventAddress());

    await query(MIGRATION_SQL);
    await query(MIGRATION_SQL);

    const rows = await query<{ dirty: boolean }>("SELECT dirty FROM position");
    expect(rows.every((row) => row.dirty === true)).toBe(true);
  });

  it(
    "is recorded once by the runner: a second run does not reapply it",
    async () => {
      // Reset just this migration's bookkeeping so the test is meaningful
      // regardless of whether an earlier `npm run db:migrate:test` already
      // applied it for real.
      await query("DELETE FROM schema_migrations WHERE version = '004_dirty_sweep'");

      const first = await run("npx", ["tsx", "scripts/migrate.mts", "--test"], { timeout: 20_000 });
      expect(first.stdout).toContain("Applied 004_dirty_sweep");

      const second = await run("npx", ["tsx", "scripts/migrate.mts", "--test"], { timeout: 20_000 });
      expect(second.stdout).not.toContain("Applied 004_dirty_sweep");

      const rows = await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM schema_migrations WHERE version = '004_dirty_sweep'",
      );
      expect(rows[0].count).toBe("1");
    },
    20_000,
  );

  /**
   * The property that matters. Builds a position exactly as batch 1's bug
   * would have left it: a real trade with a real fee_sol, replayed by code
   * that never charged the fee, its wrong answer written and the row marked
   * clean. Nothing in this system would ever look at it again without this
   * migration.
   *
   * Worked numbers, fee-corrected (see applyTrade's header, spec §4.4):
   *   buy:  cost  = sol_amount + fee = 1 + 0.05 = 1.05
   *   sell: net   = sol_amount - fee = 1.02 - 0.05 = 0.97
   *   realized = net - cost = 0.97 - 1.05 = -0.08  -> a loss
   *
   * Pre-fix (fee ignored entirely, which is what actually ran and is what
   * this test writes as the "stale" starting state):
   *   realized = 1.02 - 1.00 = 0.02  -> recorded as a win
   *
   * A round trip that lost 0.08 SOL was on record as a 0.02 SOL win. If the
   * migration is a no-op, sets dirty back to FALSE, or scopes its UPDATE to
   * exclude this row, recomputeDirty's `WHERE dirty` never selects it and
   * these stale numbers survive unchanged -- which is exactly what this test
   * checks for.
   */
  it("turns a stale pre-fee-fix position into the fee-corrected figures once dirtied and recomputed", async () => {
    const kolId = await makeKol();
    const walletId = await addWallet(kolId, inventAddress());
    const mint = inventAddress();

    await query(
      `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, slot, kol_id,
                          wallet_id, mint, side, token_amount, sol_amount, usd_amount, sol_usd,
                          fee_sol, basis, block_time)
       VALUES
         (gen_random_uuid(), decode($1,'hex'), decode($1,'hex'), 0, 1, $3, $4, $5, 'buy',
          '100', '1', NULL, NULL, '0.05', 'known', '2026-08-20T12:00:00Z'),
         (gen_random_uuid(), decode($2,'hex'), decode($2,'hex'), 0, 2, $3, $4, $5, 'sell',
          '100', '1.02', NULL, NULL, '0.05', 'known', '2026-08-20T12:01:00Z')`,
      [randomHex(), randomHex(), kolId, walletId, mint],
    );

    // The stale state batch 1 left behind, written directly: replayPosition
    // now has the fee fix and could not reproduce the old bug itself.
    const staleRealized = "0.02";
    await query(
      `INSERT INTO position (kol_id, mint, qty, cost_sol, avg_cost_sol, realized_sol, realized_usd,
                             first_buy_at, last_trade_at, basis, dirty)
       VALUES ($1, $2, '0', '0', '0', $3, '0', '2026-08-20T12:00:00Z', '2026-08-20T12:01:00Z',
               'known', FALSE)`,
      [kolId, mint, staleRealized],
    );
    await query(
      `INSERT INTO pnl_position_daily (kol_id, mint, day, realized_sol, realized_usd, wins, losses)
       VALUES ($1, $2, '2026-08-20', $3, '0', 1, 0)`,
      [kolId, mint, staleRealized],
    );
    await query(
      `INSERT INTO pnl_daily (kol_id, day, realized_sol, realized_usd, wins, losses)
       VALUES ($1, '2026-08-20', $2, '0', 1, 0)`,
      [kolId, staleRealized],
    );

    // Sanity: this position is clean, so the cron alone would never touch it.
    const [before] = await query<{ dirty: boolean }>(
      "SELECT dirty FROM position WHERE kol_id = $1 AND mint = $2",
      [kolId, mint],
    );
    expect(before.dirty).toBe(false);

    await query(MIGRATION_SQL);

    const replayed = await recomputeDirty();
    expect(replayed).toBeGreaterThanOrEqual(1);

    const [position] = await query<{ realized_sol: string; dirty: boolean }>(
      "SELECT realized_sol::text, dirty FROM position WHERE kol_id = $1 AND mint = $2",
      [kolId, mint],
    );
    expect(position.realized_sol).toBe("-0.08");
    expect(position.realized_sol).not.toBe(staleRealized);
    expect(position.dirty).toBe(false); // the replay this migration triggered cleared it again

    const [day] = await query<{ wins: number; losses: number; realized_sol: string }>(
      `SELECT wins, losses, realized_sol::text FROM pnl_daily WHERE kol_id = $1 AND day = '2026-08-20'`,
      [kolId],
    );
    expect(day.realized_sol).toBe("-0.08");
    // The stale row recorded a win; the corrected figure is a loss.
    expect(day.wins).toBe(0);
    expect(day.losses).toBe(1);
  });
});


/**
 * F7. Until 2026-08-28, `tsx scripts/migrate.mts` with no flag applied DDL to
 * `DATABASE_URL` -- production -- while `--test` and `--preview` each asserted
 * something about their target first. The shortest, most typeable invocation in
 * the repo was the only unguarded one.
 *
 * These run the real binary as a subprocess and never reach a connection: the
 * refusal happens on `process.argv` alone, before any variable is read.
 */
describe("migrate.mts: the target is named, never defaulted into", () => {
  async function migrateWith(args: string[]): Promise<{ code: number; stderr: string }> {
    try {
      await run("npx", ["tsx", "scripts/migrate.mts", ...args], { timeout: 20_000 });
      return { code: 0, stderr: "" };
    } catch (error) {
      const e = error as { code?: number; stderr?: string };
      return { code: e.code ?? 1, stderr: e.stderr ?? "" };
    }
  }

  it("refuses to run with no flag at all, and says what to type", async () => {
    const { code, stderr } = await migrateWith([]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("Name the database");
    expect(stderr).toContain("--prod");
    // And it stopped before it touched anything: the announcement line is the
    // first thing a run that got as far as resolving a target prints.
    expect(stderr).not.toContain("Applying migrations to");
  }, 20_000);

  it.each([
    ["--test", "--prod"],
    ["--preview", "--prod"],
    ["--test", "--preview"],
  ])("refuses %s together with %s", async (a, b) => {
    const { code, stderr } = await migrateWith([a, b]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("pass exactly one");
  }, 20_000);
});

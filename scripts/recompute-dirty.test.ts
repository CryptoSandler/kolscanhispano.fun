/**
 * Exercises scripts/recompute-dirty.ts's `main()` in-process, the same way a
 * scheduled run or a `workflow_dispatch` invokes it -- against the real
 * `withLock` dedicated connection and the real shared pool -- without paying
 * a subprocess's tsx-transform-and-reconnect cost for every property under
 * test. (An early version of this file spawned `npx tsx` once per case --
 * sixteen subprocesses total across this file and parse-pending.test.ts --
 * which slowed the whole suite 4.7x and put enough concurrent connection
 * pressure on Neon to make an unrelated file's setup query fail outright.)
 * Exactly one test below still spawns the real binary, to prove the wiring
 * (the shebang-equivalent entry-point guard, the exit code, the printed
 * line) actually works end to end; every other property is reachable
 * in-process through the exported `main`.
 *
 * The replay logic itself (recomputeDirty/replayPosition) already has its
 * own test suite in src/lib/pnl.test.ts; what this file covers is the CLI
 * wrapper's own contract: the properties Task 2 states.
 *
 * - Running the script twice in a row is idempotent.
 * - A second run while the first holds the lock returns cleanly (code 0)
 *   having done nothing, and its output says so in words a successful run
 *   never uses -- "did nothing" and "ran the work" must never look alike.
 * - A failure returns non-zero, distinguishably from the "did nothing" case.
 * - No secret is ever printed, on any path.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../src/lib/db";
import { inventAddress } from "../src/lib/ids";
import { withLock } from "../src/lib/lock";
import * as pnl from "../src/lib/pnl";
import { addWallet } from "../src/lib/wallets";
import { main } from "./recompute-dirty";

const run = promisify(execFile);

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

/** One buy trade and a dirty position row -- enough for one replayPosition call to do real work. */
async function seedOneDirtyPosition(): Promise<{ kolId: string; mint: string }> {
  const kolId = await makeKol();
  const walletId = await addWallet(kolId, inventAddress());
  const mint = inventAddress();

  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, slot, kol_id,
                        wallet_id, mint, side, token_amount, sol_amount, usd_amount, sol_usd,
                        fee_sol, basis, block_time)
     VALUES (gen_random_uuid(), decode($1,'hex'), decode($1,'hex'), 0, 1, $2, $3, $4, 'buy',
             '2', '1', NULL, NULL, '0.000005', 'known', now())`,
    [randomHex(), kolId, walletId, mint],
  );
  await query(
    `INSERT INTO position (kol_id, mint, dirty) VALUES ($1, $2, TRUE)
     ON CONFLICT (kol_id, chain, mint) DO UPDATE SET dirty = TRUE`,
    [kolId, mint],
  );

  return { kolId, mint };
}

describe("scripts/recompute-dirty.ts: main()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, trade, position, pnl_daily, pnl_position_daily CASCADE");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("is idempotent: a second run finds nothing left dirty after the first", async () => {
    const { kolId, mint } = await seedOneDirtyPosition();

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("recompute-dirty: replayed 1 position(s)");

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("recompute-dirty: replayed 0 position(s)");

    const [position] = await query<{ dirty: boolean; qty: string }>(
      "SELECT dirty, qty FROM position WHERE kol_id = $1 AND mint = $2",
      [kolId, mint],
    );
    expect(position.dirty).toBe(false);
    expect(position.qty).toBe("2");
  });

  it("returns 0 and reports doing nothing when another run already holds the lock", async () => {
    let code: number | undefined;
    await withLock("recompute-dirty", async () => {
      code = await main();
    });

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("recompute-dirty: another run holds the lock; did nothing");
    // The two outcomes must never share wording: a "did nothing" run must
    // not also claim to have replayed any positions.
    expect(logSpy.mock.calls.flat().join("\n")).not.toMatch(/replayed \d+ position/);
  });

  it("returns non-zero, distinguishably from the lock-busy case, when the work throws", async () => {
    const spy = vi.spyOn(pnl, "recomputeDirty").mockRejectedValueOnce(new Error("simulated failure"));

    const code = await main();

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("recompute-dirty: failed -- simulated failure");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("did nothing");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("replayed");
    spy.mockRestore();
  });

  it("never logs a secret, on a normal run or a failing one", async () => {
    const secrets = [
      process.env.DATABASE_URL,
      process.env.TEST_DATABASE_URL,
      process.env.WALLET_ENC_KEY,
      process.env.WALLET_HMAC_KEY,
      process.env.HELIUS_WEBHOOK_SECRET,
    ].filter((value): value is string => Boolean(value));
    expect(secrets.length).toBeGreaterThan(0); // the check below is vacuous otherwise

    await main();
    const spy = vi.spyOn(pnl, "recomputeDirty").mockRejectedValueOnce(new Error("simulated failure"));
    await main();
    spy.mockRestore();

    const allOutput = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join("\n");
    for (const secret of secrets) {
      expect(allOutput).not.toContain(secret);
    }
  });
});

// The one true end-to-end case: proves the file actually runs as a script
// (the entry-point guard fires, the process exits with the code `main()`
// returned, and the real line reaches real stdout) rather than only ever
// being exercised as an imported module.
describe("scripts/recompute-dirty.ts: end-to-end wiring", () => {
  it(
    "runs as a real subprocess and exits 0 with the expected line on stdout",
    async () => {
      const { stdout, stderr } = await run("npx", ["tsx", "scripts/recompute-dirty.ts"], {
        env: { ...process.env, NODE_ENV: "test" },
        timeout: 20_000,
      });
      expect(stdout).toMatch(/^recompute-dirty: replayed \d+ position\(s\)\s*$/m);

      const secrets = [process.env.TEST_DATABASE_URL, process.env.WALLET_ENC_KEY, process.env.WALLET_HMAC_KEY].filter(
        (value): value is string => Boolean(value),
      );
      for (const secret of secrets) {
        expect(stdout).not.toContain(secret);
        expect(stderr).not.toContain(secret);
      }
    },
    20_000,
  );
});

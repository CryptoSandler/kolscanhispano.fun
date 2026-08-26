/**
 * Exercises scripts/parse-pending.ts's `main()` in-process, the same way a
 * scheduled run or a `workflow_dispatch` invokes it -- against the real
 * `withLock` dedicated connection and the real shared pool -- without paying
 * a subprocess's tsx-transform-and-reconnect cost for every property under
 * test. (An early version of this file spawned `npx tsx` once per case --
 * sixteen subprocesses total across this file and recompute-dirty.test.ts --
 * which slowed the whole suite 4.7x and put enough concurrent connection
 * pressure on Neon to make an unrelated file's setup query fail outright.)
 * Exactly one test below still spawns the real binary, to prove the wiring
 * (the shebang-equivalent entry-point guard, the exit code, the printed
 * line) actually works end to end; every other property is reachable
 * in-process through the exported `main`.
 *
 * The parsing logic itself (parsePending) already has its own exhaustive
 * test suite in src/lib/parse-swap.test.ts; what this file covers is the CLI
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
import { buildSwapPayload } from "../src/lib/fixtures/swap";
import { inventAddress } from "../src/lib/ids";
import { withLock } from "../src/lib/lock";
import * as parseSwap from "../src/lib/parse-swap";
import { storeRawTx } from "../src/lib/raw-tx";
import { addWallet } from "../src/lib/wallets";
import { main } from "./parse-pending";

const run = promisify(execFile);

async function makeKol(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    "INSERT INTO kol (id, slug, display_name, x_handle, status) VALUES ($1,$2,$3,$4,'approved')",
    [id, id, id, id],
  );
  return id;
}

async function seedOnePendingRow(): Promise<{ kolId: string; walletId: string }> {
  const kolId = await makeKol();
  const wallet = inventAddress();
  const walletId = await addWallet(kolId, wallet);
  const mint = inventAddress();

  const payload = buildSwapPayload({
    wallet,
    mint,
    decimals: 6,
    nativeChangeLamports: -1_000_005_000,
    tokenChangeRaw: "2000000",
    feeLamports: 5_000,
    isFeePayer: true,
  });
  await storeRawTx({
    signature: payload.signature,
    blockTime: new Date(),
    slot: payload.slot,
    payload,
    source: "backfill",
  });

  return { kolId, walletId };
}

describe("scripts/parse-pending.ts: main()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price CASCADE");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("is idempotent: a second run finds nothing left to examine after the first", async () => {
    const { walletId } = await seedOnePendingRow();

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("parse-pending: examined 1 raw_tx row(s)");

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("parse-pending: examined 0 raw_tx row(s)");

    // The row itself proves the work actually happened once, not zero times.
    const [{ count }] = await query<{ count: string }>(
      "SELECT count(*) FROM trade WHERE wallet_id = $1",
      [walletId],
    );
    expect(count).toBe("1");
  });

  it("returns 0 and reports doing nothing when another run already holds the lock", async () => {
    let code: number | undefined;
    await withLock("parse-pending", async () => {
      code = await main();
    });

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("parse-pending: another run holds the lock; did nothing");
    // The two outcomes must never share wording: a "did nothing" run must
    // not also claim to have examined any rows.
    expect(logSpy.mock.calls.flat().join("\n")).not.toMatch(/examined \d+ raw_tx row/);
  });

  it("returns non-zero, distinguishably from the lock-busy case, when the work throws", async () => {
    const spy = vi.spyOn(parseSwap, "parsePending").mockRejectedValueOnce(new Error("simulated failure"));

    const code = await main();

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("parse-pending: failed -- simulated failure");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("did nothing");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("examined");
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
    const spy = vi.spyOn(parseSwap, "parsePending").mockRejectedValueOnce(new Error("simulated failure"));
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
describe("scripts/parse-pending.ts: end-to-end wiring", () => {
  it(
    "runs as a real subprocess and exits 0 with the expected line on stdout",
    async () => {
      const { stdout, stderr } = await run("npx", ["tsx", "scripts/parse-pending.ts"], {
        env: { ...process.env, NODE_ENV: "test" },
        timeout: 20_000,
      });
      expect(stdout).toMatch(/^parse-pending: examined \d+ raw_tx row\(s\)\s*$/m);

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

/**
 * Exercises scripts/requeue-no-rate.ts's `main()` in-process, the same way a
 * scheduled run or a `workflow_dispatch` invokes it -- against the real
 * `withLock` dedicated connection and the real shared pool -- without paying
 * a subprocess's tsx-transform-and-reconnect cost for every property under
 * test. (See scripts/parse-pending.test.ts's header for what that cost was
 * measured to be.) Exactly one case below still spawns the real binary, to
 * prove the wiring -- the entry-point guard, the exit code, the printed line
 * -- works end to end.
 *
 * The requeue itself is covered in src/lib/parse-swap.test.ts, including the
 * gate that is the whole point of it; what this file covers is the CLI
 * wrapper's own contract, the same four properties the other four cron
 * scripts are held to, plus the one knob this script adds:
 *
 * - It does the work and says how much of it there was, released against
 *   still-eligible.
 * - A second run while the first holds the lock returns cleanly (code 0)
 *   having done nothing, and its output says so in words a successful run
 *   never uses.
 * - A failure returns non-zero, distinguishably from the "did nothing" case.
 * - No secret is ever printed, on any path.
 * - REQUEUE_LIMIT bounds the release, and an unreadable one warns and falls
 *   back rather than stopping a cron that would otherwise work.
 *
 * **This file is the reason the script exists.** The step was briefly an
 * inline `npx tsx --eval` in the workflow, which nothing here could have
 * executed -- the composition would have been covered by a string match on
 * YAML and by nobody running it. Every case below is a case that shape could
 * not have had.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../src/lib/db";
import { buildObservedSwapPayload } from "../src/lib/fixtures/swap";
import { inventAddress } from "../src/lib/ids";
import { withLock } from "../src/lib/lock";
import * as parseSwap from "../src/lib/parse-swap";
import { storeRawTx } from "../src/lib/raw-tx";
import { addWallet } from "../src/lib/wallets";
import { main } from "./requeue-no-rate";

const run = promisify(execFile);

/** The block minute every seeded row sits in. */
const MINUTE = new Date("2026-08-25T12:00:00.000Z");

async function makeKol(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    "INSERT INTO kol (id, slug, display_name, x_handle, status) VALUES ($1,$2,$3,$4,'approved')",
    [id, id, id, id],
  );
  return id;
}

/**
 * Seeds `count` stablecoin-quoted swaps and runs the parse over them with no
 * rate for their minute, so each ends `unsupported_quote_no_rate` -- the real
 * refusal, produced by the real parser, not an `UPDATE` that fakes the
 * column. The rate then lands, which is the state the requeue is for.
 */
async function seedRefusedRows(count: number): Promise<void> {
  const kolId = await makeKol();
  const wallet = inventAddress();
  await addWallet(kolId, wallet);

  for (let i = 0; i < count; i++) {
    const payload = buildObservedSwapPayload({
      wallet,
      nativeChangeLamports: -5_000, // gas only; the quote side is the USDC leg
      feeLamports: 5_000,
      isFeePayer: true,
      timestamp: Math.floor(MINUTE.getTime() / 1000),
      slot: 1,
      legs: [
        { mint: inventAddress(), decimals: 6, rawTokenAmount: "2000000" },
        { mint: parseSwap.USDC_MINT, decimals: 6, rawTokenAmount: "-231710000" },
      ],
    });
    await storeRawTx({ signature: payload.signature, blockTime: MINUTE, slot: 1, payload, source: "webhook" });
  }

  await parseSwap.parsePending();
  const refused = await query<{ n: string }>(
    "SELECT count(*)::text AS n FROM raw_tx WHERE parse_error = 'unsupported_quote_no_rate'",
  );
  expect(refused[0].n).toBe(String(count)); // the fixture is only useful if the parse really declined

  await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '231.71')", [MINUTE]);
}

const pendingCount = async (): Promise<number> =>
  Number(
    (
      await query<{ n: string }>(
        "SELECT count(*)::text AS n FROM raw_tx WHERE parsed_at IS NULL AND parse_error IS NULL",
      )
    )[0].n,
  );

describe("scripts/requeue-no-rate.ts: main()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price CASCADE");
    delete process.env.REQUEUE_LIMIT;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.REQUEUE_LIMIT;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("releases the rows whose rate arrived, says how many, and leaves nothing for a second run", async () => {
    await seedRefusedRows(2);

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("requeue-no-rate: released 2 raw_tx row(s); 0 still eligible");
    // The property the whole step exists for: those rows are back in the
    // queue the parse reads, not merely mutated.
    expect(await pendingCount()).toBe(2);

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("requeue-no-rate: released 0 raw_tx row(s); 0 still eligible");
  });

  it("bounds the release with REQUEUE_LIMIT and reports what it left", async () => {
    await seedRefusedRows(3);
    process.env.REQUEUE_LIMIT = "1";

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("requeue-no-rate: released 1 raw_tx row(s); 2 still eligible");
    expect(await pendingCount()).toBe(1);
  });

  it("stops dead at REQUEUE_LIMIT=0 without claiming there was nothing to do", async () => {
    await seedRefusedRows(2);
    process.env.REQUEUE_LIMIT = "0";

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("requeue-no-rate: released 0 raw_tx row(s); 2 still eligible");
    expect(await pendingCount()).toBe(0);
  });

  it("warns and uses the default when REQUEUE_LIMIT is unreadable, instead of failing the run", async () => {
    await seedRefusedRows(2);
    process.env.REQUEUE_LIMIT = "half of them";

    await expect(main()).resolves.toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "requeue-no-rate: REQUEUE_LIMIT is not a non-negative integer; using the default",
    );
    expect(logSpy).toHaveBeenCalledWith("requeue-no-rate: released 2 raw_tx row(s); 0 still eligible");
    // Never echoed, per this repo's habit with env vars.
    expect(warnSpy.mock.calls.flat().join("\n")).not.toContain("half of them");
  });

  it("returns 0 and reports doing nothing when another run already holds the lock", async () => {
    await seedRefusedRows(1);

    let code: number | undefined;
    await withLock("requeue-no-rate", async () => {
      code = await main();
    });

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("requeue-no-rate: another run holds the lock; did nothing");
    // The two outcomes must never share wording: a "did nothing" run must not
    // also claim to have released anything.
    expect(logSpy.mock.calls.flat().join("\n")).not.toMatch(/released \d+ raw_tx row/);
    // And it must really have done nothing.
    expect(await pendingCount()).toBe(0);
  });

  it("does not take the parse's lock, so a running parse cannot skip it", async () => {
    // Its own name, deliberately. Sharing `parse-pending`'s lock would make a
    // parse that is still going able to skip the requeue in front of the next
    // one, for two jobs that do not contend at all.
    await seedRefusedRows(1);

    let code: number | undefined;
    await withLock("parse-pending", async () => {
      code = await main();
    });

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("requeue-no-rate: released 1 raw_tx row(s); 0 still eligible");
  });

  it("returns non-zero, distinguishably from the lock-busy case, when the work throws", async () => {
    const spy = vi
      .spyOn(parseSwap, "requeueNoRate")
      .mockRejectedValueOnce(new Error("simulated failure"));

    const code = await main();

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("requeue-no-rate: failed -- simulated failure");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("did nothing");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("released");
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
    const spy = vi
      .spyOn(parseSwap, "requeueNoRate")
      .mockRejectedValueOnce(new Error("simulated failure"));
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
// being exercised as an imported module. This is the case the inline-eval
// version of this step could not have had at all.
describe("scripts/requeue-no-rate.ts: end-to-end wiring", () => {
  it(
    "runs as a real subprocess and exits 0 with the expected line on stdout",
    async () => {
      const { stdout, stderr } = await run("npx", ["tsx", "scripts/requeue-no-rate.ts"], {
        env: { ...process.env, NODE_ENV: "test" },
        timeout: 20_000,
      });
      expect(stdout).toMatch(/^requeue-no-rate: released \d+ raw_tx row\(s\); \d+ still eligible\s*$/m);

      const secrets = [
        process.env.TEST_DATABASE_URL,
        process.env.WALLET_ENC_KEY,
        process.env.WALLET_HMAC_KEY,
      ].filter((value): value is string => Boolean(value));
      for (const secret of secrets) {
        expect(stdout).not.toContain(secret);
        expect(stderr).not.toContain(secret);
      }
    },
    20_000,
  );
});

/**
 * Exercises scripts/prune-rate-limit.ts's `main()` in-process, the same way a
 * scheduled run or a `workflow_dispatch` invokes it -- against the real
 * `withLock` dedicated connection and the real shared pool -- without paying
 * a subprocess's tsx-transform-and-reconnect cost for every property under
 * test. (See scripts/recompute-dirty.test.ts's header for what that cost was
 * measured to be.) Exactly one case below still spawns the real binary, to
 * prove the wiring -- the entry-point guard, the exit code, the printed line
 * -- works end to end.
 *
 * The deletion itself is covered in src/lib/rate-limit.test.ts; what this
 * file covers is the CLI wrapper's own contract, the same four properties
 * the other two cron scripts are held to:
 *
 * - It does the work and says how much of it there was.
 * - A second run while the first holds the lock returns cleanly (code 0)
 *   having done nothing, and its output says so in words a successful run
 *   never uses.
 * - A failure returns non-zero, distinguishably from the "did nothing" case.
 * - No secret is ever printed, on any path.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../src/lib/db";
import { withLock } from "../src/lib/lock";
import * as rateLimit from "../src/lib/rate-limit";
import { main } from "./prune-rate-limit";

const run = promisify(execFile);

/** A window old enough that the default seven-day retention has passed it. */
async function seedExpiredWindow(bucket: string): Promise<void> {
  await query(
    `INSERT INTO rate_limit (ip_hash, bucket, window_start, hits)
     VALUES ($1, $2, now() - interval '30 days', 1)`,
    [rateLimit.ipHash("203.0.113.7"), bucket],
  );
}

describe("scripts/prune-rate-limit.ts: main()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await query("TRUNCATE rate_limit");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("deletes the expired windows, says how many, and leaves nothing for a second run", async () => {
    await seedExpiredWindow("stale");
    await rateLimit.hitLimit("203.0.113.7", "current", 5, 60);

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("prune-rate-limit: deleted 1 rate_limit row(s)");

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("prune-rate-limit: deleted 0 rate_limit row(s)");

    // The window this run is itself inside must survive: pruning is about
    // old rows, and deleting a live window would reset a blocked caller.
    const rows = await query<{ bucket: string }>("SELECT bucket FROM rate_limit");
    expect(rows.map((row) => row.bucket)).toEqual(["current"]);
  });

  it("returns 0 and reports doing nothing when another run already holds the lock", async () => {
    await seedExpiredWindow("stale");

    let code: number | undefined;
    await withLock("prune-rate-limit", async () => {
      code = await main();
    });

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("prune-rate-limit: another run holds the lock; did nothing");
    // The two outcomes must never share wording: a "did nothing" run must not
    // also claim to have deleted anything.
    expect(logSpy.mock.calls.flat().join("\n")).not.toMatch(/deleted \d+ rate_limit row/);
    // And it must really have done nothing.
    expect(await query("SELECT 1 FROM rate_limit")).toHaveLength(1);
  });

  it("returns non-zero, distinguishably from the lock-busy case, when the work throws", async () => {
    const spy = vi
      .spyOn(rateLimit, "pruneRateLimit")
      .mockRejectedValueOnce(new Error("simulated failure"));

    const code = await main();

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("prune-rate-limit: failed -- simulated failure");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("did nothing");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("deleted");
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
      .spyOn(rateLimit, "pruneRateLimit")
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
// being exercised as an imported module.
describe("scripts/prune-rate-limit.ts: end-to-end wiring", () => {
  it(
    "runs as a real subprocess and exits 0 with the expected line on stdout",
    async () => {
      const { stdout, stderr } = await run("npx", ["tsx", "scripts/prune-rate-limit.ts"], {
        env: { ...process.env, NODE_ENV: "test" },
        timeout: 20_000,
      });
      expect(stdout).toMatch(/^prune-rate-limit: deleted \d+ rate_limit row\(s\)\s*$/m);

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

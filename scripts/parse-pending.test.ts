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
 * wrapper's own contract: the properties Task 2 states, plus the two the
 * drain of 2026-08-31 added.
 *
 * - Running the script twice in a row is idempotent.
 * - A second run while the first holds the lock returns cleanly (code 0)
 *   having done nothing, and its output says so in words a successful run
 *   never uses -- "did nothing" and "ran the work" must never look alike.
 * - A failure returns non-zero, distinguishably from the "did nothing" case.
 * - No secret is ever printed, on any path.
 * - The run is a *loop of small locked batches*: the lock is taken and
 *   released once per batch and is demonstrably free in between, which is
 *   the whole fix -- a single lock held across a long run has its dedicated
 *   connection dropped by Neon's idle timeout and kills itself.
 * - A batch that fails does not lose the batches that succeeded.
 * - The queue guard fires on *growth* and only on growth. Both halves are
 *   tested, and the negative half asserts the guard actually ran and saw the
 *   shrink -- not merely that no error appeared, which a guard deleted
 *   outright would also satisfy.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../src/lib/db";
import { buildSwapPayload } from "../src/lib/fixtures/swap";
import { inventAddress } from "../src/lib/ids";
import * as lock from "../src/lib/lock";
import { withLock } from "../src/lib/lock";
import * as parseSwap from "../src/lib/parse-swap";
import { storeRawTx } from "../src/lib/raw-tx";
import { addWallet } from "../src/lib/wallets";
import { main } from "./parse-pending";

const run = promisify(execFile);

/** Must match `QUEUE_DEPTH_KEY` in the script under test. */
const QUEUE_DEPTH_KEY = "parse_pending_queue_depth";

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

/** `count` independent pending rows, each on its own KOL and wallet. */
async function seedPendingRows(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await seedOnePendingRow();
}

/**
 * Writes the `setting` row a *previous* run would have left, so the guard has
 * something to compare against. Written through SQL rather than by invoking
 * `main()` twice: a previous depth that the test chooses is what makes
 * "shrank" and "grew" both reachable, and a run drained by `main()` can only
 * ever produce the one it happens to produce.
 */
async function recordPreviousDepth(pending: unknown, minutesAgo = 10): Promise<void> {
  await query(
    `INSERT INTO setting (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      QUEUE_DEPTH_KEY,
      JSON.stringify({ pending, at: new Date(Date.now() - minutesAgo * 60_000).toISOString() }),
    ],
  );
}

async function storedDepth(): Promise<{ pending: unknown; at: unknown } | undefined> {
  const rows = await query<{ value: { pending: unknown; at: unknown } }>(
    "SELECT value FROM setting WHERE key = $1",
    [QUEUE_DEPTH_KEY],
  );
  return rows[0]?.value;
}

async function pendingCount(): Promise<number> {
  const [row] = await query<{ pending: string }>(
    "SELECT count(*)::text AS pending FROM raw_tx WHERE parsed_at IS NULL AND parse_error IS NULL",
  );
  return Number(row.pending);
}

describe("scripts/parse-pending.ts: main()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  /** Everything the run printed, on either stream, as one string. */
  const output = () => [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join("\n");

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price CASCADE");
    // TRUNCATE does not reach `setting`, and the queue guard's whole input is
    // what it finds there: a row left by an earlier case would decide the
    // next case's exit code.
    await query("DELETE FROM setting WHERE key = $1", [QUEUE_DEPTH_KEY]);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("is idempotent: a second run finds nothing left to examine after the first", async () => {
    const { walletId } = await seedOnePendingRow();

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("parse-pending: batch 1 examined 1 raw_tx row(s)");
    // Two batches, not one: the first came back full-enough to be worth
    // asking again, and the second is the empty one that ends the loop.
    expect(logSpy).toHaveBeenCalledWith("parse-pending: examined 1 raw_tx row(s) across 2 batch(es)");

    await expect(main()).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith("parse-pending: examined 0 raw_tx row(s) across 1 batch(es)");

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
    expect(output()).not.toMatch(/examined \d+ raw_tx row/);
    // Nor may it record a queue depth: the run that holds the lock is the one
    // making progress, and it runs the guard itself.
    expect(await storedDepth()).toBeUndefined();
  });

  it("returns non-zero, distinguishably from the lock-busy case, when the work throws", async () => {
    const spy = vi.spyOn(parseSwap, "parsePending").mockRejectedValueOnce(new Error("simulated failure"));

    const code = await main();

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("parse-pending: failed -- simulated failure");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("did nothing");
    // No batch completed, so there is no count to report -- "examined 0" beside
    // a failure would read as a claim about the queue that this run cannot make.
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

    for (const secret of secrets) {
      expect(output()).not.toContain(secret);
    }
  });
});

/**
 * The fix itself. A single `withLock` around the whole run holds its
 * *dedicated* client idle for the run's duration, and Neon drops an idle
 * connection at around five minutes -- so a long run killed its own lock
 * ("Client has encountered a connection error and is not queryable", twice
 * against production on 2026-08-31, at 189 and 191 rows). What replaces it is
 * a loop of small batches, each with its own acquisition.
 *
 * A test that only counted batch log lines would pass just as happily if the
 * lock were still held across all of them, so the property asserted here is
 * the one that matters: **between batches the lock is free**, proved by a
 * competing acquisition succeeding.
 */
describe("scripts/parse-pending.ts: one lock acquisition per batch", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price CASCADE");
    await query("DELETE FROM setting WHERE key = $1", [QUEUE_DEPTH_KEY]);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("releases the lock between batches, and takes it again for the next one", async () => {
    await seedPendingRows(3);
    vi.stubEnv("PARSE_BATCH_SIZE", "1");

    // Captured before the spy replaces the binding, so the spy can call
    // through to the genuine implementation rather than simulate it.
    const realWithLock = lock.withLock;
    const freeBeforeEachBatch: boolean[] = [];

    const spy = vi.spyOn(lock, "withLock").mockImplementation(async (name, fn) => {
      // A second, independent acquisition of the *same* key. It can only
      // succeed if the previous batch's lock was released -- which is exactly
      // what a single run-long `withLock` would not have done.
      const competing = await realWithLock("parse-pending", async () => "free");
      freeBeforeEachBatch.push(competing === "free");
      return realWithLock(name, fn);
    });

    const code = await main();
    spy.mockRestore();

    expect(code).toBe(0);
    // Three rows at one per batch, then a fourth batch that finds none left
    // and ends the loop.
    expect(freeBeforeEachBatch).toEqual([true, true, true, true]);
    expect(logSpy).toHaveBeenCalledWith("parse-pending: batch 1 examined 1 raw_tx row(s)");
    expect(logSpy).toHaveBeenCalledWith("parse-pending: batch 3 examined 1 raw_tx row(s)");
    expect(logSpy).toHaveBeenCalledWith("parse-pending: examined 3 raw_tx row(s) across 4 batch(es)");
  });

  it("asks parsePending for the configured batch size, not for its own default", async () => {
    await seedPendingRows(2);
    vi.stubEnv("PARSE_BATCH_SIZE", "1");
    const spy = vi.spyOn(parseSwap, "parsePending");

    await expect(main()).resolves.toBe(0);

    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const call of spy.mock.calls) expect(call[0]).toBe(1);
  });

  it("stops at the batch count when one is set, leaving the rest of the queue pending", async () => {
    await seedPendingRows(3);
    vi.stubEnv("PARSE_BATCH_SIZE", "1");
    vi.stubEnv("PARSE_MAX_BATCHES", "1");

    await expect(main()).resolves.toBe(0);

    expect(logSpy).toHaveBeenCalledWith("parse-pending: examined 1 raw_tx row(s) across 1 batch(es)");
    // The bound is real work skipped, not just a log line: two rows are still
    // there for the next run.
    expect(await pendingCount()).toBe(2);
  });

  it("stops at the wall-clock budget without taking the lock at all when it is already spent", async () => {
    await seedPendingRows(2);
    vi.stubEnv("PARSE_BUDGET_MS", "0");
    const parseSpy = vi.spyOn(parseSwap, "parsePending");

    await expect(main()).resolves.toBe(0);

    expect(parseSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("parse-pending: examined 0 raw_tx row(s) across 0 batch(es)");
    expect(await pendingCount()).toBe(2);
  });

  it("falls back to the default, with a warning, when a knob is not a non-negative integer", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedPendingRows(1);
    vi.stubEnv("PARSE_BATCH_SIZE", "-3");
    const parseSpy = vi.spyOn(parseSwap, "parsePending");

    await expect(main()).resolves.toBe(0);

    expect(warnSpy).toHaveBeenCalledWith(
      "parse-pending: PARSE_BATCH_SIZE is not a non-negative integer; using the default",
    );
    expect(parseSpy.mock.calls[0][0]).toBe(25);
    // The unreadable value is never echoed, warning included.
    expect([...warnSpy.mock.calls].flat().join("\n")).not.toContain("-3");
    warnSpy.mockRestore();
  });

  it("keeps the batches that succeeded when a later batch fails, and still exits non-zero", async () => {
    await seedPendingRows(3);
    vi.stubEnv("PARSE_BATCH_SIZE", "1");

    const realParsePending = parseSwap.parsePending;
    let calls = 0;
    const spy = vi.spyOn(parseSwap, "parsePending").mockImplementation(async (limit) => {
      calls += 1;
      if (calls === 3) throw new Error("simulated failure");
      return realParsePending(limit);
    });

    const code = await main();
    spy.mockRestore();

    expect(code).toBe(1);
    // Both halves: what was done is reported, and why it stopped is reported.
    expect(logSpy).toHaveBeenCalledWith("parse-pending: examined 2 raw_tx row(s) across 2 batch(es)");
    expect(errorSpy).toHaveBeenCalledWith("parse-pending: failed -- simulated failure");
    // And the work itself survived the failure -- the two batches that
    // committed are still committed.
    const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM trade");
    expect(count).toBe("2");
    expect(await pendingCount()).toBe(1);
  });
});

/**
 * The queue guard: nothing in this repository alerted on queue depth before
 * it, so a backlog that grew for a week grew silently. The red workflow is
 * the alert.
 *
 * **Growth is the signal, not depth**, and the negative case is the half that
 * rots. A guard that was deleted, skipped, or short-circuited would pass a
 * test that only asked "no ::error:: and exit 0", so every negative case here
 * also asserts the guard *ran*: it names the previous depth it compared
 * against, and it leaves the new one recorded for the run behind it.
 */
describe("scripts/parse-pending.ts: the queue watches itself", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const output = () => [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join("\n");

  beforeEach(async () => {
    await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price CASCADE");
    await query("DELETE FROM setting WHERE key = $1", [QUEUE_DEPTH_KEY]);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("exits 0 and emits no ::error:: when pending shrank -- and says what it compared against", async () => {
    await recordPreviousDepth(500, 10);
    await seedPendingRows(1);

    const code = await main();

    expect(code).toBe(0);
    expect(output()).not.toContain("::error::");
    // The assertion that keeps this case honest. Without it, deleting the
    // guard entirely would still leave a green test.
    expect(output()).toContain("parse-pending: queue depth 0, was 500 10 min ago; not growing");
    // And the guard left a fresh baseline for the next run: the previous
    // value must not survive its own comparison.
    expect(await storedDepth()).toMatchObject({ pending: 0 });
  });

  it("exits 0 and emits no ::error:: when pending is unchanged", async () => {
    // Equal is not growth. The boundary is worth pinning explicitly: a `<`
    // written where `<=` belongs turns every idle cycle of a drained queue
    // into a red workflow.
    await recordPreviousDepth(2, 10);
    await seedPendingRows(2);
    vi.stubEnv("PARSE_BUDGET_MS", "0"); // parse nothing, so the depth is exactly what was seeded

    const code = await main();

    expect(code).toBe(0);
    expect(output()).not.toContain("::error::");
    expect(output()).toContain("parse-pending: queue depth 2, was 2 10 min ago; not growing");
  });

  it("exits non-zero with an ::error:: naming what grew, by how much, and over what interval", async () => {
    await recordPreviousDepth(2, 45);
    await seedPendingRows(5);
    vi.stubEnv("PARSE_BUDGET_MS", "0"); // the queue is 5 against a previous 2

    const code = await main();

    expect(code).toBe(1);
    expect(output()).toContain(
      "::error::parse-pending: the pending queue grew by 3 row(s), from 2 to 5, over the last 45 min. " +
        "Ingestion is outpacing the parse.",
    );
    // The annotation has to reach stdout: the Actions runner parses workflow
    // commands out of a step's standard output.
    expect(logSpy.mock.calls.flat().join("\n")).toContain("::error::");
    expect(await storedDepth()).toMatchObject({ pending: 5 });
  });

  it("does not fail a first-ever run, which has no previous depth to compare against", async () => {
    await seedPendingRows(3);
    vi.stubEnv("PARSE_BUDGET_MS", "0");
    expect(await storedDepth()).toBeUndefined();

    const code = await main();

    expect(code).toBe(0);
    expect(output()).not.toContain("::error::");
    expect(output()).toContain(
      "parse-pending: queue depth 3; no previous depth to compare against, recorded this one",
    );
    expect(await storedDepth()).toMatchObject({ pending: 3 });
  });

  it("treats an unreadable stored depth as no previous depth, rather than comparing against a NaN", async () => {
    // A hand-edited or half-written row must not silently disable the guard
    // forever: a `NaN` comparison is false in both directions, so the guard
    // would still be there and would never fire again.
    await recordPreviousDepth("many", 10);
    await seedPendingRows(4);
    vi.stubEnv("PARSE_BUDGET_MS", "0");

    const code = await main();

    expect(code).toBe(0);
    expect(output()).not.toContain("::error::");
    expect(output()).toContain(
      "parse-pending: queue depth 4; no previous depth to compare against, recorded this one",
    );
    // And it is repaired, so the run behind this one has a usable baseline.
    expect(await storedDepth()).toMatchObject({ pending: 4 });
  });

  it("records a depth the next run can compare against, taken after the batches ran", async () => {
    // End to end through two real runs, with no hand-written `setting` row:
    // the first drains and records, the second reads what the first wrote.
    await seedPendingRows(2);

    await expect(main()).resolves.toBe(0);
    expect(await storedDepth()).toMatchObject({ pending: 0 });

    await seedPendingRows(1);
    vi.stubEnv("PARSE_BUDGET_MS", "0"); // leave it pending, so the second run sees growth

    await expect(main()).resolves.toBe(1);
    expect(output()).toContain("the pending queue grew by 1 row(s), from 0 to 1");
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
      // Cleared first so the subprocess takes the first-ever-run path: the
      // exit code under test here is the wiring's, and it must not depend on
      // whatever depth an earlier case in this file happened to leave behind.
      await query("DELETE FROM setting WHERE key = $1", [QUEUE_DEPTH_KEY]);

      const { stdout, stderr } = await run("npx", ["tsx", "scripts/parse-pending.ts"], {
        env: { ...process.env, NODE_ENV: "test" },
        timeout: 20_000,
      });
      expect(stdout).toMatch(/^parse-pending: examined \d+ raw_tx row\(s\) across \d+ batch\(es\)\s*$/m);
      expect(stdout).not.toContain("::error::");

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

/**
 * The properties Task 3's wiring step states, each written so it fails for
 * the reason it names.
 *
 * The first one is the whole point of this file's existence. `tokenMetadata`
 * (src/lib/prices.ts) was built, tested and correct, and **nothing called
 * it** — so in the running system the `token` table had no writer outside a
 * dev seeding script, and every feed row shipped with a NULL symbol while a
 * green suite proved the metadata layer worked. That is a composition
 * defect, invisible to any test that calls the unit directly, so the test
 * below deliberately starts from a `trade` row and asserts on `token`,
 * crossing exactly the boundary that was empty.
 *
 * `fetch` is injected in every case: the harness's network guard throws on a
 * real call (see src/lib/network-guard.ts), and a run that reached
 * DexScreener from a test would also be spending a third party's quota — and
 * with Helius, 10 DAS credits per mint — on every `vitest run`. No test in
 * this file may reach either host.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aadFor, blindIndex, encrypt } from "../src/lib/crypto";
import { query } from "../src/lib/db";
import { buildDexPair, buildDexResponse, buildHeliusAssetResponse } from "../src/lib/fixtures/dexscreener";
import { inventAddress, inventSignature } from "../src/lib/ids";
import { withLock } from "../src/lib/lock";
import * as prices from "../src/lib/prices";
import { addWallet } from "../src/lib/wallets";
import { main, refreshTokenMetadata } from "./refresh-token-metadata";

const run = promisify(execFile);

async function makeKol(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    "INSERT INTO kol (id, slug, display_name, x_handle, status) VALUES ($1,$2,$3,$4,'approved')",
    [id, id, id, id],
  );
  return id;
}

/**
 * Inserts one trade directly. Going through `parsePending` here would test
 * the parser instead of the wiring, and this file's subject is only ever
 * "a mint appears in `trade`" — nothing about how it got there.
 */
async function insertTradeFor(mint: string, blockTime = new Date("2026-08-01T12:00:00.000Z")): Promise<void> {
  const kolId = await makeKol();
  const walletId = await addWallet(kolId, inventAddress());
  const id = crypto.randomUUID();
  const signature = inventSignature();
  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                        mint, side, token_amount, sol_amount, fee_sol, block_time)
     VALUES ($1,$2,$3,0,$4,$5,$6,'buy','2','1','0',$7)`,
    [id, blindIndex(signature, "signature"), encrypt(signature, aadFor("trade", "signature", id)), kolId, walletId, mint, blockTime],
  );
}

/** A token row in the state a previous run left it: examined, still no symbol. */
async function insertSymbollessToken(mint: string, updatedAt: string): Promise<void> {
  await query(
    `INSERT INTO token (mint, symbol, price_state, updated_at) VALUES ($1, NULL, 'unpriced', now() - $2::interval)`,
    [mint, updatedAt],
  );
}

async function tokenRow(mint: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await query<Record<string, unknown>>("SELECT * FROM token WHERE mint = $1", [mint]);
  return row;
}

/**
 * A `fetch` that answers a DexScreener `/tokens/{mints}` call with a pair for
 * each requested mint it "knows" and nothing for the rest — so a test can
 * make the difference between "DexScreener has no pair for this" and "the
 * request failed" without either one being a real request.
 */
function dexFetchKnowing(known: string[], symbol = "SYM"): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const requested = (url.split("/").pop() ?? "").split(",");
    const pairs = requested
      .filter((mint) => known.includes(mint))
      .map((mint) => buildDexPair({ mint, symbol, priceUsd: "1.0", liquidityUsd: 10_000 }));
    return new Response(JSON.stringify(buildDexResponse(pairs)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fn, calls };
}

/** A `fetch` whose every call fails, standing in for a DexScreener outage. */
const offlineFetch = (async () => {
  throw new TypeError("network down");
}) as typeof fetch;

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet, raw_tx, trade, position, sol_price, token CASCADE");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("refreshTokenMetadata", () => {
  it("populates a token row, with a symbol, for a mint that appears in trade", async () => {
    // The composition property. Before this script existed the assertion
    // below failed with `row` undefined: `tokenMetadata` had no caller, so a
    // mint could sit in `trade` forever and never acquire a `token` row.
    vi.stubEnv("HELIUS_API_KEY", "");
    const mint = inventAddress();
    await insertTradeFor(mint);

    const { fn } = dexFetchKnowing([mint], "FOO");
    const result = await refreshTokenMetadata({ fetchImpl: fn });

    expect(await tokenRow(mint)).toMatchObject({ mint, symbol: "FOO" });
    expect(result).toMatchObject({ selected: 1, written: 1, remaining: 0 });
  });

  it("leaves a mint that already has a symbol alone, and never asks about it", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    const known = inventAddress();
    await insertTradeFor(known);
    await query(`INSERT INTO token (mint, symbol, price_state) VALUES ($1, 'OLD', 'priced')`, [known]);

    const { fn, calls } = dexFetchKnowing([known], "NEW");
    const result = await refreshTokenMetadata({ fetchImpl: fn });

    // Not a price refresher: a row that already carries a symbol is not this
    // script's problem, and re-asking would spend a request to learn nothing.
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ selected: 0, written: 0, remaining: 0 });
    expect((await tokenRow(known))?.symbol).toBe("OLD");
  });

  it("respects the bound and reports how many still lack a symbol", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    const mints = [inventAddress(), inventAddress(), inventAddress()];
    for (const mint of mints) await insertTradeFor(mint);

    const { fn } = dexFetchKnowing(mints, "FOO");
    const result = await refreshTokenMetadata({ fetchImpl: fn, limit: 1 });

    expect(result).toMatchObject({ selected: 1, written: 1, remaining: 2 });
    const [{ count }] = await query<{ count: string }>("SELECT count(*)::text AS count FROM token");
    expect(count).toBe("1");
  });

  it("takes the never-examined mints first, so a repeatedly-unresolvable one cannot starve them", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    const fresh = inventAddress();
    const triedLongAgo = inventAddress();
    const triedRecently = inventAddress();
    for (const mint of [fresh, triedLongAgo, triedRecently]) await insertTradeFor(mint);
    await insertSymbollessToken(triedLongAgo, "40 days");
    await insertSymbollessToken(triedRecently, "30 days");

    const { fn, calls } = dexFetchKnowing([fresh, triedLongAgo, triedRecently], "FOO");
    await refreshTokenMetadata({ fetchImpl: fn, limit: 2 });

    // A mint with no row at all sorts ahead of every examined one
    // (`updated_at ASC NULLS FIRST`), and among the examined the stalest
    // goes first. `triedRecently` is the one left out.
    const asked = calls[0].split("/").pop() ?? "";
    expect(asked.split(",").sort()).toEqual([fresh, triedLongAgo].sort());
    expect((await tokenRow(triedRecently))?.symbol).toBeNull();
  });

  it("does not re-ask about a symbol-less mint until the retry interval has passed", async () => {
    // Without this, a mint neither source knows is re-queried on every
    // 5-minute cycle for ever -- 288 DexScreener slots and, once a key is
    // configured, 2,880 Helius DAS credits a day, for an answer that has
    // already come back empty. See the script's header.
    vi.stubEnv("HELIUS_API_KEY", "");
    const mint = inventAddress();
    await insertTradeFor(mint);
    await insertSymbollessToken(mint, "1 hour");

    const { fn, calls } = dexFetchKnowing([mint], "FOO");
    const cooled = await refreshTokenMetadata({ fetchImpl: fn });
    expect(cooled.selected).toBe(0);
    expect(calls).toHaveLength(0);
    // Still counted as outstanding, though: the cooldown governs when it is
    // retried, never whether it is still missing.
    expect(cooled.remaining).toBe(1);

    const past = await refreshTokenMetadata({ fetchImpl: fn, retryAfter: "0 seconds" });
    expect(past.selected).toBe(1);
    expect((await tokenRow(mint))?.symbol).toBe("FOO");
  });

  it("reaches the Helius DAS fallback for a mint DexScreener does not know, through the injected fetch", async () => {
    // Proves the wiring hands `fetchImpl` all the way down: the second call
    // this fetch sees is the DAS request `tokenMetadata` makes, and it is
    // answered from a fixture. Nothing here touches the network.
    vi.stubEnv("HELIUS_API_KEY", "test-key");
    const mint = inventAddress();
    await insertTradeFor(mint);

    const calls: string[] = [];
    const fn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(new URL(url).host);
      const body = url.includes("dexscreener")
        ? buildDexResponse([])
        : buildHeliusAssetResponse({ symbol: "DAS", name: "From DAS", decimals: 6 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await refreshTokenMetadata({ fetchImpl: fn });

    expect(calls).toEqual(["api.dexscreener.com", "mainnet.helius-rpc.com"]);
    expect(await tokenRow(mint)).toMatchObject({ symbol: "DAS", decimals: 6, price_state: "unpriced" });
  });

  it("warns and carries on with no HELIUS_API_KEY, never attempting a DAS request", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mint = inventAddress();
    await insertTradeFor(mint);

    const { fn, calls } = dexFetchKnowing([], "FOO"); // DexScreener knows nothing about it

    const result = await refreshTokenMetadata({ fetchImpl: fn });

    expect(calls).toHaveLength(1); // DexScreener only; no DAS request was attempted
    expect(warnSpy.mock.calls.flat().join("\n")).toContain("HELIUS_API_KEY");
    // Degraded, not failed: the row is written, honestly, with no symbol.
    expect(result).toMatchObject({ selected: 1, written: 1 });
    expect(await tokenRow(mint)).toMatchObject({ symbol: null, price_state: "unpriced" });
  });

  it("leaves a cached row untouched when the DexScreener call fails, and still counts it outstanding", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    const mint = inventAddress();
    await insertTradeFor(mint);

    const result = await refreshTokenMetadata({ fetchImpl: offlineFetch });

    // Selected but not written -- the two counts are separate for exactly
    // this case, and the mint stays eligible for the next run because
    // nothing moved its `updated_at`.
    expect(result).toMatchObject({ selected: 1, written: 0, remaining: 1 });
    expect(await tokenRow(mint)).toBeUndefined();
  });

  it("rejects a limit that is not a non-negative integer rather than silently running unbounded", async () => {
    await expect(refreshTokenMetadata({ fetchImpl: offlineFetch, limit: -1 })).rejects.toThrow(/limit/);
    await expect(refreshTokenMetadata({ fetchImpl: offlineFetch, limit: 1.5 })).rejects.toThrow(/limit/);
  });
});

describe("scripts/refresh-token-metadata.ts: main()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("reports the counts and exits 0", async () => {
    // No trade rows (the truncate above), so nothing is selected and the
    // unmocked `fetch` main() uses is never reached -- which is what keeps
    // this case off the network. See the file header.
    const code = await main();

    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "refresh-token-metadata: refreshed 0 of 0 selected mint(s); 0 still lack a symbol",
    );
  });

  it("takes the bound from TOKEN_METADATA_LIMIT when it is set", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    vi.stubEnv("TOKEN_METADATA_LIMIT", "0");
    for (const mint of [inventAddress(), inventAddress()]) await insertTradeFor(mint);

    // limit 0 is a real value, not a fallback to the default: it selects
    // nothing, so this run makes no request at all -- the kill switch that
    // stops the step without an edit or a deploy.
    const code = await main();

    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "refresh-token-metadata: refreshed 0 of 0 selected mint(s); 2 still lack a symbol",
    );
  });

  it("falls back to the default bound when TOKEN_METADATA_LIMIT is unreadable, saying so", async () => {
    vi.stubEnv("TOKEN_METADATA_LIMIT", "lots");

    const code = await main();

    expect(code).toBe(0);
    expect(warnSpy.mock.calls.flat().join("\n")).toContain("TOKEN_METADATA_LIMIT");
  });

  it("returns 0 and reports doing nothing when another run already holds the lock", async () => {
    let code: number | undefined;
    await withLock("refresh-token-metadata", async () => {
      code = await main();
    });

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("refresh-token-metadata: another run holds the lock; did nothing");
    // The two outcomes must never share wording.
    expect(logSpy.mock.calls.flat().join("\n")).not.toMatch(/refreshed \d+ of \d+/);
  });

  it("returns non-zero, distinguishably from the lock-busy case, when the work throws", async () => {
    const spy = vi.spyOn(prices, "tokenMetadata").mockRejectedValueOnce(new Error("simulated failure"));
    await insertTradeFor(inventAddress());

    const code = await main();

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("refresh-token-metadata: failed -- simulated failure");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("did nothing");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("refreshed");
    spy.mockRestore();
  });

  it("never logs a secret, on a normal run or a failing one", async () => {
    const secrets = [
      process.env.DATABASE_URL,
      process.env.TEST_DATABASE_URL,
      process.env.WALLET_ENC_KEY,
      process.env.WALLET_HMAC_KEY,
      process.env.HELIUS_API_KEY,
      process.env.HELIUS_WEBHOOK_SECRET,
    ].filter((value): value is string => Boolean(value));
    expect(secrets.length).toBeGreaterThan(0); // the check below is vacuous otherwise

    await main();
    const spy = vi.spyOn(prices, "tokenMetadata").mockRejectedValueOnce(new Error("simulated failure"));
    await insertTradeFor(inventAddress());
    await main();
    spy.mockRestore();

    const allOutput = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().join("\n");
    for (const secret of secrets) {
      expect(allOutput).not.toContain(secret);
    }
  });
});

// The one true end-to-end case: proves the file actually runs as a script
// (the entry-point guard fires, the process exits with the code `main()`
// returned, and the real line reaches real stdout) rather than only ever
// being exercised as an imported module.
//
// `TOKEN_METADATA_LIMIT=0` is what makes it safe: the subprocess gets the
// real `fetch`, not this worker's guarded one, so a run that selected any
// mint would make a real DexScreener request. Selecting nothing is the only
// honest way to spawn this binary from a test.
describe("scripts/refresh-token-metadata.ts: end-to-end wiring", () => {
  it(
    "runs as a real subprocess and exits 0 with the expected line on stdout",
    async () => {
      const { stdout, stderr } = await run("npx", ["tsx", "scripts/refresh-token-metadata.ts"], {
        env: { ...process.env, NODE_ENV: "test", TOKEN_METADATA_LIMIT: "0" },
        timeout: 20_000,
      });
      expect(stdout).toMatch(/^refresh-token-metadata: refreshed 0 of 0 selected mint\(s\); \d+ still lack a symbol\s*$/m);

      const secrets = [
        process.env.TEST_DATABASE_URL,
        process.env.WALLET_ENC_KEY,
        process.env.WALLET_HMAC_KEY,
        process.env.HELIUS_API_KEY,
      ].filter((value): value is string => Boolean(value));
      for (const secret of secrets) {
        expect(stdout).not.toContain(secret);
        expect(stderr).not.toContain(secret);
      }
    },
    20_000,
  );
});

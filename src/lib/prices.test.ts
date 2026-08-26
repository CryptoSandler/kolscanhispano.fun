import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "./db";
import { buildDexPair, buildDexResponse, buildHeliusAssetResponse } from "./fixtures/dexscreener";
import { inventAddress } from "./ids";
import { realFetch } from "./network-guard";
import { USDC_MINT, WSOL_MINT } from "./parse-swap";
import {
  DEXSCREENER_BATCH_LIMIT,
  deriveTokenUpdate,
  parseHeliusAsset,
  refreshSolPrice,
  solUsdAt,
  tokenMetadata,
  tryParsePair,
  type ParsedPair,
} from "./prices";

beforeEach(async () => {
  await query("TRUNCATE token, sol_price CASCADE");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A `fetch` replacement that returns one `Response` per call, in order. */
function fetchQueue(...responses: (Response | Error)[]): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const fn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function tokenRow(mint: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await query<Record<string, unknown>>("SELECT * FROM token WHERE mint = $1", [mint]);
  return row;
}

// ---------------------------------------------------------------------------
// tryParsePair — pure validation of one DexScreener pair object
// ---------------------------------------------------------------------------

describe("tryParsePair", () => {
  it("reads symbol, name, price and liquidity off a well-formed pair", () => {
    const mint = inventAddress();
    const raw = buildDexPair({ mint, symbol: "FOO", name: "Foo Token", priceUsd: "0.5", liquidityUsd: 5000 });
    const parsed = tryParsePair(raw);
    expect(parsed?.mint).toBe(mint);
    expect(parsed?.symbol).toBe("FOO");
    expect(parsed?.name).toBe("Foo Token");
    expect(parsed?.priceUsdRaw).toBe("0.5");
    expect(parsed?.liquidityUsdRaw).toBe(5000);
    expect(parsed?.tradedRecently).toBe(true);
  });

  it("rejects a non-solana chain", () => {
    const raw = buildDexPair({ mint: inventAddress(), chainId: "ethereum" });
    expect(tryParsePair(raw)).toBeNull();
  });

  it("rejects a pair with no usable priceUsd", () => {
    const raw = buildDexPair({ mint: inventAddress() });
    delete (raw as Record<string, unknown>).priceUsd;
    expect(tryParsePair(raw)).toBeNull();
  });

  it("rejects a pair with unreadable liquidity", () => {
    const raw = buildDexPair({ mint: inventAddress() });
    (raw as Record<string, unknown>).liquidity = { usd: "not-a-number" };
    expect(tryParsePair(raw)).toBeNull();
  });

  it("reports not traded recently when h24 txns are zero", () => {
    const raw = buildDexPair({ mint: inventAddress(), h24Txns: 0 });
    expect(tryParsePair(raw)?.tradedRecently).toBe(false);
  });

  it("does not crash on a garbage entry, and returns null", () => {
    expect(tryParsePair("not an object")).toBeNull();
    expect(tryParsePair(null)).toBeNull();
    expect(tryParsePair({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveTokenUpdate — the §4.6 state table
// ---------------------------------------------------------------------------

function pair(overrides: Partial<ParsedPair> = {}): ParsedPair {
  return {
    mint: inventAddress(),
    symbol: "FOO",
    name: "Foo",
    imageUrl: null,
    priceUsdRaw: "1.5",
    priceNativeRaw: "0.01",
    quoteAddress: WSOL_MINT,
    liquidityUsdRaw: 5000,
    pairUrl: "https://dexscreener.com/solana/x",
    tradedRecently: true,
    ...overrides,
  };
}

const FLOOR = 1000n * 10n ** 18n; // matches decimal.ts scaling of "1000"

describe("deriveTokenUpdate", () => {
  it("prices a liquid, recently traded pair", () => {
    const update = deriveTokenUpdate(pair(), FLOOR);
    expect(update.state).toBe("priced");
    expect(update.priceUsd).toBe("1.5");
    expect(update.priceSol).toBe("0.01");
  });

  it("marks a liquid pair stale when it has not traded in 24h — but keeps the price", () => {
    const update = deriveTokenUpdate(pair({ tradedRecently: false }), FLOOR);
    expect(update.state).toBe("stale");
    expect(update.priceUsd).toBe("1.5");
  });

  it("marks a pair below the liquidity floor unpriced, with no price, even if actively traded", () => {
    const update = deriveTokenUpdate(pair({ liquidityUsdRaw: 999, tradedRecently: true }), FLOOR);
    expect(update.state).toBe("unpriced");
    expect(update.priceUsd).toBeNull();
    expect(update.priceSol).toBeNull();
  });

  it("never writes price_sol when the pair is not quoted in SOL/WSOL", () => {
    const update = deriveTokenUpdate(pair({ quoteAddress: USDC_MINT }), FLOOR);
    expect(update.state).toBe("priced");
    expect(update.priceUsd).toBe("1.5");
    expect(update.priceSol).toBeNull();
  });

  it("downgrades to unpriced if priceUsd cannot be parsed as a decimal, despite good liquidity and recency", () => {
    const update = deriveTokenUpdate(pair({ priceUsdRaw: "not-a-number" }), FLOOR);
    expect(update.state).toBe("unpriced");
    expect(update.priceUsd).toBeNull();
  });

  it("keeps the symbol and name even when unpriced", () => {
    const update = deriveTokenUpdate(pair({ liquidityUsdRaw: 1 }), FLOOR);
    expect(update.symbol).toBe("FOO");
    expect(update.name).toBe("Foo");
  });
});

// ---------------------------------------------------------------------------
// parseHeliusAsset — the DAS fallback's pure parser
// ---------------------------------------------------------------------------

describe("parseHeliusAsset", () => {
  it("extracts symbol, name, decimals and image", () => {
    const body = buildHeliusAssetResponse({ symbol: "BAR", name: "Bar Token", decimals: 6, imageUrl: "https://x.test/i.png" });
    const parsed = parseHeliusAsset(body);
    expect(parsed).toEqual({ symbol: "BAR", name: "Bar Token", decimals: 6, imageUrl: "https://x.test/i.png" });
  });

  it("never returns a price, even when the response carries price_info", () => {
    const withPrice = buildHeliusAssetResponse({
      symbol: "BAR",
      priceInfo: { pricePerToken: 123.45, currency: "USDC" },
    });
    const withoutPrice = buildHeliusAssetResponse({ symbol: "BAR" });
    const parsedWithPrice = parseHeliusAsset(withPrice);
    const parsedWithoutPrice = parseHeliusAsset(withoutPrice);
    // The two fixtures differ only in the presence of price_info; the parsed
    // result must be identical, proving the field was never read at all —
    // not merely that this type has nowhere to put it.
    expect(parsedWithPrice).toEqual(parsedWithoutPrice);
    expect(parsedWithPrice).not.toHaveProperty("price");
    expect(parsedWithPrice).not.toHaveProperty("priceUsd");
  });

  it("returns null when nothing is readable", () => {
    expect(parseHeliusAsset({})).toBeNull();
    expect(parseHeliusAsset(null)).toBeNull();
    expect(parseHeliusAsset({ result: {} })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tokenMetadata — DB-writing behaviour
// ---------------------------------------------------------------------------

describe("tokenMetadata", () => {
  it("gives a mint with a pair a symbol and a price", async () => {
    const mint = inventAddress();
    const { fn } = fetchQueue(jsonResponse(buildDexResponse([buildDexPair({ mint, symbol: "FOO", priceUsd: "2.5" })])));

    await tokenMetadata([mint], fn);

    const row = await tokenRow(mint);
    expect(row?.symbol).toBe("FOO");
    expect(row?.price_state).toBe("priced");
    expect(Number(row?.price_usd)).toBeCloseTo(2.5);
  });

  it("gives a mint with no pair a symbol from the Helius fallback and price_state unpriced — never a price", async () => {
    vi.stubEnv("HELIUS_API_KEY", "test-key");
    const mint = inventAddress();
    const { fn } = fetchQueue(
      jsonResponse(buildDexResponse([])), // DexScreener: no pair
      jsonResponse(buildHeliusAssetResponse({ symbol: "BAZ", name: "Baz", decimals: 6 })), // Helius fallback
    );

    await tokenMetadata([mint], fn);

    const row = await tokenRow(mint);
    expect(row?.symbol).toBe("BAZ");
    expect(row?.decimals).toBe(6);
    expect(row?.price_state).toBe("unpriced");
    expect(row?.price_usd).toBeNull();
    expect(row?.price_sol).toBeNull();
  });

  it("without HELIUS_API_KEY configured, still marks a pairless mint unpriced without ever calling out to Helius", async () => {
    // Forced empty rather than relying on the ambient environment: whether a
    // real key happens to be configured on the machine running this suite
    // must not change what this test proves. The behaviour this pins is
    // real regardless — the production deployment this task was written
    // against has no key at all, and this is that exact code path.
    vi.stubEnv("HELIUS_API_KEY", "");
    const mint = inventAddress();
    const { fn, calls } = fetchQueue(jsonResponse(buildDexResponse([])));

    await tokenMetadata([mint], fn);

    expect(calls).toHaveLength(1); // only the DexScreener call; no DAS request was attempted
    const row = await tokenRow(mint);
    expect(row?.price_state).toBe("unpriced");
    expect(row?.symbol).toBeNull();
  });

  it("leaves a mint below the liquidity floor unpriced with no price", async () => {
    const mint = inventAddress();
    const { fn } = fetchQueue(jsonResponse(buildDexResponse([buildDexPair({ mint, liquidityUsd: 1, priceUsd: "9" })])));

    await tokenMetadata([mint], fn);

    const row = await tokenRow(mint);
    expect(row?.price_state).toBe("unpriced");
    expect(row?.price_usd).toBeNull();
  });

  it("a network failure leaves the previously cached row intact rather than blanking it", async () => {
    const mint = inventAddress();
    await query(
      `INSERT INTO token (mint, symbol, price_usd, price_state, updated_at) VALUES ($1, 'OLD', '42', 'priced', now())`,
      [mint],
    );

    const { fn } = fetchQueue(new TypeError("network down"));
    await tokenMetadata([mint], fn);

    const row = await tokenRow(mint);
    expect(row?.symbol).toBe("OLD");
    expect(row?.price_state).toBe("priced");
    expect(Number(row?.price_usd)).toBe(42);
  });

  it("batches to DexScreener's 30-mint limit: 31 mints make two calls, and the 31st mint is still written", async () => {
    vi.stubEnv("HELIUS_API_KEY", ""); // isolate the batching behaviour from the fallback path
    const mints = Array.from({ length: 31 }, () => inventAddress());
    const { fn, calls } = fetchQueue(jsonResponse(buildDexResponse([])), jsonResponse(buildDexResponse([])));

    const written = await tokenMetadata(mints, fn);

    expect(calls).toHaveLength(2);
    expect(calls[0].split(",")).toHaveLength(DEXSCREENER_BATCH_LIMIT);
    expect(calls[1].split(",")).toHaveLength(1);
    expect(written).toBe(31);
    expect(await tokenRow(mints[30])).toBeDefined(); // the 31st mint, alone in the second chunk
  });

  it("batches 60 mints into two full chunks and writes every one of them", async () => {
    vi.stubEnv("HELIUS_API_KEY", ""); // isolate the batching behaviour from the fallback path
    const mints = Array.from({ length: 60 }, () => inventAddress());
    const { fn, calls } = fetchQueue(jsonResponse(buildDexResponse([])), jsonResponse(buildDexResponse([])));

    const written = await tokenMetadata(mints, fn);

    expect(calls).toHaveLength(2);
    expect(calls[0].split(",")).toHaveLength(30);
    expect(calls[1].split(",")).toHaveLength(30);
    expect(written).toBe(60);
    expect(await tokenRow(mints[0])).toBeDefined();
    expect(await tokenRow(mints[29])).toBeDefined();
    expect(await tokenRow(mints[30])).toBeDefined();
    expect(await tokenRow(mints[59])).toBeDefined();
  });

  it("deduplicates a mint listed more than once", async () => {
    vi.stubEnv("HELIUS_API_KEY", ""); // isolate from the fallback path
    const mint = inventAddress();
    const { fn, calls } = fetchQueue(jsonResponse(buildDexResponse([])));

    const written = await tokenMetadata([mint, mint, mint], fn);

    expect(written).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].split(",")).toHaveLength(1);
  });

  it("does not overwrite a cached image with a blank one when a later response omits it", async () => {
    const mint = inventAddress();
    await query(
      `INSERT INTO token (mint, symbol, image_url, price_state, updated_at) VALUES ($1, 'OLD', 'https://x.test/old.png', 'unpriced', now())`,
      [mint],
    );
    const { fn } = fetchQueue(jsonResponse(buildDexResponse([buildDexPair({ mint, symbol: "NEW" })]))); // no imageUrl on this pair

    await tokenMetadata([mint], fn);

    const row = await tokenRow(mint);
    expect(row?.symbol).toBe("NEW");
    expect(row?.image_url).toBe("https://x.test/old.png");
  });
});

// ---------------------------------------------------------------------------
// solUsdAt / refreshSolPrice
// ---------------------------------------------------------------------------

describe("solUsdAt", () => {
  it("returns null when there is no row at or before the given minute", async () => {
    expect(await solUsdAt(new Date())).toBeNull();
  });

  it("resolves the most recent rate at or before the given minute", async () => {
    const early = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date("2026-01-01T00:05:00.000Z");
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '100'), ($2, '120')", [early, later]);

    expect(await solUsdAt(new Date("2026-01-01T00:02:00.000Z"))).toBe(100n * 10n ** 18n);
    expect(await solUsdAt(new Date("2026-01-01T00:10:00.000Z"))).toBe(120n * 10n ** 18n);
  });
});

describe("refreshSolPrice", () => {
  it("upserts the current minute's rate from the SOL/USDC pair", async () => {
    const now = new Date("2026-01-01T00:00:30.000Z");
    const { fn } = fetchQueue(
      jsonResponse(buildDexResponse([buildDexPair({ mint: WSOL_MINT, quoteMint: USDC_MINT, priceUsd: "150.25", liquidityUsd: 1_000_000 })])),
    );

    const wrote = await refreshSolPrice(fn, now);

    expect(wrote).toBe(true);
    const usd = await solUsdAt(now);
    expect(usd).toBe(15025n * 10n ** 16n); // 150.25 scaled
  });

  it("prefers the SOL/USDC pair even when a higher-liquidity SOL/other pair exists", async () => {
    const otherQuote = inventAddress();
    const { fn } = fetchQueue(
      jsonResponse(
        buildDexResponse([
          buildDexPair({ mint: WSOL_MINT, quoteMint: otherQuote, priceUsd: "999", liquidityUsd: 5_000_000 }),
          buildDexPair({ mint: WSOL_MINT, quoteMint: USDC_MINT, priceUsd: "151", liquidityUsd: 1_000 }),
        ]),
      ),
    );

    await refreshSolPrice(fn, new Date());

    const [row] = await query<{ usd: string }>("SELECT usd FROM sol_price");
    expect(Number(row.usd)).toBe(151);
  });

  it("a network failure leaves the previous rate resolvable and does not blank it", async () => {
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    await query("INSERT INTO sol_price (minute, usd) VALUES ($1, '100')", [earlier]);

    const { fn } = fetchQueue(new TypeError("network down"));
    const wrote = await refreshSolPrice(fn, new Date("2026-01-01T00:05:00.000Z"));

    expect(wrote).toBe(false);
    expect(await solUsdAt(new Date("2026-01-01T00:05:00.000Z"))).toBe(100n * 10n ** 18n);
    const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM sol_price");
    expect(Number(count)).toBe(1); // no new row written at all
  });

  it("writes nothing when DexScreener reports no SOL/USDC pair at all", async () => {
    const { fn } = fetchQueue(jsonResponse(buildDexResponse([])));
    const wrote = await refreshSolPrice(fn, new Date());
    expect(wrote).toBe(false);
    const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM sol_price");
    expect(Number(count)).toBe(0);
  });

  // The one live call this suite makes against a third party, per the task
  // brief: DexScreener needs no API key, so this does not depend on any
  // secret being configured. Everything else in this file runs on fixtures.
  // Goes through the named escape hatch (network-guard.ts's realFetch)
  // rather than the ambient `fetch`, which every test file's setup now
  // replaces with one that throws.
  it("resolves a real SOL/USD rate from the live DexScreener API (network)", async () => {
    const wrote = await refreshSolPrice(realFetch, new Date());
    expect(wrote).toBe(true);
    const usd = await solUsdAt(new Date());
    expect(usd).not.toBeNull();
    // Sanity bounds, not a pinned value: SOL has traded well within this
    // range for years, and the point is only to prove a real number came
    // back, not to assert what it currently is.
    const asNumber = Number(usd) / 1e18;
    expect(asNumber).toBeGreaterThan(1);
    expect(asNumber).toBeLessThan(100_000);
  }, 15_000);
});

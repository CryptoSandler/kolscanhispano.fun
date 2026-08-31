import { beforeEach, describe, expect, it, vi } from "vitest";
import { aadFor, blindIndex, encrypt } from "@/lib/crypto";
import { query } from "@/lib/db";
import { inventAddress, inventSignature } from "@/lib/ids";
import type { PublicTrade } from "@/lib/serialize";
import { addWallet } from "@/lib/wallets";
import { GET } from "./route";

// `spy: true` keeps every real implementation and wraps it, so these tests
// exercise the same code as the rest of the file while being able to say which
// of the two queries a request actually ran.
vi.mock("@/lib/feed", { spy: true });
import * as feed from "@/lib/feed";

type TradeSpec = {
  id?: string;
  kolId: string;
  walletId: string;
  mint: string;
  side: "buy" | "sell";
  /** Written as a string: a float here would defeat the point of `numeric`. */
  sol: string;
  tokens: string;
  priceUsd: string | null;
  /** UTC instant as an ISO string. */
  at: string;
  signature?: string;
};

/**
 * Inserts trades the way the parser does — one encrypted signature per row,
 * bound to that row's id through the AAD — so the route has to decrypt
 * exactly what production stores rather than a plaintext stand-in.
 */
async function insertTrades(specs: TradeSpec[]): Promise<TradeSpec[]> {
  const rows = specs.map((spec) => {
    const id = spec.id ?? crypto.randomUUID();
    const signature = spec.signature ?? inventSignature();
    return { ...spec, id, signature };
  });

  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                        mint, side, token_amount, sol_amount, price_usd, fee_sol, block_time)
     SELECT e.id::uuid, decode(e.hmac, 'hex'), decode(e.enc, 'hex'), 0, e.kol_id::uuid,
            e.wallet_id::uuid, e.mint, e.side, e.tokens::numeric, e.sol::numeric,
            e.price_usd::numeric, 0, e.at::timestamptz
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
            AS e(id, hmac, enc, kol_id, wallet_id, mint, side, tokens, sol, price_usd, at)`,
    [
      rows.map((r) => r.id),
      rows.map((r) => blindIndex(r.signature, "signature").toString("hex")),
      rows.map((r) => encrypt(r.signature, aadFor("trade", "signature", r.id)).toString("hex")),
      rows.map((r) => r.kolId),
      rows.map((r) => r.walletId),
      rows.map((r) => r.mint),
      rows.map((r) => r.side),
      rows.map((r) => r.tokens),
      rows.map((r) => r.sol),
      rows.map((r) => r.priceUsd),
      rows.map((r) => r.at),
    ],
  );
  return rows;
}

type Kol = { id: string; walletId: string; address: string };

async function insertKol(options: {
  slug: string;
  hideWallets: boolean;
  status?: string;
  cabalTag?: string;
}): Promise<Kol> {
  let cabalId: string | null = null;
  if (options.cabalTag) {
    cabalId = crypto.randomUUID();
    await query("INSERT INTO cabal (id, tag, name) VALUES ($1, $2, $3)", [
      cabalId,
      options.cabalTag,
      options.cabalTag,
    ]);
  }
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, cabal_id, hide_wallets, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [id, options.slug, options.slug.toUpperCase(), options.slug, cabalId, options.hideWallets,
     options.status ?? "approved"],
  );
  const address = inventAddress();
  const walletId = await addWallet(id, address);
  return { id, walletId, address };
}

function request(search = "", ifNoneMatch: string | null = null): Request {
  return new Request(`http://localhost/api/feed${search}`, {
    headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {},
  });
}

type FeedBody = { trades: PublicTrade[]; hasMore: boolean };

async function page(response: Response): Promise<FeedBody> {
  return (await response.json()) as FeedBody;
}

async function trades(response: Response): Promise<PublicTrade[]> {
  return (await page(response)).trades;
}

function cursorOf(trade: PublicTrade): string {
  return `?since=${encodeURIComponent(`${trade.blockTime},${trade.id}`)}`;
}

let mint: string;

beforeEach(async () => {
  // `rate_limit` too: every one of these routes goes through `rateLimited()`
  // now, the client IP is a constant in tests, so hits accumulate across
  // cases and files until a later, unrelated case gets a 429 and fails for
  // a reason nothing in it mentions.
  await query("TRUNCATE kol, kol_wallet, cabal, token, trade, position, pnl_daily, " +
    "pnl_position_daily, rate_limit CASCADE");
  mint = inventAddress();
  vi.mocked(feed.readFeedPage).mockClear();
  vi.mocked(feed.readFeedValidator).mockClear();
});

describe("GET /api/feed", () => {
  it("returns trades newest first", async () => {
    const kol = await insertKol({ slug: "uno", hideWallets: false });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
      { kolId: kol.id, walletId: kol.walletId, mint, side: "sell", sol: "2", tokens: "20",
        priceUsd: "0.02", at: "2026-08-25T12:00:00Z" },
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "3", tokens: "30",
        priceUsd: "0.03", at: "2026-08-25T11:00:00Z" },
    ]);

    const got = await trades(await GET(request()));
    expect(got.map((t) => t.blockTime)).toEqual([
      "2026-08-25T12:00:00.000Z",
      "2026-08-25T11:00:00.000Z",
      "2026-08-25T10:00:00.000Z",
    ]);
  });

  it("joins the KOL, the cabal tag and the token symbol", async () => {
    const kol = await insertKol({ slug: "dos", hideWallets: false, cabalTag: "EJE" });
    await query("INSERT INTO token (mint, symbol, name) VALUES ($1, 'EJE', 'Ejemplo')", [mint]);
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);

    const [got] = await trades(await GET(request()));
    expect(got.kol.slug).toBe("dos");
    expect(got.kol.cabalTag).toBe("EJE");
    expect(got.symbol).toBe("EJE");
    expect(got.kol.avatarUrl).toBe(`/api/avatar/${kol.id}`);
  });

  it("returns a trade whose token row is missing, with a null symbol", async () => {
    const kol = await insertKol({ slug: "tres", hideWallets: false });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: null, at: "2026-08-25T10:00:00Z" },
    ]);

    const got = await trades(await GET(request()));
    expect(got).toHaveLength(1);
    expect(got[0].symbol).toBeNull();
    expect(got[0].priceUsd).toBeNull();
  });

  it("returns only trades after the `since` cursor", async () => {
    const kol = await insertKol({ slug: "cuatro", hideWallets: false });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "2", tokens: "20",
        priceUsd: "0.01", at: "2026-08-25T11:00:00Z" },
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "3", tokens: "30",
        priceUsd: "0.01", at: "2026-08-25T12:00:00Z" },
    ]);

    const all = await trades(await GET(request()));
    const after = await trades(await GET(request(cursorOf(all[1])))); // after the 11:00 trade
    expect(after.map((t) => t.blockTime)).toEqual(["2026-08-25T12:00:00.000Z"]);
  });

  // The cursor is `(block_time, id)`, not `block_time` alone. Postgres stores
  // `timestamptz` at microsecond resolution but two trades in one block share
  // an instant, and a cursor that compared only the timestamp would either
  // replay the tie or drop it. Neither shows up unless the tie exists.
  it("breaks a cursor tie on id, returning the other trade in the same instant exactly once",
    async () => {
      const kol = await insertKol({ slug: "cinco", hideWallets: false });
      const at = "2026-08-25T10:00:00Z";
      await insertTrades([
        { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
          priceUsd: "0.01", at },
        { kolId: kol.id, walletId: kol.walletId, mint, side: "sell", sol: "2", tokens: "20",
          priceUsd: "0.01", at },
      ]);

      const all = await trades(await GET(request()));
      expect(all).toHaveLength(2);
      // `all` is newest-first, so all[1] is the lower id at the same instant.
      const after = await trades(await GET(request(cursorOf(all[1]))));
      expect(after.map((t) => t.id)).toEqual([all[0].id]);

      // And from the newest one, nothing is left.
      expect(await trades(await GET(request(cursorOf(all[0]))))).toHaveLength(0);
    });

  it("caps the page at 50 trades", async () => {
    const kol = await insertKol({ slug: "seis", hideWallets: false });
    await insertTrades(
      Array.from({ length: 60 }, (_, i) => ({
        kolId: kol.id, walletId: kol.walletId, mint, side: "buy" as const, sol: "1",
        tokens: "10", priceUsd: "0.01",
        at: new Date(Date.UTC(2026, 7, 25, 0, i)).toISOString(),
      })),
    );

    const got = await trades(await GET(request()));
    expect(got).toHaveLength(50);
    // Newest first means the cap drops the oldest ten, not the newest ten.
    expect(got[0].blockTime).toBe(new Date(Date.UTC(2026, 7, 25, 0, 59)).toISOString());
  });

  it("carries no signature for a KOL that hides its wallets", async () => {
    const kol = await insertKol({ slug: "siete", hideWallets: true });
    const [row] = await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);

    const response = await GET(request());
    const text = await response.clone().text();
    const got = await trades(response);
    expect(got).toHaveLength(1);
    expect(got[0].signature).toBeNull();
    expect(text).not.toContain(row.signature!);
    expect(text).not.toContain(kol.address);
  });

  // Two KOLs in one page, one hidden and one public: a route that decided
  // publication once for the whole response instead of once per row would
  // pass the single-KOL test above and fail here.
  it("hides one KOL's signature while publishing another's in the same page", async () => {
    const hidden = await insertKol({ slug: "ocho", hideWallets: true });
    const shown = await insertKol({ slug: "nueve", hideWallets: false });
    const [hiddenRow, shownRow] = await insertTrades([
      { kolId: hidden.id, walletId: hidden.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
      { kolId: shown.id, walletId: shown.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T11:00:00Z" },
    ]);

    const response = await GET(request());
    const text = await response.clone().text();
    const got = await trades(response);
    const bySlug = Object.fromEntries(got.map((t) => [t.kol.slug, t]));
    expect(bySlug.ocho.signature).toBeNull();
    expect(bySlug.nueve.signature).toBe(shownRow.signature);
    expect(text).not.toContain(hiddenRow.signature!);
    expect(text).not.toContain(hidden.address);
    expect(text).not.toContain(shown.address);
  });

  it("omits a suspended KOL from every page", async () => {
    const kol = await insertKol({ slug: "diez", hideWallets: false, status: "suspended" });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);
    expect(await trades(await GET(request()))).toHaveLength(0);
  });

  it("omits a KOL still awaiting approval", async () => {
    const kol = await insertKol({ slug: "once", hideWallets: false, status: "pending" });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);
    expect(await trades(await GET(request()))).toHaveLength(0);
  });

  it("answers 304 to a repeated request carrying the ETag it returned", async () => {
    const kol = await insertKol({ slug: "doce", hideWallets: false });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);

    const first = await GET(request());
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await GET(request("", etag));
    expect(second.status).toBe(304);
    // RFC 9110: a 304 repeats the validator, so the client can keep polling.
    expect(second.headers.get("etag")).toBe(etag);
    expect(await second.text()).toBe("");
  });

  it("answers 200 with the new trade once one arrives, despite the old ETag", async () => {
    const kol = await insertKol({ slug: "trece", hideWallets: false });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);
    const etag = (await GET(request())).headers.get("etag");

    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "sell", sol: "2", tokens: "20",
        priceUsd: "0.02", at: "2026-08-25T11:00:00Z" },
    ]);

    const second = await GET(request("", etag));
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag);
    expect((await trades(second)).map((t) => t.blockTime)).toEqual([
      "2026-08-25T11:00:00.000Z",
      "2026-08-25T10:00:00.000Z",
    ]);
  });

  // An idle feed is the common case: the client holds a cursor at the newest
  // trade and gets an empty page. That has to be a 304 on the second poll too,
  // or "an idle feed costs a 304" is false exactly when it matters.
  it("answers 304 to a repeated poll that finds nothing new", async () => {
    const kol = await insertKol({ slug: "catorce", hideWallets: false });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);
    const [newest] = await trades(await GET(request()));
    const search = cursorOf(newest);

    const first = await GET(request(search));
    expect(first.status).toBe(200);
    expect(await trades(first)).toHaveLength(0);

    const second = await GET(request(search, first.headers.get("etag")));
    expect(second.status).toBe(304);
  });

  it("rejects a malformed cursor rather than ignoring it", async () => {
    const kol = await insertKol({ slug: "quince", hideWallets: false });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);
    for (const bad of ["nonsense", "2026-08-25T10:00:00.000Z,not-a-uuid", ",", "1' OR '1'='1"]) {
      const response = await GET(request(`?since=${encodeURIComponent(bad)}`));
      expect(response.status).toBe(400);
    }
  });
  // `feed.ts` never selects the address, so no route test can catch a
  // serializer that forwarded it — the unit test and the type are the whole
  // defence there. What a route test *can* pin is the shape that leaves the
  // process: enumerate it, and a query that starts selecting more, or a
  // serializer that starts spreading its input, fails here rather than
  // shipping `hide_wallets` and `display_name` to a browser.
  it("forwards exactly the public shape, whatever the query selects", async () => {
    const kol = await insertKol({ slug: "dieciseis", hideWallets: false, cabalTag: "EJE" });
    await query("INSERT INTO token (mint, symbol, name) VALUES ($1, 'EJE', 'Ejemplo')", [mint]);
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);

    const response = await GET(request());
    const text = await response.clone().text();
    const [got] = await trades(response);

    expect(Object.keys(got).sort()).toEqual(
      // `usdAmount` joined the shared trade shape for `modal-kol`'s
      // `list-defi-trades` ("its USD equivalent"): it is the trade's
      // `usd_amount`, fixed at its block by spec §4.1, and a different figure
      // from the per-token `priceUsd` this feed row prints. One serializer, one
      // shape, so the feed carries it too -- extended here rather than the
      // assertion loosened, and it is still exact set equality.
      ["blockTime", "id", "kol", "mint", "priceUsd", "side", "signature", "solAmount", "symbol",
       "tokenAmount", "usdAmount"].sort(),
    );
    expect(Object.keys(got.kol).sort()).toEqual(
      ["avatarUrl", "cabalTag", "hideWallets", "name", "slug"].sort(),
    );

    // Every column name the query touches. A spread of the database row would
    // put each of them in the body verbatim.
    for (const column of ["hide_wallets", "display_name", "kol_id", "cabal_tag", "block_time",
      "sol_amount", "token_amount", "usd_amount", "price_usd", "signature_enc", "wallet_id",
      "signature_hmac", "address"]) {
      expect(text).not.toContain(column);
    }
  });

  it("says nothing more is waiting on the opening page", async () => {
    const kol = await insertKol({ slug: "diecisiete", hideWallets: false });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);
    expect((await page(await GET(request()))).hasMore).toBe(false);
  });

  // The failure this closes: `?since` used to answer with the *newest* 50 rows
  // after the cursor, and the client then advanced past rows it had never been
  // handed. A burst of more than one page between two polls lost its oldest
  // trades with every response a 200 and nothing recording the loss.
  it("delivers a burst larger than one page without dropping any of it", async () => {
    const kol = await insertKol({ slug: "dieciocho", hideWallets: false });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T00:00:00Z" },
    ]);
    const [start] = await trades(await GET(request()));

    // 60 trades land after the cursor while the client is between polls.
    await insertTrades(
      Array.from({ length: 60 }, (_, i) => ({
        kolId: kol.id, walletId: kol.walletId, mint, side: "buy" as const, sol: "1",
        tokens: "10", priceUsd: "0.01",
        at: new Date(Date.UTC(2026, 7, 25, 1, i)).toISOString(),
      })),
    );

    const first = await page(await GET(request(cursorOf(start))));
    expect(first.trades).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    // Newest-first within the page, and the page is the *oldest* 50 of the
    // burst — the ones the client would otherwise never see.
    expect(first.trades[0].blockTime).toBe(new Date(Date.UTC(2026, 7, 25, 1, 49)).toISOString());
    expect(first.trades[49].blockTime).toBe(new Date(Date.UTC(2026, 7, 25, 1, 0)).toISOString());

    // The client advances to the newest row it actually received, and asks
    // again because `hasMore` said to.
    const second = await page(await GET(request(cursorOf(first.trades[0]))));
    expect(second.trades).toHaveLength(10);
    expect(second.hasMore).toBe(false);

    const delivered = [...second.trades, ...first.trades].map((t) => t.id);
    expect(new Set(delivered).size).toBe(60);
    // And nothing arrived twice.
    expect(delivered).toHaveLength(60);
  });

  // The ETag exists to save the server work, not to save the client bytes.
  // Deriving it from a finished page meant a quiet poll ran the four-table
  // join and fifty AES-GCM decrypts and then threw all of it away.
  it("answers 304 without running the page query at all", async () => {
    const kol = await insertKol({ slug: "diecinueve", hideWallets: false });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);

    const first = await GET(request());
    expect(vi.mocked(feed.readFeedPage)).toHaveBeenCalledTimes(1);

    vi.mocked(feed.readFeedPage).mockClear();
    vi.mocked(feed.readFeedValidator).mockClear();

    const second = await GET(request("", first.headers.get("etag")));
    expect(second.status).toBe(304);
    expect(vi.mocked(feed.readFeedValidator)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(feed.readFeedPage)).not.toHaveBeenCalled();
  });

  it("runs the page query on a miss", async () => {
    const kol = await insertKol({ slug: "veinte", hideWallets: false });
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
    ]);
    const res = await GET(request("", 'W/"stale"'));
    expect(res.status).toBe(200);
    expect(vi.mocked(feed.readFeedPage)).toHaveBeenCalledTimes(1);
  });

  it("neither probes nor queries when the cursor is malformed", async () => {
    const res = await GET(request("?since=nonsense"));
    expect(res.status).toBe(400);
    expect(vi.mocked(feed.readFeedValidator)).not.toHaveBeenCalled();
    expect(vi.mocked(feed.readFeedPage)).not.toHaveBeenCalled();
  });

  it("carries the wallet promise as a field, not as the absence of a signature", async () => {
    const hidden = await insertKol({ slug: "veintiuno", hideWallets: true });
    const shown = await insertKol({ slug: "veintidos", hideWallets: false });
    await insertTrades([
      { kolId: hidden.id, walletId: hidden.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T10:00:00Z" },
      { kolId: shown.id, walletId: shown.walletId, mint, side: "buy", sol: "1", tokens: "10",
        priceUsd: "0.01", at: "2026-08-25T11:00:00Z" },
    ]);

    const bySlug = Object.fromEntries(
      (await trades(await GET(request()))).map((t) => [t.kol.slug, t]),
    );
    expect(bySlug.veintiuno.kol.hideWallets).toBe(true);
    expect(bySlug.veintidos.kol.hideWallets).toBe(false);
  });
});

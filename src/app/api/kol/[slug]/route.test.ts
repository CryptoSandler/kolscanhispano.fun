/**
 * `GET /api/kol/<slug>` — the read behind DESIGN.md's `modal-kol`.
 *
 * A per-KOL endpoint is a **new public surface and a new payload**, so the
 * invariants get asserted here from scratch rather than inherited: spec §7's
 * address promise, and — for a KOL that hides its wallets — the signature
 * promise that goes with it. Both are asserted against a fixture that really
 * stored an address and really stored signatures, so "the response does not
 * contain it" is a statement about this route rather than about a fixture that
 * supplied nothing.
 *
 * Signatures are inserted the way the parser writes them — AES-GCM, bound to
 * the row id through the AAD — because the modal's trade list decrypts them
 * through the same `feed.ts` path the live feed uses. A fixture that stored
 * plaintext would exercise a code path production does not have.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aadFor, blindIndex, encrypt } from "@/lib/crypto";
import { query } from "@/lib/db";
import { findDisallowedBase58 } from "@/lib/hygiene";
import { inventAddress, inventSignature } from "@/lib/ids";
import type { PublicKolDetail } from "@/lib/serialize";
import { addWallet, setWalletVisibility } from "@/lib/wallets";
import { GET } from "./route";

/** The same Tuesday 01:00 UTC `/api/leaderboard`'s suite pins, and for the same reason. */
/**
 * **23:00 on the Tuesday, not 01:00**, since the windows became rolling on
 * 2026-09-03.
 *
 * Every fixture in this file is written as a calendar day: trades at 02:00 and
 * 05:00 on the 25th, daily rows dated the 25th. Under `Diario` — the UTC day —
 * an instant of 01:00 was fine, because the window ran to the end of the day.
 * A rolling `1D` ends **now**, so at 01:00 every one of those fixtures was in
 * the future and every window came back empty.
 *
 * Moving the clock to the end of the same day keeps every existing timestamp
 * meaningful and inside `1D`, and keeps the 24th outside it — which is what the
 * cases here actually assert. The alternative was rewriting sixteen timestamps
 * to say the same thing.
 */
const NOW = "2026-08-25T23:00:00Z";

type Kol = {
  id: string;
  slug: string;
  walletId: string;
  /** The real, encrypted-at-rest address this KOL's trades were signed by. */
  address: string;
};

async function insertKol(options: {
  slug: string;
  hideWallets?: boolean;
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
    [
      id,
      options.slug,
      options.slug.toUpperCase(),
      options.slug,
      cabalId,
      options.hideWallets ?? false,
      options.status ?? "approved",
    ],
  );
  // Publication is per wallet since migration 012, and these fixtures were
  // written when it was per KOL. `hideWallets: false` meant "this KOL's
  // signatures are published", so it now publishes the wallet -- the same
  // intent, expressed against the row that actually decides.
  const address = inventAddress();
  const walletId = await addWallet(id, address);
  if (!(options.hideWallets ?? false)) await setWalletVisibility(id, walletId, true);
  return { id, slug: options.slug, walletId, address };
}

/**
 * A day's realized PnL for a KOL — **both halves**, since 2026-09-03.
 *
 * The modal's window figures come from `trade.realized_sol` now, not from
 * `pnl_daily`: every window is rolling and a day bucket cannot be cut at an
 * arbitrary hour (`migrations/015`). `pnl_daily` still backs the calendar
 * card's month series, so both are written — which is also the state a real
 * replay leaves, because the same arithmetic feeds them.
 *
 * The sell lands at **00:30 UTC** of the day, comfortably inside a window that
 * ends at the frozen `NOW` rather than balanced on its edge.
 */
async function insertDaily(
  specs: { kolId: string; day: string; sol: string; usd: string; wins?: number; losses?: number }[],
): Promise<void> {
  for (const spec of specs) {
    const [wallet] = await query<{ id: string }>(
      "SELECT id FROM kol_wallet WHERE kol_id = $1 LIMIT 1",
      [spec.kolId],
    );
    if (wallet === undefined) continue;
    const id = crypto.randomUUID();
    const signature = inventSignature();
    await query(
      `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                          mint, side, token_amount, sol_amount, usd_amount, fee_sol, block_time,
                          realized_sol, realized_usd)
       VALUES ($1::uuid, decode($2, 'hex'), decode($3, 'hex'), 0, $4::uuid, $5::uuid,
               $6, 'sell', 1, $7::numeric, $8::numeric, 0, ($9 || 'T00:30:00Z')::timestamptz,
               $7::numeric, $8::numeric)`,
      [
        id,
        blindIndex(signature, "signature").toString("hex"),
        encrypt(signature, aadFor("trade", "signature", id)).toString("hex"),
        spec.kolId,
        wallet.id,
        inventAddress(),
        spec.sol,
        spec.usd,
        spec.day,
      ],
    );
  }

  await query(
    `INSERT INTO pnl_daily (kol_id, day, realized_sol, realized_usd, wins, losses)
     SELECT e.kol_id::uuid, e.day::date, e.sol::numeric, e.usd::numeric, e.wins::int, e.losses::int
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[])
            AS e(kol_id, day, sol, usd, wins, losses)`,
    [
      specs.map((s) => s.kolId),
      specs.map((s) => s.day),
      specs.map((s) => s.sol),
      specs.map((s) => s.usd),
      specs.map((s) => s.wins ?? 0),
      specs.map((s) => s.losses ?? 0),
    ],
  );
}

type TradeSpec = {
  kol: Kol;
  mint: string;
  side: "buy" | "sell";
  sol: string;
  tokens: string;
  usd: string | null;
  at: string;
};

/** Returns the plaintext signatures, so their presence or absence can be stated. */
async function insertTrades(specs: TradeSpec[]): Promise<string[]> {
  const rows = specs.map((spec) => ({ ...spec, id: crypto.randomUUID(), signature: inventSignature() }));
  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                        mint, side, token_amount, sol_amount, usd_amount, fee_sol, block_time)
     SELECT e.id::uuid, decode(e.hmac, 'hex'), decode(e.enc, 'hex'), 0, e.kol_id::uuid,
            e.wallet_id::uuid, e.mint, e.side, e.tokens::numeric, e.sol::numeric,
            e.usd::numeric, 0, e.at::timestamptz
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
            AS e(id, hmac, enc, kol_id, wallet_id, mint, side, tokens, sol, usd, at)`,
    [
      rows.map((r) => r.id),
      rows.map((r) => blindIndex(r.signature, "signature").toString("hex")),
      rows.map((r) => encrypt(r.signature, aadFor("trade", "signature", r.id)).toString("hex")),
      rows.map((r) => r.kol.id),
      rows.map((r) => r.kol.walletId),
      rows.map((r) => r.mint),
      rows.map((r) => r.side),
      rows.map((r) => r.tokens),
      rows.map((r) => r.sol),
      rows.map((r) => r.usd),
      rows.map((r) => r.at),
    ],
  );
  return rows.map((r) => r.signature);
}

function call(slug: string, search = ""): Promise<Response> {
  return GET(new Request(`http://localhost/api/kol/${slug}${search}`), {
    params: Promise.resolve({ slug }),
  });
}

async function detail(slug: string, search = ""): Promise<PublicKolDetail> {
  const response = await call(slug, search);
  expect(response.status).toBe(200);
  return (await response.json()) as PublicKolDetail;
}

beforeEach(async () => {
  await query(
    "TRUNCATE kol, kol_wallet, cabal, token, trade, position, pnl_daily, pnl_position_daily, rate_limit CASCADE",
  );
  // Only `Date` is faked; faking timers wholesale would replace the
  // `setTimeout` the Postgres driver runs on and hang the suite.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/kol/<slug>", () => {
  it("sums the same window the leaderboard row sums", async () => {
    /*
      The property that matters is not the arithmetic — `/api/leaderboard`
      already pins that — but that the modal and the row cannot disagree. Both
      read `trade.realized_sol` through `windowBounds`, so the same three
      windows cut the same sells.

      **The expected figures changed on 2026-09-03 and the fixture did not**,
      which is the clearest statement of what the windows now mean. `NOW` is
      23:00 on Tuesday the 25th:

        `1D`  reaches back to Monday 23:00 → the 25th only          → 3.5
        `7D`  reaches back to the 18th 23:00 → the 25th, 24th, 20th → 14.75
        `30D` reaches back to July 26th → all but the July 31st row → 14.75

      Under the calendar windows `7D`'s ancestor was the ISO week from Monday
      the 24th, so it took the 25th and the 24th and came to 4.75, and the
      August 20th row belonged to `Mensual` alone. The rolling week reaches
      further back than the ISO week does on a Tuesday — which is precisely the
      difference `docs/round-ventanas-moviles.md` §1 said would not be visible
      to a reader, and is very visible here.
    */
    const kol = await insertKol({ slug: "uno" });
    await insertDaily([
      { kolId: kol.id, day: "2026-08-25", sol: "3.5", usd: "500" },
      { kolId: kol.id, day: "2026-08-24", sol: "1.25", usd: "180" },
      { kolId: kol.id, day: "2026-08-20", sol: "10", usd: "1400" },
      // Outside 30 days from the 25th, so it must never appear in any window.
      { kolId: kol.id, day: "2026-07-20", sol: "999", usd: "999999" },
    ]);

    expect((await detail("uno", "?window=1d")).realizedSol).toBe("3.5");
    expect((await detail("uno", "?window=7d")).realizedSol).toBe("14.75");
    expect((await detail("uno", "?window=30d")).realizedSol).toBe("14.75");
    expect((await detail("uno", "?window=30d")).realizedUsd).toBe("2080");
  });

  it("reports back the window it summed", async () => {
    await insertKol({ slug: "uno" });
    expect((await detail("uno", "?window=7d")).window).toBe("7d");
    // The modal uses it to discard a response that arrives after the reader has
    // moved to another segment, so it has to be the *answered* window and not
    // an echo of the request.
    expect((await detail("uno")).window).toBe("1d");
  });
});

describe("card-calendario-pnl's series", () => {
  it("accumulates the calendar month's figures, and says the same days it paints", async () => {
    const kol = await insertKol({ slug: "uno" });
    await insertDaily([
      { kolId: kol.id, day: "2026-08-24", sol: "1.25", usd: "180" },
      { kolId: kol.id, day: "2026-08-25", sol: "-0.5", usd: "-70" },
    ]);

    const body = await detail("uno", "?window=7d");
    // Each day carries its own figure **and** the running total: the calendar
    // paints the first and a calendar that recovered the daily figure by
    // differencing could not tell a flat day from a missing one.
    expect(body.series).toEqual([
      { day: "2026-08-24", dailySol: "1.25", cumulativeSol: "1.25" },
      // `dailySol` is the string Postgres emitted for the `numeric`, untouched
      // — `-0.5`, not the `-0.50` the screen prints. Every reader parses it
      // with `decimal.ts`; normalising it here would be a second formatter.
      { day: "2026-08-25", dailySol: "-0.5", cumulativeSol: "0.75" },
    ]);

    /*
      **`series` and `calendar.days` are the same days**, which is the property
      that replaced "the running total ends on the window total".

      That old identity was true while `series` spanned the window; since
      2026-09-03 it spans the calendar **month** and the window is rolling, so
      the two coincide only when the month happens to contain exactly the
      window's days. Asserting it would pin a coincidence. What must hold is
      that the two fields describing one card never disagree.
    */
    expect(body.series.map((point) => point.day)).toEqual(
      body.calendar.days.map((day) => day.day),
    );
    expect(body.series.map((point) => point.dailySol)).toEqual(
      body.calendar.days.map((day) => day.dailySol),
    );
  });

  it("dates each point by the UTC calendar day, not the runner's", async () => {
    // `pnl_daily.day` is a `date`. Read as a `Date` it would be parsed at the
    // runner's local midnight, so every point west of UTC would shift a day --
    // the same local-time leak `windows.ts` exists to prevent, one layer up.
    const kol = await insertKol({ slug: "uno" });
    await insertDaily([{ kolId: kol.id, day: "2026-08-25", sol: "1", usd: "100" }]);
    expect((await detail("uno")).series).toEqual([
      { day: "2026-08-25", dailySol: "1", cumulativeSol: "1" },
    ]);
  });

  it("is empty when the month closed nothing, rather than a zeroed point", async () => {
    /*
      DESIGN.md: "Absence is rendered as absence, never as a zero", and its
      two-states table gives this case its own empty state
      (`Sin operaciones cerradas en este período.`). A zero point would draw a
      flat calendar through a month in which nothing happened.

      **The span is the month, not the window**, since 2026-09-03 — a rolling
      window has partial days at both ends and `pnl_daily` is keyed by `date`.
      So the empty case is a month with no rows, and the case below it is the
      one worth keeping apart: a day *outside* the window still paints its cell,
      because the calendar is not the window and never claimed to be.
    */
    await insertKol({ slug: "uno" });
    const body = await detail("uno", "?window=1d");
    expect(body.series).toEqual([]);
    expect(body.calendar.days).toEqual([]);
    expect(body.realizedSol).toBe("0");
  });

  it("paints a day the calendar's month covers even when the window does not", async () => {
    // The 20th is inside August and outside the last 24 hours. The card shows
    // it; the header's figure does not count it. Two periods on one screen, and
    // the month's own total on the card is what keeps them apart —
    // `docs/round-ventanas-moviles.md` §5 and `kol-detail.tsx`.
    const kol = await insertKol({ slug: "uno" });
    await insertDaily([{ kolId: kol.id, day: "2026-08-20", sol: "5", usd: "700" }]);

    const body = await detail("uno", "?window=1d");
    expect(body.series).toEqual([
      { day: "2026-08-20", dailySol: "5", cumulativeSol: "5" },
    ]);
    expect(body.realizedSol).toBe("0");
  });
});

describe("card-stats", () => {
  it("counts the trades and sums the SOL both sides moved, inside the window", async () => {
    const kol = await insertKol({ slug: "uno" });
    const mint = inventAddress();
    await insertTrades([
      { kol, mint, side: "buy", sol: "2.5", tokens: "100", usd: "500", at: "2026-08-25T02:00:00Z" },
      { kol, mint, side: "sell", sol: "4", tokens: "100", usd: "800", at: "2026-08-25T03:00:00Z" },
      // Yesterday: inside the week, outside the day.
      { kol, mint, side: "buy", sol: "9", tokens: "50", usd: "1800", at: "2026-08-24T22:00:00Z" },
    ]);

    const daily = await detail("uno", "?window=1d");
    expect(daily.tradeCount).toBe(2);
    // Turnover, not a net: a buy spends SOL and a sell receives it.
    expect(daily.volumeSol).toBe("6.5");

    const weekly = await detail("uno", "?window=7d");
    expect([weekly.tradeCount, weekly.volumeSol]).toEqual([3, "15.5"]);
  });

  it("answers zero for a KOL that traded nothing in the window", async () => {
    await insertKol({ slug: "quieto" });
    const body = await detail("quieto");
    expect([body.tradeCount, body.volumeSol, body.realizedSol]).toEqual([0, "0", "0"]);
    expect(body.trades).toEqual([]);
  });
});

describe("list-defi-trades", () => {
  it("carries the KOL's trades in the window, newest first, with their USD equivalent", async () => {
    const kol = await insertKol({ slug: "uno" });
    const mint = inventAddress();
    await insertTrades([
      { kol, mint, side: "buy", sol: "1", tokens: "10", usd: "150", at: "2026-08-25T02:00:00Z" },
      { kol, mint, side: "sell", sol: "2", tokens: "10", usd: "300", at: "2026-08-25T05:00:00Z" },
      { kol, mint, side: "buy", sol: "9", tokens: "5", usd: "1350", at: "2026-08-24T05:00:00Z" },
    ]);

    const body = await detail("uno", "?window=1d");
    expect(body.trades.map((t) => t.blockTime)).toEqual([
      "2026-08-25T05:00:00.000Z",
      "2026-08-25T02:00:00.000Z",
    ]);
    // DESIGN.md `list-defi-trades`: "verb, SOL amount by sign and its USD
    // equivalent." The equivalent is the trade's own `usd_amount`, fixed at its
    // block by spec §4.1 -- not a re-pricing, and not the per-token price.
    expect(body.trades.map((t) => t.usdAmount)).toEqual(["300", "150"]);
    expect(body.trades.map((t) => t.side)).toEqual(["sell", "buy"]);
  });

  it("says nothing about USD for a trade no rate covered, rather than zero", async () => {
    // Migration 005's "looked, no rate existed". `0` would be a claim that the
    // trade was worth nothing; DESIGN.md's `state-unpriced` says it in words.
    const kol = await insertKol({ slug: "uno" });
    await insertTrades([
      { kol, mint: inventAddress(), side: "buy", sol: "1", tokens: "10", usd: null,
        at: "2026-08-25T02:00:00Z" },
    ]);
    expect((await detail("uno")).trades[0].usdAmount).toBeNull();
  });

  it("only ever carries this KOL's trades", async () => {
    const uno = await insertKol({ slug: "uno" });
    const otro = await insertKol({ slug: "otro" });
    const mint = inventAddress();
    await insertTrades([
      { kol: uno, mint, side: "buy", sol: "1", tokens: "10", usd: "150", at: "2026-08-25T02:00:00Z" },
      { kol: otro, mint, side: "buy", sol: "7", tokens: "70", usd: "1050", at: "2026-08-25T03:00:00Z" },
    ]);
    const body = await detail("uno");
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].solAmount).toBe("1");
  });
});

describe("spec §9: only approved KOLs are on a public surface", () => {
  it("answers 404 for a slug that names nothing", async () => {
    const response = await call("no-existe");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("answers 404 for a suspended, pending or rejected KOL, indistinguishably", async () => {
    for (const status of ["suspended", "pending", "rejected"]) {
      const kol = await insertKol({ slug: `kol-${status}`, status });
      await insertDaily([{ kolId: kol.id, day: "2026-08-25", sol: "500", usd: "90000" }]);
      const response = await call(`kol-${status}`);
      expect(response.status, status).toBe(404);
      // The same body a missing slug gets: whether a slug exists is not
      // information this endpoint owes an anonymous caller.
      expect(await response.text()).toBe("not found");
    }
  });

  it("rejects a window it does not know, without echoing it back", async () => {
    await insertKol({ slug: "uno" });
    for (const search of ["?window=daily", "?window=anual", "?window="]) {
      const response = await call("uno", search);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("bad request");
    }
  });

  it("does not send an unbounded slug to the database", async () => {
    const response = await call("x".repeat(400));
    expect(response.status).toBe(404);
  });
});

describe("spec §7: the new payload carries no address, and no hidden signature", () => {
  it("prints none of the addresses the fixture stored, truncated included", async () => {
    const kol = await insertKol({ slug: "uno", cabalTag: "EJE" });
    await insertDaily([{ kolId: kol.id, day: "2026-08-25", sol: "1", usd: "100", wins: 1 }]);
    await insertTrades([
      { kol, mint: inventAddress(), side: "buy", sol: "1", tokens: "10", usd: "150",
        at: "2026-08-25T02:00:00Z" },
    ]);

    const text = await (await call("uno")).text();
    expect(text).not.toContain(kol.address);
    // `docs/references.md` §5: both reference sites print a `HFx9E1`-style chip.
    // Truncated counts as published, at the lengths such a chip uses. Six is the
    // floor for the reason `address-invariant.test.ts` measures out.
    for (const length of [6, 8]) {
      expect(text, `the first ${length} characters of an address`).not.toContain(
        kol.address.slice(0, length),
      );
      expect(text, `the last ${length} characters of an address`).not.toContain(
        kol.address.slice(-length),
      );
    }
  });

  it("carries no base58 run beyond the mints and the public KOL's signatures", async () => {
    // Set equality, not absence -- the same shape `address-invariant.test.ts`
    // argues for at length. A fixture that published nothing base58 would prove
    // nothing, so this one publishes a mint and a signature on purpose and the
    // assertion enumerates exactly those. Anything else fails, an address above
    // all, and adding to the expected set is a visible act.
    const kol = await insertKol({ slug: "uno" });
    const mint = inventAddress();
    const signatures = await insertTrades([
      { kol, mint, side: "buy", sol: "1", tokens: "10", usd: "150", at: "2026-08-25T02:00:00Z" },
    ]);

    const text = await (await call("uno")).text();
    expect(findDisallowedBase58(text).sort()).toEqual([mint, ...signatures].sort());
  });

  it("drops every signature for a KOL that hides its wallets", async () => {
    // Spec §7: "For hidden KOLs, neither the signature nor the link is
    // exposed." A signature names the signer in any explorer, so publishing it
    // while withholding the address publishes the address one click later.
    const kol = await insertKol({ slug: "oculto", hideWallets: true });
    const mint = inventAddress();
    const signatures = await insertTrades([
      { kol, mint, side: "buy", sol: "1", tokens: "10", usd: "150", at: "2026-08-25T02:00:00Z" },
      { kol, mint, side: "sell", sol: "2", tokens: "10", usd: "300", at: "2026-08-25T03:00:00Z" },
    ]);

    const response = await call("oculto");
    const text = await response.clone().text();
    const body = (await response.json()) as PublicKolDetail;

    expect(body.kol.hideWallets).toBe(true);
    expect(body.trades.map((t) => t.signature)).toEqual([null, null]);
    for (const signature of signatures) expect(text).not.toContain(signature);
    // ...and nothing base58 is left but the mint.
    expect(findDisallowedBase58(text)).toEqual([mint]);
  });

  it("keeps the signature for a KOL that publishes its wallets", async () => {
    // The other half: a route that dropped every signature would pass the case
    // above while breaking spec §8.2's explorer links for public KOLs.
    const kol = await insertKol({ slug: "abierto", hideWallets: false });
    const signatures = await insertTrades([
      { kol, mint: inventAddress(), side: "buy", sol: "1", tokens: "10", usd: "150",
        at: "2026-08-25T02:00:00Z" },
    ]);
    const body = await detail("abierto");
    expect(body.trades.map((t) => t.signature)).toEqual(signatures);
  });

  /**
   * The shape, pinned. The assertions above look at values; this one fixes the
   * key set, so a query that starts selecting more — or a serializer that
   * starts spreading its input — fails here rather than shipping a wallet id to
   * a browser.
   */
  it("forwards exactly the public shape", async () => {
    const kol = await insertKol({ slug: "uno", cabalTag: "EJE" });
    await insertDaily([{ kolId: kol.id, day: "2026-08-25", sol: "1", usd: "100", wins: 1 }]);
    await insertTrades([
      { kol, mint: inventAddress(), side: "buy", sol: "1", tokens: "10", usd: "150",
        at: "2026-08-25T02:00:00Z" },
    ]);

    const response = await call("uno");
    const text = await response.clone().text();
    const body = (await response.json()) as PublicKolDetail;

    /*
      **`calendar` joined the shape on 2026-09-03**, and this line is where a
      change to the published contract has to be made on purpose rather than
      absorbed. It carries the PnL calendar's own month — `{ month, days, sells }`
      — because the card stopped spanning the window and became a month the
      reader pages through.

      It is checked field by field below for the same reason the rest of this
      case exists: `readKolDetail` spreads an identity row into the serializer,
      so the only thing between a column and a public field is the serializer
      naming its fields one at a time.
    */
    expect(Object.keys(body).sort()).toEqual(
      ["calendar", "chains", "from", "kol", "privateWallets", "publicWallets", "realizedSol",
       "realizedUsd", "series", "to", "tradeCount", "trades", "volumeSol", "window"].sort(),
    );
    expect(Object.keys(body.calendar).sort()).toEqual(["days", "month", "sells"].sort());
    // A month the server resolved, never the parameter echoed back.
    expect(body.calendar.month).toMatch(/^\d{4}-\d{2}$/);
    expect(Object.keys(body.kol).sort()).toEqual(
      [
        "avatarUrl",
        "cabalTag",
        "hideWallets",
        "name",
        "slug",
        "xHandle",
        // La tilde de verificado, añadida el 2026-09-05.
        "verified",
      ].sort(),
    );
    expect(Object.keys(body.series[0]).sort()).toEqual(
      ["cumulativeSol", "dailySol", "day"].sort(),
    );
    expect(body.kol.avatarUrl).toBe(`/api/avatar/${kol.id}`);

    // Every column name these three queries touch. A spread of a database row
    // would put each of them in the body verbatim.
    for (const column of ["kol_id", "display_name", "x_handle", "cabal_tag", "hide_wallets",
      "realized_sol", "realized_usd", "volume_sol", "trade_count", "wallet_id", "address",
      "signature_enc", "signature_hmac", "usd_amount", "sol_amount"]) {
      expect(text).not.toContain(column);
    }
  });
});

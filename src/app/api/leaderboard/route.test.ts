import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import { inventAddress } from "@/lib/ids";
import { replayPosition } from "@/lib/pnl";
import type { PublicLeaderboardEntry } from "@/lib/serialize";
import { addWallet } from "@/lib/wallets";
import { GET } from "./route";

/**
 * A Tuesday, 01:00 UTC. Deliberately an instant whose **local** calendar day
 * is the day before in every zone west of UTC−1 — which is the whole of this
 * product's audience, and the machine this suite usually runs on. A window
 * computed from local time picks 08-24 here where a UTC one picks 08-25, so
 * the boundary cases below can tell them apart.
 */
const NOW = "2026-08-25T01:00:00Z";

type Kol = {
  id: string;
  slug: string;
  walletId: string;
  address: string;
};

async function insertKol(options: {
  slug: string;
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
    `INSERT INTO kol (id, slug, display_name, x_handle, cabal_id, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [id, options.slug, options.slug.toUpperCase(), options.slug, cabalId,
     options.status ?? "approved"],
  );
  const address = inventAddress();
  const walletId = await addWallet(id, address);
  return { id, slug: options.slug, walletId, address };
}

type DailySpec = {
  kolId: string;
  /** `YYYY-MM-DD`, the UTC calendar day of spec §4.9. */
  day: string;
  /** Strings, always: a float here would defeat the point of `numeric`. */
  sol: string;
  usd: string;
  wins?: number;
  losses?: number;
};

/**
 * Writes `pnl_daily` directly.
 *
 * That is the table spec §3 makes the leaderboard's source, and `pnl.ts` has
 * its own suite for producing it. Driving these cases through a replay instead
 * would make every ordering assertion depend on the cost-basis arithmetic
 * being right, which is a different test's job — except where the *rule* being
 * checked is one the replay owns, and the episode case below does go through
 * `replayPosition` for exactly that reason.
 */
async function insertDaily(specs: DailySpec[]): Promise<void> {
  await query(
    `INSERT INTO pnl_daily (kol_id, day, realized_sol, realized_usd, wins, losses)
     SELECT e.kol_id::uuid, e.day::date, e.sol::numeric, e.usd::numeric, e.wins::int, e.losses::int
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[])
            AS e(kol_id, day, sol, usd, wins, losses)`,
    [
      specs.map((spec) => spec.kolId),
      specs.map((spec) => spec.day),
      specs.map((spec) => spec.sol),
      specs.map((spec) => spec.usd),
      specs.map((spec) => spec.wins ?? 0),
      specs.map((spec) => spec.losses ?? 0),
    ],
  );
}

type TradeSpec = {
  kolId: string;
  walletId: string;
  mint: string;
  side: "buy" | "sell";
  sol: string;
  tokens: string;
  usd: string;
  at: string;
  slot: number;
};

async function insertTrades(specs: TradeSpec[]): Promise<void> {
  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, slot, kol_id,
                        wallet_id, mint, side, token_amount, sol_amount, usd_amount, sol_usd,
                        fee_sol, basis, block_time)
     SELECT e.id::uuid, decode(e.sig, 'hex'), decode(e.sig, 'hex'), 0, e.slot::bigint,
            e.kol_id::uuid, e.wallet_id::uuid, e.mint, e.side, e.tokens::numeric,
            e.sol::numeric, e.usd::numeric, 150, 0, 'known', e.at::timestamptz
       FROM unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
            AS e(id, sig, slot, kol_id, wallet_id, mint, side, tokens, sol, usd, at)`,
    [
      specs.map(() => crypto.randomUUID()),
      specs.map(() => randomBytes(32).toString("hex")),
      specs.map((spec) => spec.slot),
      specs.map((spec) => spec.kolId),
      specs.map((spec) => spec.walletId),
      specs.map((spec) => spec.mint),
      specs.map((spec) => spec.side),
      specs.map((spec) => spec.tokens),
      specs.map((spec) => spec.sol),
      specs.map((spec) => spec.usd),
      specs.map((spec) => spec.at),
    ],
  );
}

function request(search = ""): Request {
  return new Request(`http://localhost/api/leaderboard${search}`);
}

type Body = {
  window: string;
  unit: string;
  from: string;
  to: string;
  entries: PublicLeaderboardEntry[];
};

async function board(response: Response): Promise<Body> {
  return (await response.json()) as Body;
}

async function entries(search = ""): Promise<PublicLeaderboardEntry[]> {
  return (await board(await GET(request(search)))).entries;
}

/** The ranking, as `slug` in rank order — what every ordering case asserts. */
async function ranking(search = ""): Promise<string[]> {
  return (await entries(search)).map((entry) => entry.kol.slug);
}

beforeEach(async () => {
  await query(
    "TRUNCATE kol, kol_wallet, cabal, token, trade, position, pnl_daily, pnl_position_daily CASCADE",
  );
  // Only `Date` is faked. Faking timers wholesale would replace the
  // `setTimeout` the Postgres driver runs on and hang the suite.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/leaderboard", () => {
  // `pnl_daily` is keyed `(kol_id, day)`, so one row per day is all there can
  // be; what the window has to sum is a *span* of days, and the three windows
  // have to cut that span in three different places.
  it("sums pnl_daily inside the window and leaves out the days outside it", async () => {
    const kol = await insertKol({ slug: "uno" });
    await insertDaily([
      { kolId: kol.id, day: "2026-08-25", sol: "3.5", usd: "500" },
      // Monday: inside the day's ISO week and month, outside the day.
      { kolId: kol.id, day: "2026-08-24", sol: "1.25", usd: "180" },
      // The Thursday before: inside the month, outside the week.
      { kolId: kol.id, day: "2026-08-20", sol: "10", usd: "1400" },
      // Last month: outside all three.
      { kolId: kol.id, day: "2026-07-31", sol: "999", usd: "999999" },
    ]);

    const [daily] = await entries("?window=diario");
    expect(daily.realizedSol).toBe("3.5");
    expect(daily.realizedUsd).toBe("500");

    const [weekly] = await entries("?window=semanal");
    expect(weekly.realizedSol).toBe("4.75");
    expect(weekly.realizedUsd).toBe("680");

    const [monthly] = await entries("?window=mensual");
    expect(monthly.realizedSol).toBe("14.75");
    expect(monthly.realizedUsd).toBe("2080");
  });

  it("reports the window it actually summed", async () => {
    const daily = await board(await GET(request("?window=diario")));
    expect([daily.from, daily.to]).toEqual([
      "2026-08-25T00:00:00.000Z",
      "2026-08-26T00:00:00.000Z",
    ]);
    const weekly = await board(await GET(request("?window=semanal")));
    expect([weekly.from, weekly.to]).toEqual([
      "2026-08-24T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
    ]);
  });

  /**
   * The boundary a local-time window gets wrong.
   *
   * At 01:00 UTC on the 25th the local calendar day is still the 24th
   * everywhere west of UTC−1. A window built from local fields therefore spans
   * 08-24 and would rank the KOL who traded *yesterday*; the UTC window spans
   * 08-25 and ranks the one who traded today.
   *
   * `windows.test.ts` proves the same property in a way that does not depend
   * on the machine's zone at all — this one is the end-to-end half, and it
   * fails on any runner west of UTC−1.
   */
  it("takes the day from the UTC calendar, not the local one", async () => {
    const hoy = await insertKol({ slug: "hoy" });
    const ayer = await insertKol({ slug: "ayer" });
    await insertDaily([
      { kolId: hoy.id, day: "2026-08-25", sol: "1", usd: "100" },
      { kolId: ayer.id, day: "2026-08-24", sol: "50", usd: "9000" },
    ]);

    const daily = await entries("?window=diario");
    const bySlug = Object.fromEntries(daily.map((entry) => [entry.kol.slug, entry]));
    expect(bySlug.hoy.realizedSol).toBe("1");
    expect(bySlug.ayer.realizedSol).toBe("0");
  });

  it("orders by realized PnL, descending", async () => {
    const bajo = await insertKol({ slug: "bajo" });
    const alto = await insertKol({ slug: "alto" });
    const medio = await insertKol({ slug: "medio" });
    await insertDaily([
      { kolId: bajo.id, day: "2026-08-25", sol: "-4", usd: "-700" },
      { kolId: alto.id, day: "2026-08-25", sol: "18.42", usd: "3100" },
      { kolId: medio.id, day: "2026-08-25", sol: "2", usd: "350" },
    ]);

    expect(await ranking("?window=diario&unit=sol")).toEqual(["alto", "medio", "bajo"]);
    expect((await entries("?window=diario&unit=sol")).map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  /**
   * Spec §4.1: the SOL and USD rankings *will* differ, and that is correct.
   *
   * These three are built so the two orders are exact reversals of each other:
   * a route that ranked by `realized_sol` whatever the caller asked for
   * returns the SOL order twice and fails on the USD half, and a route that
   * ranked by `realized_usd` always fails on the SOL half.
   */
  it("orders independently by the selected unit", async () => {
    const a = await insertKol({ slug: "a" });
    const b = await insertKol({ slug: "b" });
    const c = await insertKol({ slug: "c" });
    await insertDaily([
      { kolId: a.id, day: "2026-08-25", sol: "10", usd: "100" },
      { kolId: b.id, day: "2026-08-25", sol: "5", usd: "500" },
      { kolId: c.id, day: "2026-08-25", sol: "1", usd: "900" },
    ]);

    expect(await ranking("?window=diario&unit=sol")).toEqual(["a", "b", "c"]);
    expect(await ranking("?window=diario&unit=usd")).toEqual(["c", "b", "a"]);
  });

  it("breaks a tie on slug so the order does not move between two loads", async () => {
    const zeta = await insertKol({ slug: "zeta" });
    const alfa = await insertKol({ slug: "alfa" });
    await insertDaily([
      { kolId: zeta.id, day: "2026-08-25", sol: "7", usd: "1000" },
      { kolId: alfa.id, day: "2026-08-25", sol: "7", usd: "1000" },
    ]);
    expect(await ranking("?window=diario")).toEqual(["alfa", "zeta"]);
  });

  it("states the win rate as closed wins over closed positions", async () => {
    const kol = await insertKol({ slug: "uno" });
    await insertDaily([
      { kolId: kol.id, day: "2026-08-25", sol: "3", usd: "500", wins: 8, losses: 4 },
      { kolId: kol.id, day: "2026-08-24", sol: "1", usd: "100", wins: 4, losses: 1 },
    ]);
    // The weekly window, so the counts have to be summed across two days.
    const [entry] = await entries("?window=semanal");
    expect([entry.wins, entry.losses]).toEqual([12, 5]);
    expect(entry.winRate).toBe("70.6"); // 12 / 17
  });

  /**
   * A percentage over an empty denominator is not zero — it is undefined, and
   * `0 %` is the shape of a real result: it reads exactly like a KOL who
   * closed nine positions and lost all nine. This is the same failure spec
   * §4.6 forbids for an unpriceable bag rendered as −100 %. The route carries
   * `null` and the screen says `sin cierres`.
   */
  it("has no win rate at all when nothing closed, rather than 0", async () => {
    const kol = await insertKol({ slug: "uno" });
    await insertDaily([{ kolId: kol.id, day: "2026-08-25", sol: "2", usd: "300" }]);
    const [entry] = await entries("?window=diario");
    expect([entry.wins, entry.losses]).toEqual([0, 0]);
    expect(entry.winRate).toBeNull();
  });

  // The distinction the null exists to preserve: nothing closed, versus
  // everything closed badly. Both have `wins = 0`.
  it("distinguishes nothing closed from every closure lost", async () => {
    const quieto = await insertKol({ slug: "quieto" });
    const perdedor = await insertKol({ slug: "perdedor" });
    await insertDaily([
      { kolId: quieto.id, day: "2026-08-25", sol: "0", usd: "0" },
      { kolId: perdedor.id, day: "2026-08-25", sol: "-5", usd: "-800", wins: 0, losses: 9 },
    ]);
    const bySlug = Object.fromEntries(
      (await entries("?window=diario")).map((entry) => [entry.kol.slug, entry]),
    );
    expect(bySlug.quieto.winRate).toBeNull();
    expect(bySlug.perdedor.winRate).toBe("0.0");
  });

  it("reads 100 when every closed position won", async () => {
    const kol = await insertKol({ slug: "uno" });
    await insertDaily([
      { kolId: kol.id, day: "2026-08-25", sol: "2", usd: "300", wins: 3, losses: 0 },
    ]);
    expect((await entries("?window=diario"))[0].winRate).toBe("100.0");
  });

  /**
   * Spec §4.8 as corrected: a closure is won or lost on **that episode's**
   * realized PnL, never on the position's cumulative total.
   *
   * This case is driven through `replayPosition` rather than through
   * `pnl_daily` directly, because the rule belongs to the replay and the
   * leaderboard is where the wrong answer would be published. The position
   * wins its first round trip by +2 SOL and loses its second by −0.5; the
   * cumulative figure is +1.5 and positive throughout, so counting from it
   * writes two wins and a 100 % rate onto a KOL whose second round trip lost
   * money.
   */
  it("counts the second closure on that episode's result, not the running total", async () => {
    const kol = await insertKol({ slug: "uno" });
    const mint = inventAddress();
    await insertTrades([
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "1", tokens: "100",
        usd: "150", at: "2026-08-25T01:00:00Z", slot: 1 },
      { kolId: kol.id, walletId: kol.walletId, mint, side: "sell", sol: "3", tokens: "100",
        usd: "450", at: "2026-08-25T02:00:00Z", slot: 2 },
      { kolId: kol.id, walletId: kol.walletId, mint, side: "buy", sol: "2", tokens: "100",
        usd: "300", at: "2026-08-25T03:00:00Z", slot: 3 },
      { kolId: kol.id, walletId: kol.walletId, mint, side: "sell", sol: "1.5", tokens: "100",
        usd: "225", at: "2026-08-25T04:00:00Z", slot: 4 },
    ]);
    await replayPosition(kol.id, mint);

    const [entry] = await entries("?window=diario");
    expect([entry.wins, entry.losses]).toEqual([1, 1]);
    expect(entry.winRate).toBe("50.0");
    expect(entry.realizedSol).toBe("1.5");
  });

  it("leaves out a suspended KOL even with rows inside the window", async () => {
    const bueno = await insertKol({ slug: "bueno" });
    const suspendido = await insertKol({ slug: "suspendido", status: "suspended" });
    await insertDaily([
      { kolId: bueno.id, day: "2026-08-25", sol: "1", usd: "100" },
      // A bigger number, so a route that forgot the filter puts it at rank 1
      // and the ordering assertion below fails as loudly as the count does.
      { kolId: suspendido.id, day: "2026-08-25", sol: "500", usd: "90000", wins: 9 },
    ]);

    expect(await ranking("?window=diario")).toEqual(["bueno"]);
    expect(await ranking("?window=diario&unit=usd")).toEqual(["bueno"]);
  });

  it("leaves out a KOL still awaiting approval, and a rejected one", async () => {
    const pendiente = await insertKol({ slug: "pendiente", status: "pending" });
    const rechazado = await insertKol({ slug: "rechazado", status: "rejected" });
    await insertDaily([
      { kolId: pendiente.id, day: "2026-08-25", sol: "10", usd: "1000" },
      { kolId: rechazado.id, day: "2026-08-25", sol: "10", usd: "1000" },
    ]);
    expect(await ranking("?window=diario")).toEqual([]);
  });

  // Spec §2: the roster is part of the point. An inner join would drop a
  // curated KOL from the ranking on every day they did not close a position.
  it("keeps an approved KOL with no rows in the window, at zero", async () => {
    const activo = await insertKol({ slug: "activo" });
    // Approved, curated, and with nothing at all in `pnl_daily`.
    await insertKol({ slug: "quieto" });
    await insertDaily([{ kolId: activo.id, day: "2026-08-25", sol: "1", usd: "100" }]);

    const daily = await entries("?window=diario");
    expect(daily.map((entry) => entry.kol.slug)).toEqual(["activo", "quieto"]);
    expect(daily[1].realizedSol).toBe("0");
    expect(daily[1].realizedUsd).toBe("0");
    expect(daily[1].winRate).toBeNull();
  });

  it("joins the cabal tag and keys the avatar by kol id", async () => {
    const kol = await insertKol({ slug: "uno", cabalTag: "EJE" });
    await insertDaily([{ kolId: kol.id, day: "2026-08-25", sol: "1", usd: "100" }]);
    const [entry] = await entries("?window=diario");
    expect(entry.kol.cabalTag).toBe("EJE");
    expect(entry.kol.name).toBe("UNO");
    expect(entry.kol.xHandle).toBe("uno");
    expect(entry.kol.avatarUrl).toBe(`/api/avatar/${kol.id}`);
  });

  it("defaults to the daily window in SOL", async () => {
    const body = await board(await GET(request()));
    expect([body.window, body.unit]).toEqual(["diario", "sol"]);
    expect(body.from).toBe("2026-08-25T00:00:00.000Z");
  });

  it("rejects a window or a unit it does not know, without echoing it back", async () => {
    for (const search of ["?window=daily", "?window=anual", "?unit=eur", "?unit=SOL",
      "?window=diario&unit=", "?window="]) {
      const response = await GET(request(search));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("bad request");
    }
  });

  /**
   * Spec §7: no address and no signature ever leaves the server, and the
   * leaderboard has neither on its row — so the thing worth pinning is the
   * *shape*, which is what stops a query that starts selecting more, or a
   * serializer that starts spreading its input, from shipping `hide_wallets`
   * and a wallet id to a browser.
   */
  it("forwards exactly the public shape", async () => {
    const kol = await insertKol({ slug: "uno", cabalTag: "EJE" });
    await insertDaily([
      { kolId: kol.id, day: "2026-08-25", sol: "1", usd: "100", wins: 1, losses: 1 },
    ]);

    const response = await GET(request("?window=diario"));
    const text = await response.clone().text();
    const [entry] = (await board(response)).entries;

    expect(Object.keys(entry).sort()).toEqual(
      ["kol", "losses", "rank", "realizedSol", "realizedUsd", "winRate", "wins"].sort(),
    );
    expect(Object.keys(entry.kol).sort()).toEqual(
      ["avatarUrl", "cabalTag", "name", "slug", "xHandle"].sort(),
    );
    for (const column of ["kol_id", "display_name", "cabal_tag", "realized_sol", "realized_usd",
      "hide_wallets", "wallet_id", "address", "x_handle"]) {
      expect(text).not.toContain(column);
    }
    expect(text).not.toContain(kol.address);
  });
});

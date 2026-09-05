import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import { inventAddress } from "@/lib/ids";
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
/**
 * **23:00 on the Tuesday, not 01:00**, since the windows became rolling on
 * 2026-09-03. Every fixture here is written as a calendar day — daily rows
 * dated the 25th, trades at 01:00 to 04:00 on the 25th — and a rolling window
 * ends **now**, so at 01:00 all of them were in the future and every window
 * came back empty. The same move `/api/kol/<slug>`'s tests needed, for the
 * same reason.
 */
const NOW = "2026-08-25T23:00:00Z";

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
/**
 * A day's realized PnL — **both halves**, since 2026-09-03.
 *
 * The ranking sums `trade.realized_sol` now, not `pnl_daily`: every window is
 * rolling and a day bucket cannot be cut at an arbitrary hour
 * (`migrations/015`). `pnl_daily` is still written because that is the state a
 * real replay leaves — the same arithmetic feeds both — and because the record
 * columns in these specs live there.
 *
 * The sell lands at **00:30 UTC** of the day, inside a window that ends at the
 * frozen `NOW` of 23:00 rather than balanced on its edge.
 */
async function insertDaily(specs: DailySpec[]): Promise<void> {
  for (const spec of specs) {
    const [wallet] = await query<{ id: string }>(
      "SELECT id FROM kol_wallet WHERE kol_id = $1 ORDER BY id LIMIT 1",
      [spec.kolId],
    );
    if (wallet === undefined) continue;
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, slot, kol_id,
                          wallet_id, mint, side, token_amount, sol_amount, usd_amount, sol_usd,
                          fee_sol, basis, block_time, realized_sol, realized_usd)
       VALUES ($1::uuid, decode($2, 'hex'), decode($2, 'hex'), 0, 1, $3::uuid, $4::uuid,
               $5, 'sell', 1, $6::numeric, $7::numeric, 150, 0, 'known',
               ($8 || 'T00:30:00Z')::timestamptz, $6::numeric, $7::numeric)`,
      [
        id,
        randomBytes(32).toString("hex"),
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
      specs.map((spec) => spec.kolId),
      specs.map((spec) => spec.day),
      specs.map((spec) => spec.sol),
      specs.map((spec) => spec.usd),
      specs.map((spec) => spec.wins ?? 0),
      specs.map((spec) => spec.losses ?? 0),
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
    "TRUNCATE kol, kol_wallet, cabal, token, trade, position, pnl_daily, pnl_position_daily, rate_limit CASCADE",
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
      // Five days back: inside 7D and 30D, outside 1D.
      { kolId: kol.id, day: "2026-08-20", sol: "10", usd: "1400" },
      // Outside thirty days from the 25th, so outside all three.
      { kolId: kol.id, day: "2026-07-20", sol: "999", usd: "999999" },
    ]);

    /*
      `NOW` is 23:00 on the 25th, so the three windows reach back to the 24th at
      23:00, the 18th at 23:00 and July 26th at 23:00.

      **`7D` takes the 20th and its calendar ancestor did not.** `Semanal` was
      the ISO week from Monday the 24th, so it summed 4.75; the rolling week
      reaches five days further back on a Tuesday and comes to 14.75. That
      difference is the change, arriving as a number.
    */
    const daily = (await entries("?window=1d"))[0];
    expect(daily.realizedSol).toBe("3.5");
    expect(daily.realizedUsd).toBe("500");

    const weekly = (await entries("?window=7d"))[0];
    expect(weekly.realizedSol).toBe("14.75");
    expect(weekly.realizedUsd).toBe("2080");

    const monthly = (await entries("?window=30d"))[0];
    expect(monthly.realizedSol).toBe("14.75");
    expect(monthly.realizedUsd).toBe("2080");
  });

  it("reports the window it actually summed", async () => {
    // **Instants, not midnights**, since 2026-09-03: a rolling window ends at
    // `NOW` and starts exactly N days earlier. Reporting a rounded bound would
    // be the one lie that makes `1D` indistinguishable from the `Diario` it
    // replaced.
    const daily = await board(await GET(request("?window=1d")));
    expect([daily.from, daily.to]).toEqual([
      "2026-08-24T23:00:00.000Z",
      "2026-08-25T23:00:00.000Z",
    ]);
    const weekly = await board(await GET(request("?window=7d")));
    expect([weekly.from, weekly.to]).toEqual([
      "2026-08-18T23:00:00.000Z",
      "2026-08-25T23:00:00.000Z",
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

    const daily = await entries("?window=1d");
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

    expect(await ranking("?window=1d")).toEqual(["alto", "medio", "bajo"]);
    expect((await entries("?window=1d")).map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  /**
   * **The ranking is by SOL, whatever `?unit` says** — and this case is the one
   * that used to assert the opposite.
   *
   * Until 2026-09-02 the toggle chose the ranked figure, and this test proved
   * the two orders were computed independently: the three rows below are built
   * so the SOL order and the USD order are exact reversals of each other. The
   * owner's clone decision made the toggle choose the *currency in
   * parentheses* instead (`docs/clone-map.md` §2), so the same three rows now
   * pin the opposite property — the order does not move when the parameter
   * does — and they are kept as reversals precisely so a route that quietly
   * went back to ordering by USD fails here.
   *
   * The loss is real and is recorded in `leaderboard.ts`: there is no longer a
   * way to rank by USD.
   */
  /**
   * **Ordena por USD cotizado, y el toggle no lo cambia** — decisión del dueño
   * del 2026-09-05.
   *
   * Ordenaba por `realized_sol` hasta entonces, y este caso está construido
   * justo para distinguir los dos: con 10 SOL/100 USD, 5/500 y 1/900, el orden
   * nativo es `a,b,c` y el de dólares es `c,b,a`. La reversión, escrita: si
   * alguna vez se vuelve a ordenar por el monto nativo, este caso vuelve a
   * `a,b,c` — y `DECISIONES.md` explica por qué no debería, que es que sumar SOL
   * con ETH no da una cantidad de nada.
   *
   * Lo que **no** cambió, y es lo que este caso siempre midió: la moneda que
   * elige el lector no reordena el tablero. Sólo cambia el número entre
   * paréntesis.
   */
  it("orders by quoted USD whichever currency the caller asks for", async () => {
    const a = await insertKol({ slug: "a" });
    const b = await insertKol({ slug: "b" });
    const c = await insertKol({ slug: "c" });
    await insertDaily([
      { kolId: a.id, day: "2026-08-25", sol: "10", usd: "100" },
      { kolId: b.id, day: "2026-08-25", sol: "5", usd: "500" },
      { kolId: c.id, day: "2026-08-25", sol: "1", usd: "900" },
    ]);

    expect(await ranking("?window=1d&unit=usd")).toEqual(["c", "b", "a"]);
    expect(await ranking("?window=1d&unit=ars")).toEqual(["c", "b", "a"]);
    expect(await ranking("?window=1d")).toEqual(["c", "b", "a"]);
  });

  it("breaks a tie on slug so the order does not move between two loads", async () => {
    const zeta = await insertKol({ slug: "zeta" });
    const alfa = await insertKol({ slug: "alfa" });
    await insertDaily([
      { kolId: zeta.id, day: "2026-08-25", sol: "7", usd: "1000" },
      { kolId: alfa.id, day: "2026-08-25", sol: "7", usd: "1000" },
    ]);
    expect(await ranking("?window=1d")).toEqual(["alfa", "zeta"]);
  });

  /**
   * **The record is inert on the rolling path, and this is what replaced four
   * cases that pinned its arithmetic.**
   *
   * `wins`, `losses` and `winRate` come from `pnl_daily`, which counts a closed
   * *position* per UTC day (spec §4.8). There is no per-sell equivalent —
   * "closed" is a property of a position's whole episode, not of one sell — so
   * a ranking that sums `trade.realized_sol` over an arbitrary interval cannot
   * produce them. Since 2026-09-03 every window is rolling, so they are always
   * `0`, `0` and `null`.
   *
   * The four cases deleted here asserted the ratio, the 100 % case, the
   * nothing-closed case and the per-episode counting that a running total gets
   * wrong. Every one was a real defect the day it was written, and none of them
   * can occur any more because the code path is gone — not because the bug was
   * fixed. Their absence is stated here so nobody re-derives the counts from
   * sells and calls the result a win rate: that would be a different
   * measurement wearing this name, which is the exact substitution
   * `docs/round-ventanas-moviles.md` exists to prevent.
   *
   * **The fields are not removed.** They are a published response and dropping
   * them breaks whoever holds this URL — the same call the owner made for
   * `series` on `/api/kol/<slug>`.
   */
  it("reports no record at all, because a rolling window cannot count closed positions", async () => {
    const kol = await insertKol({ slug: "uno" });
    await insertDaily([
      { kolId: kol.id, day: "2026-08-25", sol: "3", usd: "500", wins: 8, losses: 4 },
      { kolId: kol.id, day: "2026-08-24", sol: "1", usd: "100", wins: 4, losses: 1 },
    ]);

    const [entry] = await entries("?window=7d");
    // The daily rows carry a record; the ranking does not read them.
    expect([entry.wins, entry.losses]).toEqual([0, 0]);
    expect(entry.winRate).toBeNull();
    // And the figure it *does* read is the realized sum, which is the point.
    expect(entry.realizedSol).toBe("4");
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

    expect(await ranking("?window=1d")).toEqual(["bueno"]);
    expect(await ranking("?window=1d&unit=usd")).toEqual(["bueno"]);
  });

  it("leaves out a KOL still awaiting approval, and a rejected one", async () => {
    const pendiente = await insertKol({ slug: "pendiente", status: "pending" });
    const rechazado = await insertKol({ slug: "rechazado", status: "rejected" });
    await insertDaily([
      { kolId: pendiente.id, day: "2026-08-25", sol: "10", usd: "1000" },
      { kolId: rechazado.id, day: "2026-08-25", sol: "10", usd: "1000" },
    ]);
    expect(await ranking("?window=1d")).toEqual([]);
  });

  // Spec §2: the roster is part of the point. An inner join would drop a
  // curated KOL from the ranking on every day they did not close a position.
  it("keeps an approved KOL with no rows in the window, at zero", async () => {
    const activo = await insertKol({ slug: "activo" });
    // Approved, curated, and with nothing at all in `pnl_daily`.
    await insertKol({ slug: "quieto" });
    await insertDaily([{ kolId: activo.id, day: "2026-08-25", sol: "1", usd: "100" }]);

    const daily = await entries("?window=1d");
    expect(daily.map((entry) => entry.kol.slug)).toEqual(["activo", "quieto"]);
    expect(daily[1].realizedSol).toBe("0");
    expect(daily[1].realizedUsd).toBe("0");
    expect(daily[1].winRate).toBeNull();
  });

  it("joins the cabal tag and keys the avatar by kol id", async () => {
    const kol = await insertKol({ slug: "uno", cabalTag: "EJE" });
    await insertDaily([{ kolId: kol.id, day: "2026-08-25", sol: "1", usd: "100" }]);
    const [entry] = await entries("?window=1d");
    expect(entry.kol.cabalTag).toBe("EJE");
    expect(entry.kol.name).toBe("UNO");
    expect(entry.kol.xHandle).toBe("uno");
    expect(entry.kol.avatarUrl).toBe(`/api/avatar/${kol.id}`);
  });

  it("defaults to the shortest window", async () => {
    const body = await board(await GET(request()));
    expect(body.window).toBe("1d");
    // Twenty-four hours before `NOW`, not the start of its UTC day.
    expect(body.from).toBe("2026-08-24T23:00:00.000Z");
    // The currency is not in the payload and never was a property of it: this
    // endpoint publishes `realizedSol` and `realizedUsd` both, and the peso is
    // a conversion a page applies with a rate it also prints.
    expect(body).not.toHaveProperty("unit");
  });

  it("rejects a window or a unit it does not know, without echoing it back", async () => {
    for (const search of ["?window=daily", "?window=anual", "?unit=eur", "?unit=USD",
      "?unit=sol", "?window=1d&unit=", "?window="]) {
      const response = await GET(request(search));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("bad request");
    }
  });

  /**
   * Spec §7: no address and no signature ever leaves the server, and the
   * leaderboard has neither on its row — so the thing worth pinning is the
   * *shape*, which is what stops a query that starts selecting more, or a
   * serializer that starts spreading its input, from shipping a wallet id to a
   * browser.
   *
   * **`hideWallets` is on the public shape on purpose**, and was added to it
   * when the leaderboard row grew a two-line identity: DESIGN.md
   * `row-leaderboard` puts, beneath the name, the *"**`@handle`, always**,
   * linked to X, with `Wallets ocultas` in `hidden` **beside it** where that
   * KOL's wallets are hidden"*, and nothing else on the row can decide whether
   * that marker belongs there — `kol.x_handle` is `NOT NULL`, so its presence
   * cannot. `PublicTrade.kol` has carried the same field for the same label
   * since the feed row was built. It is a fact about what we publish, not a
   * wallet: spec §7's promise is about the address and the signature, and both
   * are still asserted absent below by their column names.
   */
  it("forwards exactly the public shape", async () => {
    const kol = await insertKol({ slug: "uno", cabalTag: "EJE" });
    await insertDaily([
      { kolId: kol.id, day: "2026-08-25", sol: "1", usd: "100", wins: 1, losses: 1 },
    ]);

    const response = await GET(request("?window=1d"));
    const text = await response.clone().text();
    const [entry] = (await board(response)).entries;

    expect(Object.keys(entry).sort()).toEqual(
      [
        "kol",
        "losses",
        "rank",
        "realizedSol",
        "realizedUsd",
        "winRate",
        "wins",
        // Añadidos el 2026-09-05: el desglose por chain que alimenta las columnas
        // y las wallets que el KOL eligió publicar. Este caso existe para que
        // agregar un campo a una respuesta pública sea una decisión y no un
        // descuido, así que se actualiza a mano y no se afloja.
        "chains",
        "publicWalletList",
      ].sort(),
    );
    expect(Object.keys(entry.kol).sort()).toEqual(
      [
        "avatarUrl",
        "cabalTag",
        "hideWallets",
        "name",
        "slug",
        "xHandle",
        // La tilde de verificado: si el handle se probó por tweet firmado.
        "verified",
      ].sort(),
    );
    for (const column of ["kol_id", "display_name", "cabal_tag", "realized_sol", "realized_usd",
      "hide_wallets", "wallet_id", "address", "x_handle"]) {
      expect(text).not.toContain(column);
    }
    expect(text).not.toContain(kol.address);
  });
});

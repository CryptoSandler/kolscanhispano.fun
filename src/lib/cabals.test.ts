/**
 * `readCabals`, against the database.
 *
 * Every case here is a property of the **query**, because that is where a
 * ranking of groups can be wrong while every figure still looks like a figure:
 * a join that fans out, a filter that runs too late, a count that counts the
 * wrong rows. `docs/clone-map.md` §6 is the surface this feeds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readCabals } from "./cabals";
import { query } from "./db";

/** The same instant `route.test.ts` uses: a Tuesday, 01:00 UTC. */
const NOW = "2026-08-25T01:00:00Z";

async function insertCabal(tag: string, name = tag): Promise<string> {
  const id = crypto.randomUUID();
  await query("INSERT INTO cabal (id, tag, name) VALUES ($1, $2, $3)", [id, tag, name]);
  return id;
}

async function insertKol(slug: string, cabalId: string | null, status = "approved"): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, cabal_id, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [id, slug, slug.toUpperCase(), slug, cabalId, status],
  );
  return id;
}

async function insertDaily(
  kolId: string,
  day: string,
  sol: string,
  usd: string,
  closed = 1,
): Promise<void> {
  await query(
    `INSERT INTO pnl_daily (kol_id, day, realized_sol, realized_usd, wins, losses)
     VALUES ($1, $2::date, $3::numeric, $4::numeric, $5, 0)`,
    [kolId, day, sol, usd, closed],
  );
}

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet, cabal, token, trade, position, pnl_daily, pnl_position_daily CASCADE");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

describe("readCabals", () => {
  it("sums every approved member's window and ranks by SOL", async () => {
    const alfa = await insertCabal("ALF");
    const beta = await insertCabal("BET");
    const one = await insertKol("uno", alfa);
    const two = await insertKol("dos", alfa);
    const three = await insertKol("tres", beta);
    await insertDaily(one, "2026-08-25", "4", "400");
    await insertDaily(two, "2026-08-25", "6", "600");
    await insertDaily(three, "2026-08-25", "9", "900");

    const { entries } = await readCabals({ window: "diario" });

    expect(entries.map((entry) => entry.tag)).toEqual(["ALF", "BET"]);
    expect(entries[0]).toMatchObject({ rank: 1, realizedSol: "10", realizedUsd: "1000", members: 2 });
    expect(entries[1]).toMatchObject({ rank: 2, realizedSol: "9", members: 1 });
  });

  /**
   * The fan-out this query is written to avoid. The `pnl_daily` join multiplies
   * each member by the number of days they traded in the window, so `count(*)`
   * would report this cabal of two as a cabal of five on a monthly window —
   * with a correct PnL beside it, which is what would make it survive review.
   */
  it("counts members, not member-days", async () => {
    const cabal = await insertCabal("MUL");
    const one = await insertKol("uno", cabal);
    const two = await insertKol("dos", cabal);
    for (const day of ["2026-08-03", "2026-08-04", "2026-08-05"]) {
      await insertDaily(one, day, "1", "100");
    }
    for (const day of ["2026-08-06", "2026-08-07"]) {
      await insertDaily(two, day, "1", "100");
    }

    const { entries } = await readCabals({ window: "mensual" });

    expect(entries[0].members).toBe(2);
    expect(entries[0].realizedSol).toBe("5");
  });

  /**
   * Spec §9, in the query rather than after it: a suspended KOL must not be
   * able to contribute their PnL to a cabal's total on the way to being
   * filtered out — and must not be counted as a member either.
   */
  it("leaves a suspended, rejected or pending member out of both the sum and the count", async () => {
    const cabal = await insertCabal("FIL");
    const good = await insertKol("bueno", cabal);
    await insertDaily(good, "2026-08-25", "2", "200");
    for (const [slug, status] of [["susp", "suspended"], ["rech", "rejected"], ["pend", "pending"]]) {
      const other = await insertKol(slug, cabal, status);
      await insertDaily(other, "2026-08-25", "100", "10000");
    }

    const { entries } = await readCabals({ window: "diario" });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ members: 1, realizedSol: "2" });
  });

  /**
   * The `INNER JOIN` the module's docstring argues for, from both sides. A
   * cabal is a group *of* roster entries: one whose every member was suspended
   * is not a competitor with nothing to show, it is not in the competition —
   * while a cabal whose approved members simply did not trade still appears, at
   * zero, which is spec §2's roster argument one level up.
   */
  it("drops a cabal with no approved member, and keeps one that only stayed quiet", async () => {
    const empty = await insertCabal("VAC");
    await insertKol("fuera", empty, "suspended");
    const quiet = await insertCabal("QUI");
    await insertKol("quieto", quiet);
    const active = await insertCabal("ACT");
    const trader = await insertKol("activo", active);
    await insertDaily(trader, "2026-08-25", "1", "100");

    const { entries } = await readCabals({ window: "diario" });

    expect(entries.map((entry) => entry.tag)).toEqual(["ACT", "QUI"]);
    expect(entries[1]).toMatchObject({ realizedSol: "0", closed: 0, members: 1 });
  });

  it("sums only the days inside the window", async () => {
    const cabal = await insertCabal("VEN");
    const kol = await insertKol("uno", cabal);
    await insertDaily(kol, "2026-08-25", "1", "100");
    await insertDaily(kol, "2026-08-24", "50", "5000");

    expect((await readCabals({ window: "diario" })).entries[0].realizedSol).toBe("1");
    expect((await readCabals({ window: "mensual" })).entries[0].realizedSol).toBe("51");
  });

  it("breaks a tie by tag, so equal totals do not reshuffle between loads", async () => {
    for (const tag of ["ZZZ", "AAA", "MMM"]) {
      const cabal = await insertCabal(tag);
      const kol = await insertKol(`kol-${tag}`, cabal);
      await insertDaily(kol, "2026-08-25", "1", "100");
    }

    const first = (await readCabals({ window: "diario" })).entries.map((entry) => entry.tag);
    const second = (await readCabals({ window: "diario" })).entries.map((entry) => entry.tag);

    expect(first).toEqual(["AAA", "MMM", "ZZZ"]);
    expect(second).toEqual(first);
  });

  it("has nothing to rank when there are no cabals at all", async () => {
    expect((await readCabals({ window: "diario" })).entries).toEqual([]);
  });
});

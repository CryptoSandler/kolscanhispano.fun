/**
 * Three parts, proved separately.
 *
 * **The guards must refuse.** A seed that can reach production is a worse bug
 * than an empty preview, so every refusal path is exercised: the variable
 * unset, `DATABASE_URL` unset (which would make the production comparison pass
 * vacuously), the two naming the same database, and the target carrying
 * `test_database_marker`. The seed now calls `recomputeDirty()`, which *writes*
 * to `position`, `pnl_daily` and `pnl_position_daily`, so a guard that stopped
 * firing would corrupt more than it used to, not less.
 *
 * The same-database case is driven with a **fabricated** pair of identical
 * URLs rather than with the real production string. If the comparison ever
 * broke, a test that had handed it the real one would seed production to prove
 * that it seeds production. The fabricated host resolves nowhere, so a broken
 * guard fails to connect instead.
 *
 * **The trades must be the only thing invented.** `writeRoster` writes trades
 * and dirty position marks and nothing derived, so straight after it there is
 * no `pnl_daily` at all and `assertReconciled` refuses. That is what makes the
 * assertion in the third part mean something: it is not a check that passes
 * because it cannot fail.
 *
 * **The derived tables must produce the states the preview exists to show, and
 * must already be what a recompute would produce.** `writeRoster` is split out
 * of `seedPreview` precisely so this half can run: the tests branch carries
 * `test_database_marker`, so `seedPreview` itself refuses it, on purpose.
 * Driving the row-writing through `withTransaction` and then calling the real
 * `recomputeDirty()` from `src/lib/pnl.ts` — the same function the cron calls,
 * against the same engine — is the only way to assert that the roster really
 * *yields* ten ranked rows with both signs, a `sin cierres` row, a `sin precio`
 * trade and a feed longer than the eight rows the list is tall, rather than
 * asserting that a literal in the file says so.
 *
 * **And the fixture must not expire.** Two things were added after a seed taken
 * on 2026-08-27 was found empty on the 28th: the episodes are placed by window
 * rather than by a fixed number of days, and a roster whose newest trade is not
 * on the current UTC day is replaced instead of skipped. The placement is
 * proved over a year of calendars rather than on the day the suite runs — a
 * fixture that is only correct on one date is the defect, so a test that can
 * only see one date cannot catch it.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { query, withTransaction } from "@/lib/db";
import { readFeedPage } from "@/lib/feed";
import { readLeaderboard, LEADERBOARD_TOP } from "@/lib/leaderboard";
import { recomputeDirty } from "@/lib/pnl";
import { LEADERBOARD_WINDOWS, windowBounds } from "@/lib/windows";
import { assertReconciled, placementDays, seedPreview, writeRoster } from "./seed-preview";

/**
 * A syntactically valid connection URL naming a host that does not exist. Used
 * where a guard must fire *before* anything connects; if one ever stops firing,
 * the failure is a DNS error, not a write.
 */
const NOWHERE = "postgresql://u:p@ep-guard-fixture-0000.eu-central-1.aws.neon.tech/neondb";

/** Every table the roster and its replay touch. */
const SEEDED_TABLES =
  "kol, kol_wallet, cabal, token, trade, position, pnl_daily, pnl_position_daily CASCADE";

/** The roster's shape, as the file's own docstring states it. */
const ROSTER_TRADES = 48;
const ROSTER_POSITIONS = 23;

let realPreview: string | undefined;
let realDatabase: string | undefined;

beforeAll(() => {
  realPreview = process.env.PREVIEW_DATABASE_URL;
  realDatabase = process.env.DATABASE_URL;
});

/**
 * Blank, not deleted. `openPreview` calls `loadEnvLocal`, which refills any
 * variable it finds *falsy* from `.env.local` — so `delete` and `""` both come
 * back as the real value and the guard under test would never fire. A string of
 * spaces is truthy to `loadEnvLocal` and empty to the guard's `.trim()`.
 */
const blank = "   ";

afterEach(() => {
  for (const [name, value] of [
    ["PREVIEW_DATABASE_URL", realPreview],
    ["DATABASE_URL", realDatabase],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("seedPreview refuses anything that is not the preview branch", () => {
  it("refuses when PREVIEW_DATABASE_URL is unset, and never falls back to DATABASE_URL", async () => {
    process.env.PREVIEW_DATABASE_URL = blank;
    await expect(seedPreview()).rejects.toThrow(/PREVIEW_DATABASE_URL is not set/);
  });

  it("refuses when DATABASE_URL is unset, so the production comparison cannot pass vacuously", async () => {
    process.env.PREVIEW_DATABASE_URL = NOWHERE;
    process.env.DATABASE_URL = blank;
    await expect(seedPreview()).rejects.toThrow(/DATABASE_URL is not set/);
  });

  it("refuses when the two variables name the same database", async () => {
    process.env.PREVIEW_DATABASE_URL = NOWHERE;
    process.env.DATABASE_URL = NOWHERE;
    await expect(seedPreview()).rejects.toThrow(/name the same database/);
  });

  it("refuses a database carrying test_database_marker, which npm test truncates", async () => {
    // The tests branch is the one database this suite is allowed to name, and
    // it is stamped. Pointed at it, the seed must stop after connecting and
    // before writing anything — and, now that it also replays, before deriving
    // anything either.
    process.env.PREVIEW_DATABASE_URL = process.env.TEST_DATABASE_URL;
    await query(`TRUNCATE ${SEEDED_TABLES}`);

    await expect(seedPreview()).rejects.toThrow(/test_database_marker/);

    const [counts] = await query<{ kols: string; positions: string; days: string }>(
      `SELECT (SELECT count(*) FROM kol)       AS kols,
              (SELECT count(*) FROM position)  AS positions,
              (SELECT count(*) FROM pnl_daily) AS days`,
    );
    expect(counts).toEqual({ kols: "0", positions: "0", days: "0" });
  });

  it("reports a malformed URL against the variable it came from", async () => {
    process.env.PREVIEW_DATABASE_URL = "not-a-url";
    await expect(seedPreview()).rejects.toThrow(/PREVIEW_DATABASE_URL is not a valid/);
  });
});

/**
 * Where the roster lands on the calendar, proved without a database and without
 * depending on the day the suite runs.
 *
 * **This is the half that was wrong.** The roster used to be dated `0`, `4` and
 * `19` days back, which is correct on the day it is written and empty the next
 * morning: spec §4.9's windows are calendar-aligned UTC and never rolling. The
 * fix is `placementDays`, and the only honest way to test it is to hand it
 * dates rather than to run it once on today.
 *
 * The two edges the brief names are the ones a mid-month test would never see:
 * on a **Monday** the ISO week is one day long, and on the **1st** the calendar
 * month is. Both are asserted directly, and a Monday that is also the 1st —
 * where all three windows collapse onto today — is asserted as well.
 */
describe("the roster is placed by window, so it is correct on every calendar", () => {
  /** 09:15 UTC, deliberately not midnight: the day must come from the date, not the hour. */
  const at = (day: string) => Date.parse(`${day}T09:15:00.000Z`);

  it("resolves the three windows against the run instant, on the four days that differ", () => {
    // Wednesday 26 August 2026: the ISO week began on Monday the 24th, the
    // month on Saturday the 1st. The ordinary case, and the only one the old
    // fixed offsets ever got right.
    expect(placementDays(at("2026-08-26"))).toEqual({ today: 0, week: 2, month: 25 });

    // Monday 24 August: the ISO week starts today, so `Semanal` is one day long
    // and its episodes join today's. That is what the window *is* on a Monday.
    expect(placementDays(at("2026-08-24"))).toEqual({ today: 0, week: 0, month: 23 });

    // Saturday 1 August: the month starts today. The ISO week still reaches
    // back into July, which is a real property of ISO weeks rather than a bug —
    // `Semanal` and `Mensual` are not nested at a month boundary, and the
    // fixture is placed by the same `windowBounds` the product filters on.
    expect(placementDays(at("2026-08-01"))).toEqual({ today: 0, week: 5, month: 0 });

    // Monday 1 June: both edges at once, and all three windows collapse onto
    // today. Everything the gate needs is still there, because the daily set is
    // the one that carries it.
    expect(placementDays(at("2026-06-01"))).toEqual({ today: 0, week: 0, month: 0 });
  });

  it("never places an episode outside the window it names, on any day of a year", () => {
    const DAY_MS = 86_400_000;
    // A full year and a bit from a Thursday, so every weekday, every month
    // length, both month-boundary shapes and a leap February are covered.
    for (let step = 0; step < 400; step += 1) {
      const instant = at("2026-01-01") + step * DAY_MS;
      const now = new Date(instant);
      const days = placementDays(instant);
      const label = now.toISOString().slice(0, 10);

      // The day an episode lands on, as a UTC midnight.
      const landsOn = (daysAgo: number) =>
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysAgo * DAY_MS;

      const inside = (daysAgo: number, window: (typeof LEADERBOARD_WINDOWS)[number]) => {
        const { from, to } = windowBounds(window, now);
        const day = landsOn(daysAgo);
        return day >= from.getTime() && day < to.getTime();
      };

      // `today` is in all three, which is what makes "closed positions in every
      // window" a consequence of the roster rather than of the date: the
      // windows nest downwards even where they do not nest upwards.
      expect(days.today, label).toBe(0);
      for (const window of LEADERBOARD_WINDOWS) expect(inside(0, window), `${label} ${window}`).toBe(true);

      // ...and each of the other two is inside the window it is named for.
      expect(inside(days.week, "semanal"), `${label} semanal`).toBe(true);
      expect(inside(days.month, "mensual"), `${label} mensual`).toBe(true);

      // Never in the future, and never further back than the widest window can
      // reach — a placement of 31 would silently fall out of `Mensual`.
      expect(days.week, label).toBeGreaterThanOrEqual(0);
      expect(days.week, label).toBeLessThanOrEqual(6);
      expect(days.month, label).toBeGreaterThanOrEqual(0);
      expect(days.month, label).toBeLessThanOrEqual(30);
    }
  });
});

describe("the trades are the only thing the seed invents", () => {
  beforeAll(async () => {
    await query(`TRUNCATE ${SEEDED_TABLES}`);
    await withTransaction(writeRoster);
  });

  it("writes trades and dirty position marks, and nothing derived", async () => {
    const [counts] = await query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM trade)                       AS trades,
              (SELECT count(*) FROM position)                    AS positions,
              (SELECT count(*) FROM position WHERE dirty)        AS dirty,
              (SELECT count(*) FROM pnl_daily)                   AS days,
              (SELECT count(*) FROM pnl_position_daily)          AS position_days`,
    );

    // Every trade is the pair `parse-swap.ts`'s `insertTrade` writes: the row
    // and the dirty mark that is the only thing that will ever read it.
    expect(counts.trades).toBe(String(ROSTER_TRADES));
    expect(counts.positions).toBe(String(ROSTER_POSITIONS));
    expect(counts.dirty).toBe(String(ROSTER_POSITIONS));

    // Spec §3: pnl_daily is derived. Nothing has derived it yet.
    expect(counts.days).toBe("0");
    expect(counts.position_days).toBe("0");
  });

  it("is not reconciled until the real engine has replayed the trades", async () => {
    // The check the third part relies on, proved to be capable of failing.
    await expect(withTransaction(assertReconciled)).rejects.toThrow(/still dirty/);
  });
});

/**
 * One replay of twenty-three positions is twenty-three transactions against
 * Neon, which is past vitest's 30s default on this connection. Every budget
 * widened in this file is widened for that reason and no other; the seed and
 * the replay themselves are not slow, the round trips are.
 */
const REPLAY_BUDGET_MS = 180_000;

describe("the replayed roster produces the states the preview exists to show", () => {
  beforeAll(async () => {
    await query(`TRUNCATE ${SEEDED_TABLES}`);
    await withTransaction(writeRoster);
    // The real engine, called the way the cron calls it. Everything asserted
    // below is derived by `pnl.ts` from the trades above; nothing in this file
    // or in the seed writes a figure the leaderboard reads.
    expect(await recomputeDirty()).toBe(ROSTER_POSITIONS);
  }, REPLAY_BUDGET_MS);

  /**
   * Pinned to noon of the newest derived day, so no run can straddle UTC
   * midnight. That day is the day the seed ran, so pinning to it also asks the
   * weekly and monthly windows the question the *seed* was placed against
   * rather than the one a slow suite drifts into.
   */
  async function leaderboardAtSeededDay(window: (typeof LEADERBOARD_WINDOWS)[number] = "diario") {
    const [{ day }] = await query<{ day: string }>(
      "SELECT to_char(max(day), 'YYYY-MM-DD') AS day FROM pnl_daily",
    );
    return readLeaderboard({ window, unit: "sol", now: new Date(`${day}T12:00:00.000Z`) });
  }

  it("ranks ten rows spanning gains and losses, with `sin cierres` among them", async () => {
    const { entries } = await leaderboardAtSeededDay();
    expect(entries.length).toBeGreaterThanOrEqual(LEADERBOARD_TOP);

    const topTen = entries.slice(0, LEADERBOARD_TOP);
    expect(topTen.some((entry) => entry.realizedSol.startsWith("-")), "a loss in the top ten").toBe(
      true,
    );
    expect(
      topTen.some((entry) => !entry.realizedSol.startsWith("-") && Number(entry.realizedSol) > 0),
      "a gain in the top ten",
    ).toBe(true);

    // DESIGN.md: `sin cierres` -- never `0 %`, which claims a measurement
    // nobody made. It has to be *in the top ten* to be on the home page, and it
    // is there because `ejemplo_hilofino`'s only trades are buys, so `pnl.ts`
    // derived no closed episode for it at all.
    const noEpisodes = topTen.filter((entry) => entry.winRate === null);
    expect(noEpisodes).toHaveLength(1);
    expect(noEpisodes[0].kol.slug).toBe("preview-hilofino");
    expect(noEpisodes[0].wins + noEpisodes[0].losses).toBe(0);

    // ...and a real, measured zero, which is a different cell entirely:
    // `ejemplo_velacorta` closed three round trips on one mint and lost all
    // three (spec §4.8's reopen-and-close-again path).
    const measuredZero = topTen.filter((entry) => entry.winRate === "0.0");
    expect(measuredZero.map((entry) => entry.kol.slug)).toContain("preview-velacorta");
    expect(measuredZero.find((entry) => entry.kol.slug === "preview-velacorta")).toMatchObject({
      wins: 0,
      losses: 3,
    });
  });

  /**
   * The property the placement rewrite exists for, asserted on the leaderboard
   * the owner actually looks at rather than on the trade table underneath it.
   *
   * `LeaderboardTable`'s panel-level empty state is keyed on **every** entry
   * having `winRate === null`, so a single window with nothing closed in it
   * costs the gate the podium, the tinted rows, the avatars and the modal at
   * once — which is exactly what a day-old fixture did on 2026-08-28. One
   * closed episode per window would clear that bar; the roster is held to more
   * than that, because a panel that is technically non-empty and carries only
   * one sign shows the gate half of DESIGN.md's colour rule.
   */
  it("fills all three windows, with both signs in each and `sin cierres` still visible", async () => {
    for (const window of LEADERBOARD_WINDOWS) {
      const { entries } = await leaderboardAtSeededDay(window);

      // DESIGN.md, "Every surface has two states": this is the condition under
      // which the ranking panel is *not* its own empty state.
      const closed = entries.filter((entry) => entry.winRate !== null);
      expect(closed.length, `${window}: closed episodes`).toBeGreaterThan(0);
      expect(
        entries.every((entry) => entry.winRate === null),
        `${window}: the panel-level empty state is reachable`,
      ).toBe(false);

      // Both `semantic-gain` and `semantic-loss` on the page, in every window.
      expect(
        closed.some((entry) => Number(entry.realizedSol) > 0),
        `${window}: a gain`,
      ).toBe(true);
      expect(
        closed.some((entry) => entry.realizedSol.startsWith("-")),
        `${window}: a loss`,
      ).toBe(true);

      // ...and the row-level empty case survives all three, so `sin cierres` is
      // never the thing that disappears when the calendar moves.
      expect(
        entries.some((entry) => entry.winRate === null),
        `${window}: sin cierres`,
      ).toBe(true);

      // Eleven of the twelve closed something today, and the windows nest
      // downwards, so every window carries almost the whole roster.
      expect(closed.length, `${window}: most of the roster`).toBeGreaterThanOrEqual(11);
    }
  });

  it("derives the day's figures exactly, on the decimal grid and not through a float", async () => {
    const { entries } = await leaderboardAtSeededDay();
    const top = entries[0];

    // `ejemplo_brujularota`'s single day-zero episode: bought for 8.15 SOL,
    // sold for 20.5, two 0.000005 fees charged separately (spec §4.4).
    //   20.499995 - 8.150005 = 12.34999
    // In doubles `20.5 - 8.150005` is 12.349994999999999, so this figure pins
    // the arithmetic rather than merely agreeing with it.
    expect(top.kol.slug).toBe("preview-brujularota");
    expect(top.realizedSol).toBe("12.34999");

    // The same episode in USD, at 231.71 SOL/USD with the fee valued at that
    // same rate: (20.5 - 0.000005) x 231.71 - (8.15 + 0.000005) x 231.71.
    // `8.15 * 231.71` is 1888.4365000000003 in doubles.
    expect(top.realizedUsd).toBe("2861.6161829");
  });

  it("fills the feed past the eight rows the list is tall, with an unpriced trade in it", async () => {
    const { trades } = await readFeedPage();
    // `.feed-list` is `calc(8 * var(--row-height))`, so anything past eight is
    // what makes the panel scroll instead of ending mid-air.
    expect(trades.length).toBeGreaterThan(8);

    // DESIGN.md `state-unpriced`: a block no `sol_price` row covers, so there
    // is no number rather than a zero. It is the newest thing in the feed,
    // because a gap in `sol_price` is always at the newest end.
    expect(trades[0].priceUsd).toBeNull();
    // ...and it is on a token that *does* have a symbol, so `sin precio` and
    // `un token sin símbolo` cannot be conflated by anything reading this.
    expect(trades[0].symbol).not.toBeNull();

    // The feed row's `un token sin símbolo`, which is the token's own state.
    expect(trades.some((trade) => trade.symbol === null)).toBe(true);
    expect(trades.some((trade) => trade.symbol !== null)).toBe(true);
    expect(trades.some((trade) => trade.priceUsd !== null)).toBe(true);

    // Spec §7, both row shapes: a KOL that publishes its wallets keeps its
    // Solscan link, one that hides them gets the `Wallets ocultas` chip.
    expect(trades.some((trade) => trade.kol.hideWallets)).toBe(true);
    expect(trades.some((trade) => trade.signature !== null)).toBe(true);
    for (const trade of trades) {
      if (trade.kol.hideWallets) expect(trade.signature).toBeNull();
    }

    // Some rows carry a cabal tag and some do not, so the row reads correctly
    // either way.
    expect(trades.some((trade) => trade.kol.cabalTag !== null)).toBe(true);
    expect(trades.some((trade) => trade.kol.cabalTag === null)).toBe(true);

    // Both sides of every episode are in the log, and the buy is older than the
    // sell it opens -- spec §4.10's replay order depends on it.
    expect(trades.some((trade) => trade.side === "buy")).toBe(true);
    expect(trades.some((trade) => trade.side === "sell")).toBe(true);
  });

  /**
   * Idempotence, on the state the seed actually leaves behind rather than on a
   * fresh one: this is the second `npm run db:seed:preview` against a branch
   * that already carries the roster. `seedPreview` skips the replay entirely
   * when `writeRoster` reports it wrote nothing, so the derived rows are the
   * first run's and must be untouched.
   */
  it("is idempotent: a second run writes nothing and leaves the same rows", async () => {
    const countsOf = async () =>
      query<Record<string, string>>(
        `SELECT (SELECT count(*) FROM kol)                AS kols,
                (SELECT count(*) FROM kol_wallet)         AS wallets,
                (SELECT count(*) FROM token)              AS tokens,
                (SELECT count(*) FROM trade)              AS trades,
                (SELECT count(*) FROM position)           AS positions,
                (SELECT count(*) FROM pnl_daily)          AS days,
                (SELECT count(*) FROM pnl_position_daily) AS position_days`,
      );
    const before = await countsOf();
    expect(before[0].trades).toBe(String(ROSTER_TRADES));
    expect(before[0].positions).toBe(String(ROSTER_POSITIONS));

    const second = await withTransaction(writeRoster);
    // Not stale — the roster it finds was written by the `beforeAll` above, so
    // its newest trade is on the current UTC day and the replacement branch
    // must not fire.
    expect(second).toMatchObject({ seeded: false, replaced: false });
    expect(second.counts.trades).toBe(0);
    expect(await countsOf()).toEqual(before);
  });

  /**
   * The verdict this whole rewrite rests on. A seed whose leaderboard does not
   * reconcile with its own trades teaches an impossible state, and the first
   * person to run `recompute-dirty` against preview reads "the product is
   * broken" where the broken thing was the fixture.
   *
   * Last in the file on purpose: it re-dirties every position and replays them,
   * which is the most expensive thing here and leaves the same rows behind.
   */
  it(
    "leaves the database where a recompute would: a second replay changes nothing",
    async () => {
      await withTransaction(assertReconciled);

      // Nothing is dirty, so the cron finds no work at all.
      expect(await recomputeDirty()).toBe(0);

      const derived = async () => ({
        positions: await query(
          `SELECT kol_id, mint, qty, cost_sol, avg_cost_sol, realized_sol, realized_usd,
                  first_buy_at, last_trade_at, basis, dirty
             FROM position ORDER BY kol_id, mint`,
        ),
        positionDays: await query(
          `SELECT kol_id, mint, to_char(day, 'YYYY-MM-DD') AS day, realized_sol, realized_usd,
                  wins, losses
             FROM pnl_position_daily ORDER BY kol_id, mint, day`,
        ),
        days: await query(
          `SELECT kol_id, to_char(day, 'YYYY-MM-DD') AS day, realized_sol, realized_usd,
                  wins, losses
             FROM pnl_daily ORDER BY kol_id, day`,
        ),
      });

      // ...and if it did find work, it would write back exactly what is there.
      // `formatDecimal` is canonical, so these compare byte for byte -- over
      // *every* derived row, not just the replayed ones, because `refreshDaily`
      // re-aggregates a KOL's whole day from its positions.
      //
      // ponytail: three KOLs re-dirtied rather than all twelve. `replayPosition`
      // is scoped to one `(kol_id, mint)`, so replaying twenty-three of them
      // exercises one code path twenty-three times at 1.7s of Neon round trips
      // each; these three cover the shapes that differ -- `velacorta` closes and
      // reopens the same position three times (spec §4.8), `ecolejano` spans
      // three positions over two days with the unpriced block among them, and
      // `hilofino` has open positions that derive no daily rows at all. Widen
      // the LIKE to `preview-%` if a future roster grows a shape these three
      // miss.
      const before = await derived();
      const replayed = await query<{ count: string }>(
        `UPDATE position SET dirty = TRUE
          WHERE kol_id IN (SELECT id FROM kol
                            WHERE slug IN ('preview-velacorta', 'preview-ecolejano',
                                           'preview-hilofino'))
      RETURNING 1 AS count`,
      );
      expect(replayed).toHaveLength(6);
      expect(await recomputeDirty()).toBe(6);
      expect(await derived()).toEqual(before);
    },
    REPLAY_BUDGET_MS,
  );
});

/**
 * The other half of the expiry fix: a roster that has gone stale replaces
 * itself instead of blocking every future run.
 *
 * **Why the old guard was not enough, stated once.** `writeRoster` refused to
 * run whenever any `preview-` KOL existed, which is what made it idempotent —
 * and also what made a fixture that expired at midnight unable to heal. The
 * roster seeded on 2026-08-27 was still there on the 28th, still the newest
 * thing the check could see, and `npm run db:seed:preview` kept answering
 * "already present" over an empty `Diario`.
 *
 * So both halves are pinned here, in the order they matter: the run that must
 * still do nothing, and the run that must now replace. Neither needs a replay —
 * this is about which rows exist, and `recomputeDirty` is the most expensive
 * thing in this file.
 */
describe("a stale roster replaces itself rather than expiring in place", () => {
  const countsOf = () =>
    query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM kol WHERE slug LIKE 'preview-%') AS kols,
              (SELECT count(*) FROM kol)                             AS all_kols,
              (SELECT count(*) FROM kol_wallet)                      AS wallets,
              (SELECT count(*) FROM token)                           AS tokens,
              (SELECT count(*) FROM trade)                           AS trades,
              (SELECT count(*) FROM position)                        AS positions,
              (SELECT count(*) FROM cabal)                           AS cabals`,
    );

  beforeAll(async () => {
    await query(`TRUNCATE ${SEEDED_TABLES}`);
    const first = await withTransaction(writeRoster);
    expect(first).toMatchObject({ seeded: true, replaced: false });
  });

  it("does nothing at all while the roster's newest trade is on the current UTC day", async () => {
    const before = await countsOf();

    const second = await withTransaction(writeRoster);

    // The property that must not be lost to the new branch: running the seed
    // twice in a row still leaves one roster, not two.
    expect(second).toMatchObject({ seeded: false, replaced: false });
    expect(second.counts.trades).toBe(0);
    expect(await countsOf()).toEqual(before);
  });

  it("replaces its own rows and re-seeds once the newest trade is no longer today", async () => {
    const before = await countsOf();
    const staleMints = await query<{ mint: string }>("SELECT mint FROM token ORDER BY mint");
    expect(staleMints).toHaveLength(6);

    // Exactly what one midnight does to this fixture: the rows do not change,
    // the calendar moves under them. Two days rather than one so the assertion
    // holds whatever hour the suite runs at.
    await query("UPDATE trade SET block_time = block_time - INTERVAL '2 days'");

    const again = await withTransaction(writeRoster);

    expect(again).toMatchObject({ seeded: true, replaced: true });
    expect(again.counts.trades).toBe(ROSTER_TRADES);
    expect(again.counts.positions).toBe(ROSTER_POSITIONS);

    // One roster, not two: every count is where it started, so the replacement
    // deleted as much as it wrote.
    expect(await countsOf()).toEqual(before);

    // The stale roster's tokens went with it -- they were orphaned by the
    // deletion and nothing else points at them -- and six fresh mints took
    // their place.
    const freshMints = await query<{ mint: string }>("SELECT mint FROM token ORDER BY mint");
    expect(freshMints).toHaveLength(6);
    expect(freshMints.map((row) => row.mint).sort()).not.toEqual(
      staleMints.map((row) => row.mint).sort(),
    );

    // And the replacement is current: `Diario` has trades in it again, which is
    // the whole point of the branch.
    const [{ today }] = await query<{ today: string }>(
      `SELECT count(*)::text AS today FROM trade
        WHERE block_time >= date_trunc('day', now() AT TIME ZONE 'utc')`,
    );
    expect(Number(today)).toBeGreaterThan(0);
  });

  it("leaves nothing derived behind for a recompute to disagree with", async () => {
    // The deletion has to take `pnl_daily` and `pnl_position_daily` with it.
    // Rows left there would belong to KOLs that no longer exist, and
    // `assertReconciled` would be comparing a new roster against an old day.
    const [orphans] = await query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM pnl_daily d
                LEFT JOIN kol k ON k.id = d.kol_id WHERE k.id IS NULL)          AS days,
              (SELECT count(*) FROM pnl_position_daily c
                LEFT JOIN kol k ON k.id = c.kol_id WHERE k.id IS NULL)          AS position_days,
              (SELECT count(*) FROM trade t
                LEFT JOIN kol k ON k.id = t.kol_id WHERE k.id IS NULL)          AS trades,
              (SELECT count(*) FROM kol_wallet w
                LEFT JOIN kol k ON k.id = w.kol_id WHERE k.id IS NULL)          AS wallets`,
    );
    expect(orphans).toEqual({ days: "0", position_days: "0", trades: "0", wallets: "0" });

    // Cabals are shared with whatever else is on the branch and are never
    // deleted -- the three the roster needs are still there, and still three.
    const [{ cabals }] = await query<{ cabals: string }>("SELECT count(*)::text AS cabals FROM cabal");
    expect(cabals).toBe("3");
  });
});

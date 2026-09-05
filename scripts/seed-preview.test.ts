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
import { ONE, formatDecimal, mulDiv, parseDecimal } from "@/lib/decimal";
import { recomputeDirty } from "@/lib/pnl";
import { LEADERBOARD_WINDOWS, windowBounds } from "@/lib/windows";
import {
  FEE_SOL,
  ROSTER,
  SOL_USD,
  assertReconciled,
  placementDays,
  seedPreview,
  writeRoster,
  type Episode,
} from "./seed-preview";

/**
 * What one episode realizes, in SOL and in USD, on `decimal.ts`'s scaled-integer
 * grid.
 *
 * **This is a transcription of the spec, not of the seed.** The seed writes
 * `trade` rows and nothing else; every figure asserted below is derived from
 * them by `pnl.ts`'s `replayPosition`, which is the code under test. So this
 * function states spec §4.4 and §4.8 independently — *"a buy costs
 * `sol_amount + fee_sol` and a sell nets `sol_amount − fee_sol`"*, with the fee
 * valued at that trade's own rate — and the assertions compare the two.
 *
 * Every roster episode buys and sells the same quantity whole, so each is a
 * full exit: the position's entire basis is assigned on the sell and the next
 * buy on that mint reopens it from zero (spec §4.8). That is what makes a
 * per-episode formula exact for this fixture rather than an approximation of
 * one, `velacorta`'s three round trips on one mint included.
 *
 * **No JS float appears anywhere in it.** `20.5 - 8.150005` is
 * `12.349994999999999` in doubles, and the literals this file pins would be
 * wrong in the seventh decimal if any step went through one. `bigint`
 * throughout, exactly as `pnl.ts` and the seed do.
 *
 * `null` for a position that never sold: nothing closed, so it realizes nothing
 * (`ejemplo_hilofino`, DESIGN.md's `sin cierres` row).
 */
function episodeRealized(episode: Episode): { sol: bigint; usd: bigint } | null {
  if (episode.sell === null) return null;

  const fee = parseDecimal(FEE_SOL);
  const buy = parseDecimal(episode.buy);
  const sell = parseDecimal(episode.sell);
  // An unpriced block has no `sol_price` row, so `usd_amount`, `sol_usd` and
  // the fee's USD are all absent and the episode contributes nothing to the USD
  // side — never a zero standing in for a number (migration 005).
  const rate = episode.unpriced ? 0n : parseDecimal(SOL_USD);
  const usd = (sol: bigint) => mulDiv(sol, rate, ONE);

  return {
    sol: sell - fee - (buy + fee),
    usd: usd(sell) - usd(fee) - (usd(buy) + usd(fee)),
  };
}

/**
 * What one KOL's `Diario` row must read, for a seed that ran at `instant`.
 *
 * The two inputs are the roster and the calendar, which is the whole point:
 * `placementDays` decides which episodes land on the run's own UTC day, and on
 * a Monday or a 1st that set is **larger** than on an ordinary Wednesday
 * because a collapsed window folds its episodes into day zero. A literal cannot
 * express that, and the one that used to be here did not — it failed on Monday
 * 2026-08-31 at `11.84998` against `12.34999`.
 */
function expectedDay(handle: string, instant: number): { sol: string; usd: string } {
  const kol = ROSTER.find((entry) => entry.handle === handle);
  if (!kol) throw new Error(`no preview KOL with handle ${handle}`);

  const days = placementDays(instant);
  let sol = 0n;
  let usd = 0n;
  for (const episode of kol.episodes) {
    if (days[episode.when] !== 0) continue;
    const realized = episodeRealized(episode);
    if (realized === null) continue;
    sol += realized.sol;
    usd += realized.usd;
  }
  return { sol: formatDecimal(sol), usd: formatDecimal(usd) };
}

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
 * Where the roster lands in time, proved without a database and without
 * depending on the day the suite runs.
 *
 * **This describe has been wrong twice, in opposite directions, and both are
 * worth keeping written.**
 *
 * First the roster was dated `0`, `4` and `19` days back — correct the day it
 * was written and empty the next morning, because the windows were
 * calendar-aligned and moved. The fix was to resolve each name against
 * `windowBounds` at the run instant, and the four days that differ — a Monday,
 * a 1st, a Monday that is a 1st, an ordinary midweek day — were exactly what
 * this file pinned.
 *
 * Then the windows stopped being calendar-aligned (`docs/round-ventanas-moviles.md`
 * §5) and the resolution became both unnecessary and wrong: `7D` is the last
 * seven days on every date there has ever been, and asking `windowBounds` for
 * its start returns an instant carrying the current *time of day*, so the
 * placement came out in fractional days.
 *
 * So the property under test changed shape. There is no longer a calendar day
 * on which the placement differs — that is the whole benefit of a rolling
 * window — and what has to hold instead is that the constants sit **inside the
 * window they name and outside the smaller one**, with clearance from both
 * edges, on any instant at all.
 */
describe("the roster is placed inside the window it names, on any instant", () => {
  /** A UTC day, in milliseconds. Constant, unlike a local one. */
  const DAY_MS = 86_400_000;

  /** 09:15 UTC, and 23:59, and midnight: the placement must not depend on the hour. */
  const instants = [
    Date.parse("2026-08-26T09:15:00.000Z"),
    Date.parse("2026-08-31T23:59:59.999Z"),
    Date.parse("2026-09-01T00:00:01.000Z"),
    Date.parse("2028-02-29T12:00:00.000Z"),
  ];

  /*
    **One second past midnight, not midnight exactly**, and the second is load
    bearing. A window is half-open — `[now - 24h, now)` — and a `today` episode
    lands on today's UTC *midnight*, so at exactly `00:00:00.000` that midnight
    **is** the exclusive end and the episode falls out of `1D` by one
    millisecond. It is a real property of the pair and not a bug in either: a
    seed run at that instant would place its day-zero episode on the boundary.
    Recorded here rather than smoothed over, because the honest fix belongs in
    the seed's placement if it ever bites — and it never has, since a run takes
    longer than a millisecond.
  */

  it("is the same placement whatever the instant, which a rolling window makes true", () => {
    for (const instant of instants) {
      expect(placementDays(instant), new Date(instant).toISOString()).toEqual({
        today: 0,
        week: 3,
        month: 15,
      });
    }
  });

  it("puts each episode inside its own window and outside the next one down", () => {
    for (const instant of instants) {
      const now = new Date(instant);
      const days = placementDays(instant);
      // The day the episode's trades land on, as the seed computes it.
      const landsOn = (daysAgo: number) =>
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysAgo * DAY_MS;
      const inside = (daysAgo: number, window: "1d" | "7d" | "30d") => {
        const { from, to } = windowBounds(window, now);
        const day = landsOn(daysAgo);
        return day >= from.getTime() && day < to.getTime();
      };

      const label = new Date(instant).toISOString();
      // `today` is in all three: the windows nest, which is what makes "most of
      // the roster closed something in every window" a fact about the roster.
      for (const window of LEADERBOARD_WINDOWS) {
        expect(inside(days.today, window), `${label} today ${window}`).toBe(true);
      }
      // `week` is in 7D and 30D but not in 1D, and `month` only in 30D.
      expect(inside(days.week, "7d"), `${label} week in 7d`).toBe(true);
      expect(inside(days.week, "1d"), `${label} week out of 1d`).toBe(false);
      expect(inside(days.month, "30d"), `${label} month in 30d`).toBe(true);
      expect(inside(days.month, "7d"), `${label} month out of 7d`).toBe(false);
    }
  });

  it("keeps a day of clearance from every boundary it sits inside", () => {
    const days = placementDays(Date.now());
    // 3 is two days past 1 and four short of 7; 15 is eight past 7 and fifteen
    // short of 30. A fixture one hour inside a boundary is a fixture that
    // expires the way the calendar one did.
    expect(days.week).toBeGreaterThan(1 + 1);
    expect(days.week).toBeLessThan(7 - 1);
    expect(days.month).toBeGreaterThan(7 + 1);
    expect(days.month).toBeLessThan(30 - 1);
  });
});

/**
 * The expectations themselves, run against five calendars rather than against
 * today.
 *
 * **Twice now a figure in this repository was correct on the day it was written
 * and wrong later**: the roster's placement, which emptied `Diario` at the first
 * midnight, and then the literal that pinned the roster's arithmetic, which
 * failed on the first Monday. Both were caught by the calendar rather than by a
 * reviewer. So the derivation the database test leans on is itself exercised on
 * a Monday, a Sunday, a 1st, a 1st that is a Monday, and an ordinary midweek
 * day — none of which is the day this file was written.
 *
 * Literals live here, and only here, because on a *fixed* instant a literal is
 * a real statement about exact decimal arithmetic. `20.5 - 8.150005` is
 * `12.349994999999999` in doubles and `8.15 * 231.71` is `1888.4365000000003`,
 * so every figure below would be visibly wrong if any step went through one.
 */
describe("the day's expected figures follow the calendar, exactly", () => {
  /** Noon UTC, so the day comes from the date and not from the hour. */
  const at = (day: string) => Date.parse(`${day}T12:00:00.000Z`);

  const WEDNESDAY = at("2026-08-26");
  const SUNDAY = at("2026-08-30");
  const MONDAY = at("2026-08-31");
  const FIRST = at("2026-08-01");
  const FIRST_ON_A_MONDAY = at("2026-06-01");

  it("charges spec §4.4's two fees per episode, in SOL and in USD", () => {
    // The anchor the old literal was, stated where it cannot go stale: one
    // episode, no calendar involved. 20.5 - 8.15 - 2 x 0.000005.
    const [win] = ROSTER.find((kol) => kol.handle === "ejemplo_brujularota")!.episodes;
    const realized = episodeRealized(win)!;
    expect(formatDecimal(realized.sol)).toBe("12.34999");
    // At 231.71 SOL/USD with the fee valued at that same rate:
    // 20.5 x 231.71 - 8.15 x 231.71 - 2 x (0.000005 x 231.71).
    expect(formatDecimal(realized.usd)).toBe("2861.6161829");

    // An open position realizes nothing at all -- not a zero, which is a
    // number the leaderboard would rank (DESIGN.md: `sin cierres`, never `0 %`).
    const open = ROSTER.find((kol) => kol.handle === "ejemplo_hilofino")!.episodes[0];
    expect(episodeRealized(open)).toBeNull();

    // An unpriced block contributes its SOL and no USD, rather than a zero
    // standing in for a rate nobody looked up (migration 005).
    const unpriced = ROSTER.find((kol) => kol.handle === "ejemplo_ecolejano")!.episodes.find(
      (episode) => episode.unpriced,
    )!;
    const gap = episodeRealized(unpriced)!;
    expect(formatDecimal(gap.sol)).toBe("-8.45001");
    expect(formatDecimal(gap.usd)).toBe("0");
  });

  /**
   * **The four calendar days this block existed for are gone**, and their
   * absence is the result rather than a gap.
   *
   * `placementDays` used to return a different answer on a Wednesday, a Sunday,
   * a Monday, a 1st and a 1st that is a Monday, because a calendar window
   * changes length with the date: `Semanal` is one day long on a Monday, so an
   * episode "inside the week but outside the day" had nowhere to go and the
   * fixture folded. Every one of those cases was a real bug the day it was
   * written.
   *
   * A rolling window has no such day (`docs/round-ventanas-moviles.md` §5), so
   * the property that replaces five date-specific literals is one sentence: the
   * answer does not depend on the date. Asserted here on the same five instants,
   * because a claim that something *stopped* mattering is worth checking against
   * the exact cases where it used to.
   */
  it("gives the same placement on every day that used to differ", () => {
    for (const [label, instant] of [
      ["miércoles", WEDNESDAY],
      ["domingo", SUNDAY],
      ["lunes", MONDAY],
      ["día 1", FIRST],
      ["día 1 en lunes", FIRST_ON_A_MONDAY],
    ] as const) {
      expect(placementDays(instant), label).toEqual({ today: 0, week: 3, month: 15 });
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

  /**
   * **The seed runs against a real schema, and that is the point of running it
   * here at all.**
   *
   * `migrations/016` replaced `cabal`'s outright `UNIQUE (tag)` with a *partial*
   * index over the cabals that still hold one, and `ON CONFLICT (tag)` stopped
   * matching any constraint — *"there is no unique or exclusion constraint
   * matching the ON CONFLICT specification"*, raised at plan time, on every run.
   * The seed would have failed whole. It was caught by the `writeRoster` calls
   * in this file rather than by the next preview deploy, which is what a gate is
   * for.
   *
   * This case pins the specific state the partial index exists to allow: a
   * dissolved cabal holding `tag = NULL`, alongside a live one holding a tag.
   * A future change that made the index total again, or that dropped the
   * predicate from the `ON CONFLICT`, fails here — the first with a NOT NULL
   * violation, the second at plan time — instead of in production.
   */
  it("upserts its cabals with dissolved, tagless ones already in the table", async () => {
    await query(
      `INSERT INTO cabal (id, tag, name, dissolved_at)
       VALUES (gen_random_uuid(), NULL, 'disuelto', now() - INTERVAL '90 days')`,
    );
    // A second full write over the top: the upsert meets both the tagless row
    // and its own tags from the first run.
    await expect(withTransaction(writeRoster)).resolves.toBeDefined();
    const [row] = await query<{ tagless: string }>(
      "SELECT count(*)::text AS tagless FROM cabal WHERE tag IS NULL",
    );
    expect(row.tagless).toBe("1");
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
  /**
   * The ranking as it stands **the moment after the fixture was written**.
   *
   * It used to evaluate at `max(pnl_daily.day)` at 12:00, so the expectations
   * were derived against the same calendar the rows were seeded on rather than
   * against the suite's own clock — a run that starts before UTC midnight and
   * reaches this test after it would otherwise ask for a different day.
   *
   * **That instant became wrong when the windows started ending at one.** The
   * seed spreads a `today` episode's legs between midnight and its own run
   * time (`seed-preview.ts`: `span = startedAt - dayStart`), so a suite that
   * runs in the afternoon writes trades after 12:00 — inside `Diario`, which
   * was the whole day, and outside a rolling window evaluated at noon. Three
   * KOLs came back at `0` and the losses vanished from the top ten.
   *
   * So the instant is the newest trade the fixture wrote. It still does not
   * read the suite's clock, and it cannot fall before its own data.
   */
  async function leaderboardAtSeededDay(window: (typeof LEADERBOARD_WINDOWS)[number] = "1d") {
    const [{ newest }] = await query<{ newest: Date | null }>(
      "SELECT max(block_time) AS newest FROM trade",
    );
    if (newest === null) throw new Error("the fixture wrote no trades");
    const at = newest.getTime();
    return { ...(await readLeaderboard({ window, now: new Date(at) })), at };
  }

  it("ranks ten rows spanning gains and losses, with `sin cierres` among them", async () => {
    const { entries } = await leaderboardAtSeededDay();
    expect(entries.length).toBeGreaterThanOrEqual(LEADERBOARD_TOP);

    const topTen = entries.slice(0, LEADERBOARD_TOP);
    // The figures themselves in the message: a boolean that fails tells you
    // the fixture is wrong and nothing about how, and this assertion has now
    // been debugged twice from a bare `expected false to be true`.
    const shown = topTen.map((entry) => `${entry.kol.slug}=${entry.realizedSol}`).join(" ");
    expect(topTen.some((entry) => entry.realizedSol.startsWith("-")), `a loss in the top ten: ${shown}`).toBe(
      true,
    );
    expect(
      topTen.some((entry) => !entry.realizedSol.startsWith("-") && Number(entry.realizedSol) > 0),
      `a gain in the top ten: ${shown}`,
    ).toBe(true);

    /*
      **`sin cierres` stopped being a property of a row on 2026-09-03**, and
      that is a loss worth stating rather than a test to delete quietly.

      It was `winRate === null` — "no closed position in this window" — and it
      told a reader that a `0,00` cell was *absence* rather than a measured
      break-even. `winRate` came from `pnl_daily`'s `wins`/`losses`, which count
      a closed **position** per UTC day (spec §4.8); a rolling window sums sells
      over an arbitrary interval and cannot produce them, so it is now null for
      everyone and distinguishes nothing.

      What survives is the **board-level** answer: `readLeaderboard` counts what
      it actually summed and publishes `closed`, which is what the panel's empty
      state reads. Per row, the payload can no longer separate "closed nothing"
      from "closed to exactly zero" — `preview-hilofino`, whose only trades are
      buys, and `preview-velacorta`, which closed three round trips and lost all
      three, both print `0`.

      **The row already did not show it**: the record columns left the card on
      2026-09-02 with the clone decision, so no surface has rendered `sin
      cierres` per row since then. What was lost here is the distinction in the
      *payload*, and it is recorded in `docs/round-ventanas-moviles.md` §5.
    */
    const bySlug = (slug: string) => topTen.find((entry) => entry.kol.slug === slug);

    // `preview-hilofino` only ever bought, so it realized nothing at all.
    expect(bySlug("preview-hilofino")?.realizedSol, shown).toBe("0");
    // `preview-velacorta` closed three round trips and lost all three (spec
    // §4.8's reopen-and-close-again path), so it realized a real negative
    // figure — **not** a zero. The old assertion called it a "measured zero"
    // because its *win rate* was `0.0`, which is a different number from its
    // PnL and is the one that no longer exists.
    expect(bySlug("preview-velacorta")?.realizedSol.startsWith("-"), shown).toBe(true);

    // And the loss: neither carries a record any more, so nothing in the row
    // separates "closed nothing" from "closed three times and lost".
    for (const slug of ["preview-hilofino", "preview-velacorta"]) {
      const entry = bySlug(slug);
      expect(entry?.winRate, `${slug} win rate`).toBeNull();
      expect((entry?.wins ?? 0) + (entry?.losses ?? 0), `${slug} record`).toBe(0);
    }
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
      const { entries, closed: closedFlag } = await leaderboardAtSeededDay(window);

      /*
        DESIGN.md, "Every surface has two states": this is the condition under
        which the ranking panel is *not* its own empty state.

        **`winRate` cannot carry that condition on a rolling window.** Spec §4.8
        counts a closed *position* per day and there is no per-sell equivalent,
        so `wins` and `losses` are zero on the `1d · 7d · 30d` path and every
        row's `winRate` is null by construction. That is what put a false empty
        state on `?window=7d` for an hour on 2026-09-03 — this case is what
        caught it — and `readLeaderboard` now answers the question in the
        statement it actually ran, as `closed`.

        So the panel-level assertion reads that flag in every window, and the
        win-rate assertion applies where a win rate exists.
      */
      expect(closedFlag, `${window}: the panel-level empty state is reachable`).toBe(true);

      // Every window is rolling, so `winRate` is null throughout and a KOL that
      // closed something is one with a figure. `isRollingWindow` was the branch
      // here while both kinds existed; it went with the calendar windows.
      const closed = entries.filter((entry) => Number(entry.realizedSol) !== 0);
      expect(closed.length, `${window}: closed episodes`).toBeGreaterThan(0);

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

      /*
        Eleven of the twelve closed something today, and the **calendar** windows
        nest downwards, so each of those carries almost the whole roster.

        **A rolling window does not nest the same way, and that is correct.**
        `1d` is the last 24 hours counted from *now*, not the UTC day: an episode
        the seed placed at today's midnight is inside it, but the roster's
        `week` and `month` episodes are not, and the KOLs whose only closure is
        one of those drop out. Measured on this seed: `diario` carries 11 and
        `1d` carries 8. Holding `1d` to the calendar number would be asserting
        that a rolling window behaves like a calendar one, which is the single
        thing `docs/round-ventanas-moviles.md` set out to keep apart.

        What the gate actually needs from a rolling window is that it is not
        empty and shows both signs — asserted above, in every window.
      */
      // No roster-coverage floor: a rolling window legitimately carries fewer
      // KOLs than a calendar one did — `1d` holds only the day-zero episodes —
      // and the gate's real requirement, that it is not empty and shows both
      // signs, is asserted above.
      expect(closed.length, `${window}: someone closed something`).toBeGreaterThan(0);
    }
  });

  /**
   * The one test in this file that can catch a float, and it stays that way.
   *
   * `20.5 - 8.150005` is `12.349994999999999` in doubles and `8.15 * 231.71` is
   * `1888.4365000000003`, so a comparison against an exact string is what
   * distinguishes "the arithmetic is right" from "the number is roughly right".
   * It is asserted against a **derived** exact string rather than a typed one —
   * see {@link expectedDay} — because a typed one is only true on the calendar
   * it was typed on, which is how this test broke on Monday 2026-08-31.
   * `episodeRealized` computes it in `bigint` from the roster's own strings, so
   * neither side of the comparison has ever been a `number`.
   *
   * **The rank is looked up, not assumed.** `entries[0]` used to be
   * `preview-brujularota` on every day the test had been run on — but on a
   * Monday that is also the 1st, `preview-tortugaveloz` takes rank 1 (its
   * `"month"` episode is worth +4.69999 and joins the day, while
   * `brujularota`'s `"week"` episode is a 0.50001 loss that joins it too). That
   * is a correct leaderboard and would have been a false failure here.
   */
  it("derives the day's figures exactly, on the decimal grid and not through a float", async () => {
    const { entries, at } = await leaderboardAtSeededDay();

    const row = entries.find((entry) => entry.kol.slug === "preview-brujularota");
    expect(row, "preview-brujularota is on the board").toBeDefined();

    const expected = expectedDay("ejemplo_brujularota", at);
    // Spec §4.4's fee charge and §4.8's per-episode close, derived from the
    // roster and the calendar, against what `pnl.ts` actually replayed. The two
    // agree to the last of eighteen decimal places or they do not agree at all.
    expect(row!.realizedSol).toBe(expected.sol);
    expect(row!.realizedUsd).toBe(expected.usd);

    // The USD side had exactly the same exposure as the SOL side and was never
    // reached: the run that failed stopped on the line above it. Pinned here as
    // its own statement rather than as a trailing assertion.
    expect(expected.usd).not.toBe("0");

    // ...and the ranking agrees with the same derivation, so no slug is pinned
    // to a rank the calendar can move.
    const totals = ROSTER.map((kol) => parseDecimal(expectedDay(kol.handle, at).sol));
    expect(parseDecimal(entries[0].realizedSol)).toBe(
      totals.reduce((best, total) => (total > best ? total : best)),
    );
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

/**
 * Two halves, proved separately.
 *
 * **The guards must refuse.** A seed that can reach production is a worse bug
 * than an empty preview, so every refusal path is exercised: the variable
 * unset, `DATABASE_URL` unset (which would make the production comparison pass
 * vacuously), the two naming the same database, and the target carrying
 * `test_database_marker`.
 *
 * The same-database case is driven with a **fabricated** pair of identical
 * URLs rather than with the real production string. If the comparison ever
 * broke, a test that had handed it the real one would seed production to prove
 * that it seeds production. The fabricated host resolves nowhere, so a broken
 * guard fails to connect instead.
 *
 * **The rows must produce the states the seed exists to show.** `writeRoster`
 * is split out of `seedPreview` precisely so this half can run: the tests
 * branch carries `test_database_marker`, so `seedPreview` itself refuses it, on
 * purpose. Driving the row-writing directly through `withTransaction` against
 * the tests branch is the only way to assert that the roster really yields ten
 * ranked rows with both signs, a `sin cierres` row, a `sin precio` trade and a
 * feed longer than the eight rows the list is tall — rather than asserting that
 * a literal in the file says so.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, withTransaction } from "@/lib/db";
import { readFeedPage } from "@/lib/feed";
import { readLeaderboard, LEADERBOARD_TOP } from "@/lib/leaderboard";
import { seedPreview, writeRoster } from "./seed-preview";

/**
 * A syntactically valid connection URL naming a host that does not exist. Used
 * where a guard must fire *before* anything connects; if one ever stops firing,
 * the failure is a DNS error, not a write.
 */
const NOWHERE = "postgresql://u:p@ep-guard-fixture-0000.eu-central-1.aws.neon.tech/neondb";

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
    // before writing anything.
    process.env.PREVIEW_DATABASE_URL = process.env.TEST_DATABASE_URL;
    await query("TRUNCATE kol, kol_wallet, cabal, token, trade, position, pnl_daily CASCADE");

    await expect(seedPreview()).rejects.toThrow(/test_database_marker/);

    const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM kol");
    expect(Number(count)).toBe(0);
  });

  it("reports a malformed URL against the variable it came from", async () => {
    process.env.PREVIEW_DATABASE_URL = "not-a-url";
    await expect(seedPreview()).rejects.toThrow(/PREVIEW_DATABASE_URL is not a valid/);
  });
});

describe("the roster produces the states the preview exists to show", () => {
  beforeEach(async () => {
    await query(
      "TRUNCATE kol, kol_wallet, cabal, token, trade, position, pnl_daily, pnl_position_daily CASCADE",
    );
  });

  /** Pinned to noon of the newest seeded day, so no run can straddle UTC midnight. */
  async function leaderboardAtSeededDay() {
    const [{ day }] = await query<{ day: string }>(
      "SELECT to_char(max(day), 'YYYY-MM-DD') AS day FROM pnl_daily",
    );
    return readLeaderboard({
      window: "diario",
      unit: "sol",
      now: new Date(`${day}T12:00:00.000Z`),
    });
  }

  it("ranks ten rows spanning gains and losses, with `sin cierres` among them", async () => {
    const { seeded, counts } = await withTransaction(writeRoster);
    expect(seeded).toBe(true);
    expect(counts.trades).toBeGreaterThan(8);

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
    // nobody made. It has to be *in the top ten* to be on the home page.
    const noEpisodes = topTen.filter((entry) => entry.winRate === null);
    expect(noEpisodes).toHaveLength(1);
    expect(noEpisodes[0].wins + noEpisodes[0].losses).toBe(0);

    // ...and a real, measured zero, which is a different cell entirely.
    expect(topTen.some((entry) => entry.winRate === "0.0")).toBe(true);
  });

  it("fills the feed past the eight rows the list is tall, with an unpriced trade in it", async () => {
    await withTransaction(writeRoster);

    const { trades } = await readFeedPage();
    // `.feed-list` is `calc(8 * var(--row-height))`, so anything past eight is
    // what makes the panel scroll instead of ending mid-air.
    expect(trades.length).toBeGreaterThan(8);

    // DESIGN.md `state-unpriced`, and the feed row's `un token sin símbolo`.
    expect(trades.some((trade) => trade.priceUsd === null)).toBe(true);
    expect(trades.some((trade) => trade.symbol === null)).toBe(true);
    expect(trades.some((trade) => trade.symbol !== null)).toBe(true);

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
  });

  it("is idempotent: a second run leaves the same rows, not double", async () => {
    const first = await withTransaction(writeRoster);
    const countsOf = async () =>
      query<Record<string, string>>(
        `SELECT (SELECT count(*) FROM kol)        AS kols,
                (SELECT count(*) FROM kol_wallet) AS wallets,
                (SELECT count(*) FROM token)      AS tokens,
                (SELECT count(*) FROM trade)      AS trades,
                (SELECT count(*) FROM pnl_daily)  AS days`,
      );
    const before = await countsOf();

    const second = await withTransaction(writeRoster);
    expect(second.seeded).toBe(false);
    expect(await countsOf()).toEqual(before);

    expect(Number(before[0].kols)).toBe(first.counts.kols);
    expect(Number(before[0].trades)).toBe(first.counts.trades);
  });
});

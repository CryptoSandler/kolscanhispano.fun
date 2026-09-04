/**
 * The cabal ranking behind `/cabals`.
 *
 * `docs/clone-map.md` §6: the mould's richest surface, and one we did not have.
 * `cabal` has existed since `001_core.sql` and `chip-cabal` has been on every
 * row since the leaderboard was built — the data was here, the page was not.
 *
 * **It reads the same column `leaderboard.ts` reads**, and derives nothing:
 * `trade.realized_sol`, written per sell by the replay (`migrations/015`). It
 * summed `pnl_daily` until 2026-09-03, when every window became rolling — and
 * the two are the same arithmetic, which is what keeps a cabal's total and the
 * sum of its members' rows from disagreeing. Spec §4.5's exclusion lives in the
 * replay that writes the column, so it is not restated in either query.
 *
 * Three things about the shape of this query are load-bearing:
 *
 * - **`INNER JOIN kol`, not `LEFT`.** The leaderboard keeps a KOL who did not
 *   trade because *"inactive approved KOLs stay in the list at zero — the
 *   roster is part of the point"* (spec §2). A cabal is not a roster entry; it
 *   is a group **of** roster entries, and a cabal whose every member was
 *   rejected or suspended is not a competitor with nothing to show, it is not
 *   in the competition. A cabal with approved members who did not trade still
 *   appears, at zero.
 * - **`k.status = 'approved'` is inside the join**, so a suspended KOL cannot
 *   contribute their PnL to a cabal's total from behind a filter that runs
 *   afterwards — spec §9, the same rule the leaderboard applies.
 * - **The member count counts the same rows the sum does.** `count(DISTINCT
 *   k.id)` rather than `count(*)`: the join multiplies each KOL by the number of
 *   *sells* they made in the window, so `count(*)` would report a cabal of three
 *   as a cabal of hundreds on `30D` — a worse version of the same error the
 *   `pnl_daily` join produced by the day.
 */
import { query } from "./db";
import { windowBounds, type LeaderboardWindow } from "./windows";

/** One cabal, ranked, as a surface may read it. */
export type PublicCabal = {
  rank: number;
  tag: string;
  name: string;
  members: number;
  realizedSol: string;
  realizedUsd: string;
  /**
   * Closed positions in the window, summed over the cabal's members. The page
   * never prints it: it is the discriminator for DESIGN.md's *"no zeroed
   * rows"*, read the way `leaderboard.ts` reads `winRate === null` — a board
   * where nothing closed anywhere is a board that measures nothing, and it says
   * so in words rather than showing every cabal at zero.
   */
  closed: number;
};

type CabalRow = {
  tag: string;
  name: string;
  members: number;
  realized_sol: string;
  realized_usd: string;
  closed: number;
};

/*
  **It sums `trade` since 2026-09-03, not `pnl_daily`**, because every window on
  this site is rolling now and a day bucket cannot be cut at an arbitrary hour.
  `migrations/015` put the realized figure on the sell that produced it, which is
  what made this possible — and it is the *same column* `leaderboard.ts` sums, so
  a cabal's total and the sum of its members' rows cannot disagree.

  `closed` counts contributing sells rather than closed positions. Spec §4.8
  counts a closed position per day and there is no per-sell equivalent; what this
  column is for is the board's empty state — "did anything close here" — and a
  count of sells answers exactly that question. It is not published as a record.
*/
const SELECT = `
  SELECT c.tag, c.name,
         count(DISTINCT k.id)::int        AS members,
         COALESCE(SUM(t.realized_sol), 0) AS realized_sol,
         COALESCE(SUM(t.realized_usd), 0) AS realized_usd,
         count(t.id)::int                 AS closed
    FROM cabal c
    JOIN kol k ON k.cabal_id = c.id AND k.status = 'approved'
    LEFT JOIN trade t
           ON t.kol_id = k.id
          AND t.realized_sol IS NOT NULL
          AND t.block_time >= $1::timestamptz AND t.block_time < $2::timestamptz
   GROUP BY c.id, c.tag, c.name
   ORDER BY COALESCE(SUM(t.realized_sol), 0) DESC, c.tag ASC`;

export type CabalRanking = {
  window: LeaderboardWindow;
  from: string;
  to: string;
  entries: PublicCabal[];
};

/**
 * `c.tag` breaks the tie, the way `k.slug` does on the leaderboard: without it
 * Postgres may return two cabals on the same total in either order, and a
 * ranking that reshuffles equal rows between two loads looks like data moving
 * when nothing has.
 *
 * No `logo_url` is selected, and that is exception (a) rather than an omission.
 * `cabal.logo_url` holds a URL somebody typed; rendering it would put a third
 * party in every visitor's request path, which is the same objection spec §6
 * makes to hotlinking a KOL's avatar. The page draws a monogram from the name,
 * which is what `/api/avatar` falls back to anyway.
 */
export async function readCabals(options: {
  window: LeaderboardWindow;
  now?: Date;
}): Promise<CabalRanking> {
  const bounds = windowBounds(options.window, options.now ?? new Date());
  // ISO instants, not day strings: the bounds are `timestamptz` now, and
  // truncating them to a day is the one thing that turns `1D` back into the
  // calendar window it replaced.
  const rows = await query<CabalRow>(SELECT, [
    bounds.from.toISOString(),
    bounds.to.toISOString(),
  ]);

  return {
    window: options.window,
    from: bounds.from.toISOString(),
    to: bounds.to.toISOString(),
    entries: rows.map((row, index) => ({
      rank: index + 1,
      tag: row.tag,
      name: row.name,
      members: row.members,
      realizedSol: row.realized_sol,
      realizedUsd: row.realized_usd,
      closed: row.closed,
    })),
  };
}

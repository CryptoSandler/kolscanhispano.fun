/**
 * The leaderboard query, shared by the page's first render and by
 * `/api/leaderboard` so both apply the same filters — the same split
 * `feed.ts` makes, and for the same reason: a page that fetched its own HTTP
 * endpoint would pay a round trip to be told something it already knows, and
 * two copies of the filter would eventually disagree.
 *
 * **It reads `pnl_daily`, and derives nothing.** `pnl_daily` is already the
 * sum of `pnl_position_daily` over a KOL's mints for a day (spec §3), and
 * `pnl.ts` withholds the contribution of any position whose basis is unknown
 * before it ever reaches that table (spec §4.5). Re-deriving either here would
 * mean replaying every trade of every KOL on every page load, and would put a
 * second, drifting copy of §4.5's exclusion rule in a query.
 *
 * **What the USD column is worth.** Spec §4.1 fixes the USD value of a trade
 * at its block time and never re-prices, so USD is derived where SOL is
 * measured. A trade whose block was not covered by a `sol_price` row has a
 * NULL `usd_amount` and contributes nothing to the USD side — but a later,
 * priced sell of that same position still gives up its share of the cost. The
 * USD figure is therefore **overstated** for any KOL who traded through a gap
 * in `sol_price`, in a way the SOL figure is not. That is a property of the
 * data, not something this module can repair, so the page states it in words
 * whenever USD is the selected unit rather than printing the number bare.
 */
import { query } from "./db";
import { serializeLeaderboardEntry, type LeaderboardRow, type PublicLeaderboardEntry } from "./serialize";
import { utcDayString, windowBounds, type LeaderboardWindow } from "./windows";

/** Spec §2: `SOL / USD`. SOL is the truth and therefore the default (§4.1). */
export const LEADERBOARD_UNITS = ["sol", "usd"] as const;

export type LeaderboardUnit = (typeof LEADERBOARD_UNITS)[number];

/**
 * DESIGN.md's thesis, as a number: ten leaderboard rows and eight feed rows
 * share one 900px viewport. This is how many the home page shows.
 */
export const LEADERBOARD_TOP = 10;

/**
 * `LEFT JOIN`, deliberately.
 *
 * Spec §2: *inactive approved KOLs stay in the list at zero — the roster is
 * part of the point*. An inner join would drop a curated KOL from the ranking
 * on any day they did not close a position, which reads as a KOL who was
 * removed rather than one who did not trade.
 *
 * `k.status = 'approved'` is the public-surface filter from spec §9, in the
 * query rather than after it: a suspended KOL must not be able to occupy a
 * rank or a `LIMIT` slot on the way to being filtered out.
 *
 * The day comparison is half-open — `>= from`, `< to` — against `date`
 * literals built by {@link utcDayString}. Passing a `Date` here instead would
 * have `pg` send a timestamp for Postgres to cast using the *session* time
 * zone, which is the local-time leak `windows.ts` exists to prevent, one layer
 * further down.
 */
/**
 * The wallet count is a **scalar subquery, not a join**, and that is load-bearing.
 *
 * This statement already `LEFT JOIN`s `pnl_daily` and sums it. Adding
 * `LEFT JOIN kol_wallet` would multiply every one of those rows by the number
 * of wallets the KOL has, so a KOL with three wallets would rank on three times
 * their realized PnL -- silently, with every figure still looking like a
 * figure. A correlated subquery on `k.id` produces one value per group and
 * cannot fan anything out.
 */
const PUBLIC_WALLETS = `
  (SELECT count(*)::int FROM kol_wallet w
    WHERE w.kol_id = k.id AND w.status = 'active' AND w.is_public)`;

const SELECT = `
  SELECT k.id AS kol_id, k.slug, k.display_name, k.x_handle, k.hide_wallets, c.tag AS cabal_tag,
         ${PUBLIC_WALLETS} AS public_wallets,
         COALESCE(SUM(d.realized_sol), 0) AS realized_sol,
         COALESCE(SUM(d.realized_usd), 0) AS realized_usd,
         COALESCE(SUM(d.wins), 0)::int    AS wins,
         COALESCE(SUM(d.losses), 0)::int  AS losses
    FROM kol k
    LEFT JOIN cabal c ON c.id = k.cabal_id
    LEFT JOIN pnl_daily d
           ON d.kol_id = k.id AND d.day >= $1::date AND d.day < $2::date
   WHERE k.status = 'approved'
   GROUP BY k.id, k.slug, k.display_name, k.x_handle, k.hide_wallets, c.tag
   ORDER BY`;

/**
 * One finished statement per unit, not one template with the column spliced
 * in. The unit reaches this module from a query string; even though
 * {@link parseUnit} has already narrowed it to two literals, a whitelist that
 * is *the SQL itself* cannot be defeated by a later edit that widens the
 * parser.
 *
 * `k.slug` breaks the tie. Without it Postgres may return two KOLs on the same
 * total in either order, and a leaderboard that reshuffles equal rows between
 * two loads looks like data moving when nothing has.
 */
const ORDERED: Record<LeaderboardUnit, string> = {
  sol: `${SELECT} COALESCE(SUM(d.realized_sol), 0) DESC, k.slug ASC`,
  usd: `${SELECT} COALESCE(SUM(d.realized_usd), 0) DESC, k.slug ASC`,
};

export type LeaderboardQuery = {
  window: LeaderboardWindow;
  unit: LeaderboardUnit;
  /** Ranks are assigned before the cut, so the top ten are the top ten. */
  limit?: number;
  /** Injectable so a caller can pin the window; defaults to the current instant. */
  now?: Date;
};

export type Leaderboard = {
  window: LeaderboardWindow;
  unit: LeaderboardUnit;
  /** The window actually applied, so the page and the API agree on what was summed. */
  from: string;
  to: string;
  entries: PublicLeaderboardEntry[];
};

export async function readLeaderboard(options: LeaderboardQuery): Promise<Leaderboard> {
  const bounds = windowBounds(options.window, options.now ?? new Date());
  const from = utcDayString(bounds.from);
  const to = utcDayString(bounds.to);

  const limit = options.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a non-negative integer");
  }

  const sql = limit === undefined ? ORDERED[options.unit] : `${ORDERED[options.unit]} LIMIT $3`;
  const rows = await query<LeaderboardRow>(
    sql,
    limit === undefined ? [from, to] : [from, to, limit],
  );

  return {
    window: options.window,
    unit: options.unit,
    from: bounds.from.toISOString(),
    to: bounds.to.toISOString(),
    entries: rows.map((row, index) => serializeLeaderboardEntry(row, index + 1)),
  };
}

/**
 * The `unit` query parameter. Absent takes the default; anything that is not
 * one of the two is rejected rather than silently ranked in SOL — a caller
 * asking for `?unit=eur` should learn that it does not exist, not read a SOL
 * ranking labelled however they like.
 */
export function parseUnit(raw: string | null): LeaderboardUnit | null {
  if (raw === null) return "sol";
  return (LEADERBOARD_UNITS as readonly string[]).includes(raw) ? (raw as LeaderboardUnit) : null;
}
